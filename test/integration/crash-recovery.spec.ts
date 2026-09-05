import type { SQSClient } from '@aws-sdk/client-sqs';
import { ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import type { SQL } from 'bun';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PublishOutboxMessageUseCase } from '@/application/use-cases/publish-outbox-message';
import { SystemClock } from '@/infrastructure/adapters';
import { SqsEventPublisher } from '@/infrastructure/messaging/sqs-event-publisher';
import { MikroOutboxClaimRepository } from '@/infrastructure/persistence/outbox-claim.repository';
import { CONSUMER_NAME } from '@/interface/sqs/envelope';
import { WagerConsumerWorker } from '@/interface/sqs/wager-consumer.worker';
import { JsonLogger, type LogFields, type LogLevel } from '@/infrastructure/observability/json-logger';
import {
  MIGRATOR_URL,
  connect,
  expectWalletsMatchLedger,
  uniqueSuffix,
} from './support/database';
import {
  DLQ_QUEUE,
  EVENTS_QUEUE,
  INPUT_QUEUE,
  drainQueue,
  queueUrl,
  receiveMessages,
  sendRaw,
  sqsClient,
} from './support/sqs';
import { bootUseCases, type UseCases } from './support/use-cases';

const CRASH_TIMEOUT_MS = 60_000;
const LEASE_MS = 30_000;
const SEND_TIMEOUT_MS = 10_000;

setDefaultTimeout(CRASH_TIMEOUT_MS);

let app: UseCases;
let sql: SQL;
let sqs: SQSClient;
let inputUrl: string;
let eventsUrl: string;
let worker: WagerConsumerWorker;
let logger: CapturingLogger;

class CapturingLogger extends JsonLogger {
  readonly lines: Array<{ level: LogLevel; message: string; fields: LogFields }> = [];

  constructor() {
    super({});
  }

  override write(level: LogLevel, message: string, fields: LogFields = {}): void {
    this.lines.push({ level, message, fields });
  }
}

beforeAll(async () => {
  app = await bootUseCases();
  sql = connect(MIGRATOR_URL);
  sqs = sqsClient();
  inputUrl = await queueUrl(sqs, INPUT_QUEUE);
  eventsUrl = await queueUrl(sqs, EVENTS_QUEUE);

  logger = new CapturingLogger();
  worker = new WagerConsumerWorker(sqs, app.consumeWagerMessage, logger, {
    enabled: true,
    consumerName: CONSUMER_NAME,
    inputQueue: INPUT_QUEUE,
    dlqQueue: DLQ_QUEUE,
    batchSize: 10,
    waitTimeSeconds: 1,
    inFlightGraceMs: 1_000,
    visibilityTimeoutSeconds: 60,
    shutdownWindowMs: 2_000,
  });
}, CRASH_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
  await sql.end();
  sqs.destroy();
}, CRASH_TIMEOUT_MS);

beforeEach(async () => {
  logger.lines.length = 0;
  await drainQueue(sqs, inputUrl);
  await drainQueue(sqs, eventsUrl);
  await sql`DELETE FROM outbox_message`;
}, CRASH_TIMEOUT_MS);

const touched: string[] = [];

afterEach(async () => {
  await expectWalletsMatchLedger(sql, touched.splice(0));
});

async function openWallet(): Promise<{ id: string; playerId: string }> {
  const playerId = `player-${uniqueSuffix()}`;
  const wallet = await app.createWallet.execute({
    playerId,
    initialBalance: { amount: '1000.00', currency: 'BRL' },
    correlationId: `correlation-${uniqueSuffix()}`,
  });
  touched.push(wallet.id);
  return { id: wallet.id, playerId };
}

function envelopeFor(wallet: { id: string; playerId: string }, messageId: string): string {
  const suffix = uniqueSuffix();
  return JSON.stringify({
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: '2026-07-29T15:00:00.000Z',
    data: {
      providerId: 'provider-a',
      externalTransactionId: `external-${suffix}`,
      idempotencyKey: `provider-a:external-${suffix}`,
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: `round-${suffix}`,
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    },
  });
}

interface CrashResult {
  readonly phase: string;
  readonly receiptHandle: string;
  readonly processedLog: {
    readonly level: LogLevel;
    readonly message: string;
    readonly fields: LogFields;
  } | null;
  readonly exitCode: number | null;
}

// A real process that commits and is killed before DeleteMessage. The window is
// only deterministic if the script owns the kill, so the product keeps no seam.
async function consumeAndCrash(): Promise<CrashResult> {
  const receiptFile = join(tmpdir(), `crash-receipt-${uniqueSuffix()}`);

  const child = Bun.spawn(['bun', 'run', 'test/integration/support/crash-consumer.ts'], {
    env: { ...process.env, CRASH_RECEIPT_FILE: receiptFile },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const exitCode = await child.exited;

  const written = await Bun.file(receiptFile).text();
  await rm(receiptFile, { force: true });

  const checkpoint = JSON.parse(written) as Omit<CrashResult, 'exitCode'>;
  return { ...checkpoint, exitCode };
}

interface CrashState {
  readonly balance: string;
  readonly entries: number;
  readonly transaction_id: string;
  readonly inbox_processed: number;
  readonly outbox_created: number;
}

async function crashState(walletId: string, messageId: string): Promise<CrashState> {
  const rows = (await sql`
    WITH crashed_transaction AS (
      SELECT id FROM wager_transaction
      WHERE wallet_id = ${walletId}::uuid AND kind = 'BET'
      ORDER BY created_at DESC
      LIMIT 1
    )
    SELECT
      (SELECT balance::text FROM wallet WHERE id = ${walletId}::uuid) AS balance,
      (SELECT count(*)::int FROM wallet_ledger_entry
         WHERE wallet_id = ${walletId}::uuid) AS entries,
      (SELECT id::text FROM crashed_transaction) AS transaction_id,
      (SELECT count(*)::int FROM inbox_message
         WHERE consumer_name = ${CONSUMER_NAME}
           AND message_id = ${messageId}
           AND processed_at IS NOT NULL) AS inbox_processed,
      (SELECT count(*)::int FROM outbox_message o
         WHERE o.payload->'data'->>'transactionId' =
           (SELECT id::text FROM crashed_transaction)) AS outbox_created
  `) as CrashState[];

  const row = rows[0];
  if (row === undefined) {
    throw new Error(`wallet ${walletId} não existe`);
  }
  return row;
}

async function pendingOutboxCount(): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS total FROM outbox_message WHERE published_at IS NULL
  `) as { total: number }[];
  return rows[0]?.total ?? 0;
}

describe('TST-034 worker morto depois do commit e antes do ack', () => {
  test('a redelivery é barrada pela inbox e o efeito financeiro continua único', async () => {
    const wallet = await openWallet();
    const messageId = `msg-${uniqueSuffix()}`;
    await sendRaw(sqs, inputUrl, envelopeFor(wallet, messageId), {
      groupId: wallet.id,
      deduplicationId: messageId,
    });

    const crashed = await consumeAndCrash();

    expect(crashed.phase).toBe('before-delete-message');
    expect(crashed.receiptHandle).not.toBe('');
    expect(crashed.processedLog).toMatchObject({
      level: 'info',
      message: 'message processed',
      fields: {
        messageId,
        brokerMessageId: expect.any(String),
        transactionId: expect.any(String),
        walletId: wallet.id,
        providerId: 'provider-a',
        status: 'PROCESSED',
        idempotentReplay: false,
      },
    });
    expect(crashed.exitCode).not.toBe(0);
    const committed = await crashState(wallet.id, messageId);
    expect(committed).toEqual({
      balance: '975.00',
      entries: 2,
      transaction_id: expect.any(String),
      inbox_processed: 1,
      outbox_created: 2,
    });

    // Standing in for the visibility timeout expiring, so the test does not wait
    // out the 60 s the queue is configured with.
    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: inputUrl,
        ReceiptHandle: crashed.receiptHandle,
        VisibilityTimeout: 0,
      }),
    );

    expect(await worker.pollOnce()).toBe(1);

    expect(logger.lines).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'message deduplicated',
        fields: expect.objectContaining({
          messageId,
          brokerMessageId: expect.any(String),
          walletId: wallet.id,
          providerId: 'provider-a',
        }),
      }),
    );
    expect(await crashState(wallet.id, messageId)).toEqual(committed);
    expect(await receiveMessages(sqs, inputUrl, 3)).toEqual([]);
  }, CRASH_TIMEOUT_MS);
});

describe('TST-028 recuperação depois do reinício', () => {
  test('outra instância publica a outbox pendente que o processo morto deixou', async () => {
    const wallet = await openWallet();
    const messageId = `msg-${uniqueSuffix()}`;
    await sendRaw(sqs, inputUrl, envelopeFor(wallet, messageId), {
      groupId: wallet.id,
      deduplicationId: messageId,
    });

    // Only the events the dead process is about to commit should remain pending;
    // the ones the wallet opening produced are not what this test is about.
    await sql`DELETE FROM outbox_message`;

    const crashed = await consumeAndCrash();
    expect(crashed.phase).toBe('before-delete-message');

    // The dead process committed the events and published none of them.
    expect(await pendingOutboxCount()).toBe(2);

    await sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: inputUrl,
        ReceiptHandle: crashed.receiptHandle,
        VisibilityTimeout: 0,
      }),
    );
    expect(await worker.pollOnce()).toBe(1);

    const publisher = new PublishOutboxMessageUseCase(
      new MikroOutboxClaimRepository(app.orm),
      new SqsEventPublisher(sqs, EVENTS_QUEUE, SEND_TIMEOUT_MS),
      new SystemClock(),
      { publisherId: 'instance-after-restart', leaseMs: LEASE_MS },
      Math.random,
    );

    expect(await publisher.run()).toBe('published');
    expect(await publisher.run()).toBe('published');
    expect(await publisher.run()).toBe('idle');

    expect(await pendingOutboxCount()).toBe(0);
    expect(await crashState(wallet.id, messageId)).toMatchObject({
      balance: '975.00',
      entries: 2,
      inbox_processed: 1,
      outbox_created: 2,
    });
    expect(await receiveMessages(sqs, eventsUrl, 3)).toHaveLength(2);
  }, CRASH_TIMEOUT_MS);
});
