import type { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { ApplicationError, ErrorCode } from '@/application/errors';
import type { SubmitWagerCommand } from '@/application/use-cases/submit-wager-transaction';
import { FailureCode } from '@/domain/failure-code';
import { WagerTransactionKind, WagerTransactionStatus } from '@/domain/wager-transaction';
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

async function openWallet(balance: string, currency = 'BRL'): Promise<{ id: string; playerId: string }> {
  const playerId = `player-${uniqueSuffix()}`;
  const wallet = await app.createWallet.execute({
    playerId,
    initialBalance: { amount: balance, currency },
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

describe('criação de wallet', () => {
  test('saldo inicial positivo grava wallet, OPENING e ledger na mesma transação', async () => {
    const wallet = await openWallet('1000.00');

    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(await outboxTypes(wallet.id)).toEqual(['WalletBalanceChanged']);
  });

  test('saldo inicial zero cria wallet sem OPENING e sem ledger', async () => {
    const wallet = await openWallet('0.00');

    expect(await ledgerCount(wallet.id)).toBe(0);
    expect(await outboxTypes(wallet.id)).toEqual([]);
  });

  test('TST-040 criação concorrente da mesma wallet: uma vence, a outra é conflito', async () => {
    const playerId = `player-${uniqueSuffix()}`;
    const create = (): Promise<unknown> =>
      app.createWallet.execute({
        playerId,
        initialBalance: { amount: '10.00', currency: 'BRL' },
        correlationId: `correlation-${uniqueSuffix()}`,
      });

    const outcomes = await Promise.allSettled([create(), create(), create()]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const conflicts = outcomes.filter(
      (outcome) =>
        outcome.status === 'rejected' &&
        outcome.reason instanceof ApplicationError &&
        outcome.reason.code === ErrorCode.WalletAlreadyExists,
    );

    expect(fulfilled).toHaveLength(1);
    expect(conflicts).toHaveLength(2);
  });
});

describe('submissão de wager', () => {
  test('BET aplicada debita e gera exatamente um lançamento', async () => {
    const wallet = await openWallet('1000.00');

    const result = await app.submitWager.execute(command(wallet));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance?.amount).toBe('975.00');
    expect(result.idempotentReplay).toBe(false);
    expect(await ledgerCount(wallet.id)).toBe(2);
  });

  test('TST-015 BET sem saldo é REJECTED, sem lançamento e sem mover o saldo', async () => {
    const wallet = await openWallet('10.00');

    const result = await app.submitWager.execute(
      command(wallet, { money: { amount: '20.00', currency: 'BRL' } }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.InsufficientFunds);
    expect(result.balance?.amount).toBe('10.00');
    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(await outboxTypes(result.transactionId)).toEqual(['WagerTransactionRejected']);
  });

  test('TST-016 LOSS é PROCESSED sem mover saldo e sem lançamento', async () => {
    const wallet = await openWallet('100.00');

    const result = await app.submitWager.execute(
      command(wallet, { kind: WagerTransactionKind.Loss }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance?.amount).toBe('100.00');
    expect(await ledgerCount(wallet.id)).toBe(1);
    expect(await outboxTypes(result.transactionId)).toEqual(['WagerTransactionProcessed']);
  });

  test('conflito de moeda persiste rejeição auditável com snapshot na moeda da wallet', async () => {
    const wallet = await openWallet('500.00', 'BRL');

    const result = await app.submitWager.execute(
      command(wallet, { money: { amount: '25.00', currency: 'USD' } }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.CurrencyMismatch);
    expect(result.balance).toEqual({ amount: '500.00', currency: 'BRL' });

    const rows = (await sql`
      SELECT currency, result_balance_currency FROM wager_transaction
      WHERE id = ${result.transactionId}::uuid
    `) as { currency: string; result_balance_currency: string }[];
    expect(rows[0]).toEqual({ currency: 'USD', result_balance_currency: 'BRL' });
  });

  test('wallet inexistente é rejeitada de forma auditável e sem saldo histórico', async () => {
    const result = await app.submitWager.execute(
      command({ id: crypto.randomUUID(), playerId: 'player-ghost' }),
    );

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.failureCode).toBe(FailureCode.WalletNotFound);
    expect(result.balance).toBeUndefined();
  });

  test('reversão sem referência fica PENDING_REFERENCE com o snapshot do aceite', async () => {
    const wallet = await openWallet('100.00');

    const result = await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: `missing-${uniqueSuffix()}`,
      }),
    );

    expect(result.status).toBe(WagerTransactionStatus.PendingReference);
    expect(result.balance?.amount).toBe('100.00');
    expect(await outboxTypes(result.transactionId)).toEqual([
      'WagerTransactionPendingReference',
    ]);
  });

  test('REFUND da BET referenciada credita de volta exatamente o valor', async () => {
    const wallet = await openWallet('100.00');
    const bet = command(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    await app.submitWager.execute(bet);

    const refund = await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Refund,
        money: { amount: '25.00', currency: 'BRL' },
        roundId: bet.roundId,
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.balance?.amount).toBe('100.00');
  });
});

describe('idempotência', () => {
  test('replay devolve o resultado original, incluindo o saldo daquele momento', async () => {
    const wallet = await openWallet('1000.00');
    const submission = command(wallet);

    const first = await app.submitWager.execute(submission);
    await app.submitWager.execute(command(wallet, { money: { amount: '100.00', currency: 'BRL' } }));
    const replay = await app.submitWager.execute(submission);

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    // The balance observed on the first run, not the current 875.00.
    expect(replay.balance?.amount).toBe('975.00');
    expect(await ledgerCount(wallet.id)).toBe(3);
  });

  test('TST-020 mesma key com payload divergente é conflito, não replay', async () => {
    const wallet = await openWallet('1000.00');
    const submission = command(wallet);

    await app.submitWager.execute(submission);

    const failure = await app.submitWager
      .execute({ ...submission, money: { amount: '99.00', currency: 'BRL' } })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationError);
    expect((failure as ApplicationError).code).toBe(ErrorCode.IdempotencyKeyConflict);
  });

  test('externalTransactionId reutilizado com outra key é conflito', async () => {
    const wallet = await openWallet('1000.00');
    const submission = command(wallet);

    await app.submitWager.execute(submission);

    const failure = await app.submitWager
      .execute({ ...submission, idempotencyKey: `other-${uniqueSuffix()}` })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApplicationError);
    expect((failure as ApplicationError).code).toBe(ErrorCode.ExternalTransactionIdReused);
  });
});

describe('WIN com referência opcional', () => {
  test('WIN vinculado à BET da rodada grava o vínculo interno', async () => {
    const wallet = await openWallet('100.00');
    const bet = command(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    const applied = await app.submitWager.execute(bet);

    const win = await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Win,
        money: { amount: '60.00', currency: 'BRL' },
        roundId: bet.roundId,
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(win.balance?.amount).toBe('135.00');

    const rows = (await sql`
      SELECT reference_transaction_id FROM wager_transaction WHERE id = ${win.transactionId}::uuid
    `) as { reference_transaction_id: string | null }[];
    expect(rows[0]?.reference_transaction_id).toBe(applied.transactionId);
  });

  test('WIN apontando para a BET de outra rodada é rejeitado, não aceito em silêncio', async () => {
    const wallet = await openWallet('100.00');
    const bet = command(wallet, { money: { amount: '25.00', currency: 'BRL' } });
    await app.submitWager.execute(bet);

    const win = await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Win,
        money: { amount: '60.00', currency: 'BRL' },
        referenceExternalTransactionId: bet.externalTransactionId,
      }),
    );

    expect(win.status).toBe(WagerTransactionStatus.Rejected);
    expect(win.failureCode).toBe(FailureCode.ReferenceMismatch);
    expect(win.balance?.amount).toBe('75.00');
  });

  test('WIN cuja referência ainda não existe é processado sem vínculo', async () => {
    const wallet = await openWallet('100.00');

    const win = await app.submitWager.execute(
      command(wallet, {
        kind: WagerTransactionKind.Win,
        money: { amount: '60.00', currency: 'BRL' },
        referenceExternalTransactionId: `missing-${uniqueSuffix()}`,
      }),
    );

    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(win.balance?.amount).toBe('160.00');

    const rows = (await sql`
      SELECT reference_transaction_id FROM wager_transaction WHERE id = ${win.transactionId}::uuid
    `) as { reference_transaction_id: string | null }[];
    expect(rows[0]?.reference_transaction_id).toBeNull();
  });
});
