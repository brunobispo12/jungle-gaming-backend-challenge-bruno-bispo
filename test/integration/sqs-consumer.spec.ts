import type { SQSClient } from '@aws-sdk/client-sqs';
import type { SQL } from 'bun';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from 'bun:test';

import type { UnitOfWork } from '@/application/ports';
import {
  ConsumeWagerMessageUseCase,
  type ConsumeOutcome,
} from '@/application/use-cases/consume-wager-message';
import type { SubmitWagerTransactionUseCase } from '@/application/use-cases/submit-wager-transaction';
import {
  JsonLogger,
  type LogFields,
  type LogLevel,
} from '@/infrastructure/observability/json-logger';
import { CONSUMER_NAME, parseWagerMessage } from '@/interface/sqs/envelope';
import { WagerConsumerWorker } from '@/interface/sqs/wager-consumer.worker';
import { MIGRATOR_URL, connect, uniqueSuffix } from './support/database';
import {
  DLQ_QUEUE,
  INPUT_QUEUE,
  drainQueue,
  queueUrl,
  receiveMessages,
  sendRaw,
  sqsClient,
} from './support/sqs';
import { bootUseCases, type UseCases } from './support/use-cases';

let app: UseCases;
let sql: SQL;
let sqs: SQSClient;
let inputUrl: string;
let dlqUrl: string;
let worker: WagerConsumerWorker;
let logger: CapturingLogger;

const SQS_TEST_TIMEOUT_MS = 15_000;

setDefaultTimeout(SQS_TEST_TIMEOUT_MS);

// Never settles: it stands for a message whose transaction outlives the grace.
class HangingConsume extends ConsumeWagerMessageUseCase {
  started = false;

  constructor() {
    super(
      {} as UnitOfWork,
      {} as SubmitWagerTransactionUseCase,
      { now: () => new Date() },
      () => false,
    );
  }

  override consume(): Promise<ConsumeOutcome> {
    this.started = true;
    return new Promise<ConsumeOutcome>(() => undefined);
  }
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error('condição não atingida dentro do tempo');
    }
    await Bun.sleep(10);
  }
}

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
  dlqUrl = await queueUrl(sqs, DLQ_QUEUE);
  logger = new CapturingLogger();
  worker = new WagerConsumerWorker(sqs, app.consumeWagerMessage, logger, {
    enabled: false,
    consumerName: CONSUMER_NAME,
    inputQueue: INPUT_QUEUE,
    dlqQueue: DLQ_QUEUE,
    batchSize: 10,
    waitTimeSeconds: 1,
    inFlightGraceMs: 25_000,
    shutdownWindowMs: 30_000,
  });
}, SQS_TEST_TIMEOUT_MS);

afterAll(async () => {
  await app.close();
  await sql.end();
  sqs.destroy();
}, SQS_TEST_TIMEOUT_MS);

beforeEach(async () => {
  logger.lines.length = 0;
  await drainQueue(sqs, inputUrl);
  await drainQueue(sqs, dlqUrl);
}, SQS_TEST_TIMEOUT_MS);

async function openWallet(balance: string): Promise<{ id: string; playerId: string }> {
  const playerId = `player-${uniqueSuffix()}`;
  const wallet = await app.createWallet.execute({
    playerId,
    initialBalance: { amount: balance, currency: 'BRL' },
    correlationId: `correlation-${uniqueSuffix()}`,
  });
  return { id: wallet.id, playerId };
}

function envelopeFor(
  wallet: { id: string; playerId: string },
  messageId: string,
  overrides: Record<string, unknown> = {},
): string {
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
      ...overrides,
    },
  });
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = (await sql`
    SELECT balance::text AS balance FROM wallet WHERE id = ${walletId}::uuid
  `) as { balance: string }[];
  return rows[0]?.balance ?? '';
}

async function ledgerCount(walletId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS entries FROM wallet_ledger_entry WHERE wallet_id = ${walletId}::uuid
  `) as { entries: number }[];
  return rows[0]?.entries ?? 0;
}

describe('consumidor SQS contra fila real', () => {
  test('mensagem válida debita a wallet e sai da fila', async () => {
    const wallet = await openWallet('1000.00');
    const messageId = `msg-${uniqueSuffix()}`;
    await sendRaw(sqs, inputUrl, envelopeFor(wallet, messageId), {
      groupId: wallet.id,
      deduplicationId: messageId,
    });

    expect(await worker.pollOnce()).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('975.00');
    expect(await receiveMessages(sqs, inputUrl, 2)).toEqual([]);
    expect(logger.lines).toContainEqual(
      expect.objectContaining({
        level: 'info',
        message: 'message processed',
        fields: expect.objectContaining({
          messageId: expect.any(String),
          correlationId: expect.any(String),
          transactionId: expect.any(String),
          walletId: wallet.id,
          providerId: 'provider-a',
        }),
      }),
    );
    expect(JSON.stringify(logger.lines)).not.toContain('25.00');
    expect(JSON.stringify(logger.lines)).not.toContain('975.00');
  });

  test('redelivery da mesma mensagem debita uma vez só', async () => {
    const wallet = await openWallet('1000.00');
    const messageId = `msg-${uniqueSuffix()}`;
    const body = envelopeFor(wallet, messageId);

    await sendRaw(sqs, inputUrl, body, { groupId: wallet.id, deduplicationId: `${messageId}-1` });
    await worker.pollOnce();
    await sendRaw(sqs, inputUrl, body, { groupId: wallet.id, deduplicationId: `${messageId}-2` });
    await worker.pollOnce();

    expect(await balanceOf(wallet.id)).toBe('975.00');
    expect(await ledgerCount(wallet.id)).toBe(2);
  });

  test('corpo que não é JSON vai para a DLQ e sai da fila de entrada', async () => {
    const messageId = `msg-${uniqueSuffix()}`;
    await sendRaw(sqs, inputUrl, 'isto não é json', {
      groupId: 'group-invalido',
      deduplicationId: messageId,
    });

    expect(await worker.pollOnce()).toBe(1);

    const [dead] = await receiveMessages(sqs, dlqUrl);
    expect(dead?.Body).toBe('isto não é json');
    expect(await receiveMessages(sqs, inputUrl, 2)).toEqual([]);
    expect(logger.lines).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'message rejected as permanent' }),
    );
  });

  test('conflito de idempotência de negócio vai para a DLQ sem alterar saldo', async () => {
    const wallet = await openWallet('1000.00');
    const suffix = uniqueSuffix();
    const conflicting = {
      externalTransactionId: `external-${suffix}`,
      idempotencyKey: `provider-a:external-${suffix}`,
    };

    const first = `msg-${uniqueSuffix()}`;
    await sendRaw(sqs, inputUrl, envelopeFor(wallet, first, conflicting), {
      groupId: wallet.id,
      deduplicationId: first,
    });
    await worker.pollOnce();

    const second = `msg-${uniqueSuffix()}`;
    await sendRaw(
      sqs,
      inputUrl,
      envelopeFor(wallet, second, { ...conflicting, money: { amount: '30.00', currency: 'BRL' } }),
      { groupId: wallet.id, deduplicationId: second },
    );

    expect(await worker.pollOnce()).toBe(1);
    expect(await receiveMessages(sqs, dlqUrl)).toHaveLength(1);
    expect(await balanceOf(wallet.id)).toBe('975.00');
  });

  test('o desligamento devolve a visibilidade do que a graça não terminou', async () => {
    const wallet = await openWallet('1000.00');
    const messageId = `msg-${uniqueSuffix()}`;
    await sendRaw(sqs, inputUrl, envelopeFor(wallet, messageId), {
      groupId: wallet.id,
      deduplicationId: messageId,
    });

    const stuck = new HangingConsume();
    const draining = new WagerConsumerWorker(sqs, stuck, new CapturingLogger(), {
      enabled: true,
      consumerName: CONSUMER_NAME,
      inputQueue: INPUT_QUEUE,
      dlqQueue: DLQ_QUEUE,
      batchSize: 10,
      waitTimeSeconds: 1,
      inFlightGraceMs: 200,
      shutdownWindowMs: 400,
    });

    draining.onApplicationBootstrap();
    await until(() => stuck.started);

    const startedAt = Date.now();
    await draining.onApplicationShutdown();

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(await balanceOf(wallet.id)).toBe('1000.00');
    expect(await receiveMessages(sqs, inputUrl, 3)).toHaveLength(1);
  }, 30_000);

  test('falha transitória devolve a mensagem em vez de apagá-la', async () => {
    const wallet = await openWallet('1000.00');
    const messageId = `msg-${uniqueSuffix()}`;
    const body = envelopeFor(wallet, messageId);
    const { inboxPayloadHash } = parseWagerMessage(body);

    await sql`
      INSERT INTO inbox_message (consumer_name, message_id, payload_hash, received_at)
      VALUES (${CONSUMER_NAME}, ${messageId}, ${inboxPayloadHash}, now())
    `;
    await sendRaw(sqs, inputUrl, body, { groupId: wallet.id, deduplicationId: messageId });

    expect(await worker.pollOnce()).toBe(1);
    expect(await balanceOf(wallet.id)).toBe('1000.00');
    expect(await receiveMessages(sqs, dlqUrl, 2)).toEqual([]);
    expect(logger.lines).toContainEqual(
      expect.objectContaining({ level: 'warn', message: 'message returned for retry' }),
    );

    await Bun.sleep(6_000);
    expect(await receiveMessages(sqs, inputUrl, 3)).toHaveLength(1);
  }, 30_000);
});
