import type { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import type { SubmitWagerCommand } from '@/application/use-cases/submit-wager-transaction';
import type { InboxDelivery } from '@/application/use-cases/consume-wager-message';
import { FailureCode } from '@/domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '@/domain/wager-transaction';
import { CONSUMER_NAME } from '@/interface/sqs/envelope';
import {
  MIGRATOR_URL,
  connect,
  expectWalletsMatchLedger,
  uniqueSuffix,
} from './support/database';
import { bootUseCases, type UseCases } from './support/use-cases';

let app: UseCases;
let sql: SQL;

beforeAll(async () => {
  app = await bootUseCases();
  sql = connect(MIGRATOR_URL);
});

afterAll(async () => {
  await app.close();
  await sql.end();
});

const touched: string[] = [];

// README §13: a test that moved a wallet closes by proving the ledger still
// reconstructs its balance.
afterEach(async () => {
  await expectWalletsMatchLedger(sql, touched.splice(0));
});

async function openWallet(balance: string): Promise<{ id: string; playerId: string }> {
  const playerId = `player-${uniqueSuffix()}`;
  const wallet = await app.createWallet.execute({
    playerId,
    initialBalance: { amount: balance, currency: 'BRL' },
    correlationId: `correlation-${uniqueSuffix()}`,
  });
  touched.push(wallet.id);
  return { id: wallet.id, playerId };
}

function command(
  wallet: { id: string; playerId: string },
  overrides: Partial<SubmitWagerCommand> = {},
): SubmitWagerCommand {
  const suffix = uniqueSuffix();
  return {
    providerId: 'provider-a',
    externalTransactionId: `external-${suffix}`,
    idempotencyKey: `provider-a:external-${suffix}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${suffix}`,
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: 'BRL' },
    correlationId: `correlation-${suffix}`,
    ...overrides,
  };
}

function delivery(overrides: Partial<InboxDelivery> = {}): InboxDelivery {
  const suffix = uniqueSuffix();
  return {
    consumerName: CONSUMER_NAME,
    messageId: `msg-${suffix}`,
    payloadHash: 'a'.repeat(64),
    brokerMessageId: `broker-${suffix}`,
    ...overrides,
  };
}

interface InboxRow {
  readonly payload_hash: string;
  readonly broker_message_id: string | null;
  readonly processed_at: Date | null;
}

async function inboxRow(messageId: string): Promise<InboxRow | undefined> {
  const rows = (await sql`
    SELECT payload_hash, broker_message_id, processed_at FROM inbox_message
    WHERE consumer_name = ${CONSUMER_NAME} AND message_id = ${messageId}
  `) as InboxRow[];
  return rows[0];
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

async function outboxTypes(aggregateId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT event_type FROM outbox_message WHERE aggregate_id = ${aggregateId} ORDER BY event_type
  `) as { event_type: string }[];
  return rows.map((row) => row.event_type);
}

async function wagerCount(providerId: string, externalTransactionId: string): Promise<number> {
  const rows = (await sql`
    SELECT count(*)::int AS total FROM wager_transaction
    WHERE provider_id = ${providerId} AND external_transaction_id = ${externalTransactionId}
  `) as { total: number }[];
  return rows[0]?.total ?? 0;
}

describe('consumo de mensagem com inbox', () => {
  test('mensagem nova aplica a aposta e marca a inbox no mesmo commit', async () => {
    const wallet = await openWallet('1000.00');
    const message = delivery();
    const wager = command(wallet);

    const outcome = await app.consumeWagerMessage.consume(message, wager);

    expect(outcome.kind).toBe('processed');
    expect(outcome.kind === 'processed' && outcome.result.status).toBe(
      WagerTransactionStatus.Processed,
    );

    const row = await inboxRow(message.messageId);
    expect(row?.payload_hash).toBe(message.payloadHash);
    expect(row?.broker_message_id).toBe(message.brokerMessageId ?? null);
    expect(row?.processed_at).not.toBeNull();

    expect(await balanceOf(wallet.id)).toBe('975.00');
    expect(await ledgerCount(wallet.id)).toBe(2);
  });

  test('redelivery do mesmo messageId não repete o efeito financeiro', async () => {
    const wallet = await openWallet('1000.00');
    const message = delivery();
    const wager = command(wallet);

    await app.consumeWagerMessage.consume(message, wager);
    const repeated = await app.consumeWagerMessage.consume(message, wager);

    expect(repeated.kind).toBe('duplicate');
    expect(await balanceOf(wallet.id)).toBe('975.00');
    expect(await ledgerCount(wallet.id)).toBe(2);
  });

  test('duas instâncias consumindo a mesma entrega aplicam o efeito uma vez', async () => {
    const wallet = await openWallet('1000.00');
    const message = delivery();
    const wager = command(wallet);

    const outcomes = await Promise.all([
      app.consumeWagerMessage.consume(message, wager),
      app.consumeWagerMessage.consume(message, wager),
    ]);

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['duplicate', 'processed']);
    expect(await balanceOf(wallet.id)).toBe('975.00');
    expect(await ledgerCount(wallet.id)).toBe(2);
  });

  test('mesmo messageId com payload diferente é erro permanente e não cria wager', async () => {
    const wallet = await openWallet('1000.00');
    const message = delivery();
    await app.consumeWagerMessage.consume(message, command(wallet));

    const other = command(wallet);
    const outcome = await app.consumeWagerMessage.consume(
      { ...message, payloadHash: 'b'.repeat(64) },
      other,
    );

    expect(outcome.kind).toBe('permanent');
    expect(await wagerCount(other.providerId, other.externalTransactionId)).toBe(0);
  });

  test('rejeição de negócio grava status, inbox e outbox e é entregue como processada', async () => {
    const wallet = await openWallet('10.00');
    const message = delivery();
    const wager = command(wallet);

    const outcome = await app.consumeWagerMessage.consume(message, wager);

    expect(outcome.kind).toBe('processed');
    if (outcome.kind === 'processed') {
      expect(outcome.result.status).toBe(WagerTransactionStatus.Rejected);
      expect(outcome.result.failureCode).toBe(FailureCode.InsufficientFunds);
      expect(await outboxTypes(outcome.result.transactionId)).toEqual([
        'WagerTransactionRejected',
      ]);
    }

    expect((await inboxRow(message.messageId))?.processed_at).not.toBeNull();
    expect(await balanceOf(wallet.id)).toBe('10.00');
    expect(await ledgerCount(wallet.id)).toBe(1);
  });

  test('entrega nova que encontra replay de negócio ainda commita a inbox', async () => {
    const wallet = await openWallet('1000.00');
    const wager = command(wallet);
    await app.submitWager.execute(wager);

    const message = delivery();
    const outcome = await app.consumeWagerMessage.consume(message, wager);

    expect(outcome.kind).toBe('processed');
    expect(outcome.kind === 'processed' && outcome.result.idempotentReplay).toBe(true);
    expect((await inboxRow(message.messageId))?.processed_at).not.toBeNull();
    expect(await ledgerCount(wallet.id)).toBe(2);
    expect(await balanceOf(wallet.id)).toBe('975.00');
  });

  test('conflito de idempotência de negócio é permanente e reverte a inbox', async () => {
    const wallet = await openWallet('1000.00');
    const wager = command(wallet);
    await app.submitWager.execute(wager);

    const message = delivery();
    const outcome = await app.consumeWagerMessage.consume(message, {
      ...wager,
      money: { amount: '30.00', currency: 'BRL' },
    });

    expect(outcome.kind).toBe('permanent');
    expect(await inboxRow(message.messageId)).toBeUndefined();
    expect(await balanceOf(wallet.id)).toBe('975.00');
  });

  test('inbox reservada sem processamento é tratada como falha transitória', async () => {
    const wallet = await openWallet('1000.00');
    const message = delivery();

    await sql`
      INSERT INTO inbox_message (consumer_name, message_id, payload_hash, broker_message_id, received_at)
      VALUES (${message.consumerName}, ${message.messageId}, ${message.payloadHash},
              ${message.brokerMessageId ?? null}, now())
    `;

    const outcome = await app.consumeWagerMessage.consume(message, command(wallet));

    expect(outcome.kind).toBe('transient');
  });
});
