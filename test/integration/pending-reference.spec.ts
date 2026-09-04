import type { SQL } from 'bun';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import { ResolvePendingReferenceUseCase } from '@/application/use-cases/resolve-pending-reference';
import {
  SubmitWagerTransactionUseCase,
  type SubmitWagerCommand,
  type SubmitWagerResult,
} from '@/application/use-cases/submit-wager-transaction';
import { FailureCode } from '@/domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '@/domain/wager-transaction';
import { isTransientDatabaseFailure } from '@/infrastructure/persistence/postgres-errors';
import { MIGRATOR_URL, connect, uniqueSuffix } from './support/database';
import { bootUseCases, type UseCases } from './support/use-cases';

// A deterministic bug in the reversal rules, not a database hiccup: retrying it
// forever would end as REFERENCE_NOT_FOUND and blame the provider for our fault.
class BrokenSubmit extends SubmitWagerTransactionUseCase {
  override async applyResolvedReversal(): Promise<SubmitWagerResult> {
    throw new TypeError('undefined is not an object');
  }
}

const FIRST_RETRY_MS = 5_000;
const TTL_MS = 6 * 60 * 60 * 1000;

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

// The worker picks the oldest due pending in the whole table, so a leftover from
// an earlier case would answer for the next one as the shared clock advances.
beforeEach(async () => {
  await sql`
    UPDATE wager_transaction SET next_attempt_at = timestamptz '2999-01-01'
    WHERE status = 'PENDING_REFERENCE'
  `;
});

interface Wallet {
  readonly id: string;
  readonly playerId: string;
}

async function openWallet(balance: string): Promise<Wallet> {
  const playerId = `player-${uniqueSuffix()}`;
  const wallet = await app.createWallet.execute({
    playerId,
    initialBalance: { amount: balance, currency: 'BRL' },
    correlationId: `correlation-${uniqueSuffix()}`,
  });
  return { id: wallet.id, playerId };
}

function command(wallet: Wallet, overrides: Partial<SubmitWagerCommand> = {}): SubmitWagerCommand {
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

interface PendingSetup {
  readonly wallet: Wallet;
  readonly refundId: string;
  readonly roundId: string;
  readonly betExternalId: string;
}

async function pendingRefund(balance = '1000.00', amount = '25.00'): Promise<PendingSetup> {
  const wallet = await openWallet(balance);
  const roundId = `round-${uniqueSuffix()}`;
  const betExternalId = `bet-${uniqueSuffix()}`;

  const refund = await app.submitWager.execute(
    command(wallet, {
      kind: WagerTransactionKind.Refund,
      roundId,
      referenceExternalTransactionId: betExternalId,
      money: { amount, currency: 'BRL' },
    }),
  );

  expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
  return { wallet, refundId: refund.transactionId, roundId, betExternalId };
}

async function processBet(setup: PendingSetup, amount = '25.00'): Promise<string> {
  const bet = await app.submitWager.execute(
    command(setup.wallet, {
      kind: WagerTransactionKind.Bet,
      roundId: setup.roundId,
      externalTransactionId: setup.betExternalId,
      idempotencyKey: `provider-a:${setup.betExternalId}`,
      money: { amount, currency: 'BRL' },
    }),
  );
  expect(bet.status).toBe(WagerTransactionStatus.Processed);
  return bet.transactionId;
}

interface WagerRow {
  readonly status: string;
  readonly failure_code: string | null;
  readonly attempts: number;
  readonly next_attempt_at: Date | null;
  readonly reference_transaction_id: string | null;
  readonly result_balance_amount: string | null;
}

async function wagerRow(id: string): Promise<WagerRow> {
  const rows = (await sql`
    SELECT status, failure_code, attempts, next_attempt_at, reference_transaction_id,
           result_balance_amount::text AS result_balance_amount
    FROM wager_transaction WHERE id = ${id}::uuid
  `) as WagerRow[];
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`wager_transaction ${id} não existe`);
  }
  return row;
}

async function balanceOf(walletId: string): Promise<string> {
  const rows = (await sql`
    SELECT balance::text AS balance FROM wallet WHERE id = ${walletId}::uuid
  `) as { balance: string }[];
  return rows[0]?.balance ?? '';
}

async function outboxTypes(aggregateId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT event_type FROM outbox_message WHERE aggregate_id = ${aggregateId} ORDER BY event_type
  `) as { event_type: string }[];
  return rows.map((row) => row.event_type);
}

describe('worker de referências pendentes', () => {
  test('sem pendência vencida não faz trabalho', async () => {
    await pendingRefund();

    expect((await app.resolvePendingReference.run()).kind).toBe('idle');
  });

  test('referência ainda ausente conta a tentativa e reagenda com backoff', async () => {
    const setup = await pendingRefund();
    app.clock.advance(FIRST_RETRY_MS);
    const dueAt = app.clock.now();

    const outcome = await app.resolvePendingReference.run();

    expect(outcome).toMatchObject({ kind: 'rescheduled', transactionId: setup.refundId });
    const row = await wagerRow(setup.refundId);
    expect(row.status).toBe(WagerTransactionStatus.PendingReference);
    expect(row.attempts).toBe(1);
    expect(row.next_attempt_at?.getTime()).toBeGreaterThan(dueAt.getTime());
    expect(await balanceOf(setup.wallet.id)).toBe('1000.00');
  });

  test('referência que apareceu é processada e credita a wallet', async () => {
    const setup = await pendingRefund();
    await processBet(setup);
    app.clock.advance(FIRST_RETRY_MS);

    const outcome = await app.resolvePendingReference.run();

    expect(outcome).toMatchObject({
      kind: 'settled',
      transactionId: setup.refundId,
      status: WagerTransactionStatus.Processed,
    });
    const row = await wagerRow(setup.refundId);
    expect(row.reference_transaction_id).not.toBeNull();
    expect(row.result_balance_amount).toBe('1000.00');
    expect(await balanceOf(setup.wallet.id)).toBe('1000.00');
    expect(await outboxTypes(setup.refundId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionProcessed',
    ]);
  });

  test('referência com valor diferente é rejeitada pela regra de reversão', async () => {
    const setup = await pendingRefund('1000.00', '25.00');
    await processBet(setup, '30.00');
    app.clock.advance(FIRST_RETRY_MS);

    const outcome = await app.resolvePendingReference.run();

    expect(outcome).toMatchObject({
      kind: 'settled',
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReversalAmountMismatch,
    });
    expect(await balanceOf(setup.wallet.id)).toBe('970.00');
  });

  test('reversão já aplicada do mesmo kind é rejeitada', async () => {
    const setup = await pendingRefund();
    await processBet(setup);

    const alreadyRefunded = await app.submitWager.execute(
      command(setup.wallet, {
        kind: WagerTransactionKind.Refund,
        roundId: setup.roundId,
        referenceExternalTransactionId: setup.betExternalId,
      }),
    );
    expect(alreadyRefunded.status).toBe(WagerTransactionStatus.Processed);

    app.clock.advance(FIRST_RETRY_MS);
    const outcome = await app.resolvePendingReference.run();

    expect(outcome).toMatchObject({
      kind: 'settled',
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceAlreadyReversed,
    });
  });

  test('expirada sem referência vira REJECTED com REFERENCE_NOT_FOUND e evento', async () => {
    const setup = await pendingRefund();
    app.clock.advance(TTL_MS + 1_000);

    const outcome = await app.resolvePendingReference.run();

    expect(outcome).toMatchObject({
      kind: 'settled',
      transactionId: setup.refundId,
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
    });
    expect((await wagerRow(setup.refundId)).result_balance_amount).toBe('1000.00');
    expect(await outboxTypes(setup.refundId)).toEqual([
      'WagerTransactionPendingReference',
      'WagerTransactionRejected',
    ]);
    expect(await balanceOf(setup.wallet.id)).toBe('1000.00');
  });

  test('expirada cuja referência apareceu é processada em vez de rejeitada', async () => {
    const setup = await pendingRefund();
    await processBet(setup);
    app.clock.advance(TTL_MS + 1_000);

    const outcome = await app.resolvePendingReference.run();

    expect(outcome).toMatchObject({
      kind: 'settled',
      status: WagerTransactionStatus.Processed,
    });
    expect(await balanceOf(setup.wallet.id)).toBe('1000.00');
  });

  test('tentativas esgotadas encerram a pendência mesmo dentro do TTL', async () => {
    const setup = await pendingRefund();
    await sql`UPDATE wager_transaction SET attempts = 100 WHERE id = ${setup.refundId}::uuid`;
    app.clock.advance(FIRST_RETRY_MS);

    const outcome = await app.resolvePendingReference.run();

    expect(outcome).toMatchObject({
      kind: 'settled',
      status: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.ReferenceNotFound,
    });
  });

  test('falha determinística encerra a pendência como FAILED em vez de repetir para sempre', async () => {
    const setup = await pendingRefund();
    await processBet(setup);
    app.clock.advance(FIRST_RETRY_MS);

    const broken = new ResolvePendingReferenceUseCase(
      app.unitOfWork,
      new BrokenSubmit(app.unitOfWork, app.ids, app.clock),
      app.ids,
      app.clock,
      () => 0.5,
      isTransientDatabaseFailure,
    );

    const outcome = await broken.run();

    expect(outcome).toMatchObject({
      kind: 'settled',
      transactionId: setup.refundId,
      status: WagerTransactionStatus.Failed,
      failureCode: FailureCode.InfrastructureFailure,
    });
    const row = await wagerRow(setup.refundId);
    expect(row.status).toBe(WagerTransactionStatus.Failed);
    expect(row.result_balance_amount).toBe('975.00');
    expect(await balanceOf(setup.wallet.id)).toBe('975.00');
  });

  test('dois workers concorrentes não resolvem a mesma pendência', async () => {
    const setup = await pendingRefund();
    app.clock.advance(FIRST_RETRY_MS);

    const outcomes = await Promise.all([
      app.resolvePendingReference.run(),
      app.resolvePendingReference.run(),
    ]);

    expect(outcomes.filter((outcome) => outcome.kind === 'rescheduled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'idle')).toHaveLength(1);
    expect((await wagerRow(setup.refundId)).attempts).toBe(1);
  });
});
