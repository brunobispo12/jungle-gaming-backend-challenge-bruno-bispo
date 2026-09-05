import type { SQL } from 'bun';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { ApplicationError, ErrorCode } from '@/application/errors';
import type { LedgerCursor } from '@/application/ports';
import type { SubmitWagerCommand } from '@/application/use-cases/submit-wager-transaction';
import { WagerTransactionKind } from '@/domain/wager-transaction';
import type { WalletLedgerEntry } from '@/domain/wallet-ledger-entry';
import {
  MIGRATOR_URL,
  connect,
  expectWalletsMatchLedger,
  uniqueSuffix,
  uuid,
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

afterEach(async () => {
  await expectWalletsMatchLedger(sql, touched.splice(0));
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
  touched.push(wallet.id);
  return { id: wallet.id, playerId };
}

function bet(wallet: Wallet, amount: string): Promise<string> {
  return submit(wallet, amount, WagerTransactionKind.Bet);
}

// LOSS moves no balance and writes no ledger entry, so its id is the only one
// available to forge an orphan entry past ledger_transaction_wallet_uq.
function loss(wallet: Wallet, amount: string): Promise<string> {
  return submit(wallet, amount, WagerTransactionKind.Loss);
}

async function submit(
  wallet: Wallet,
  amount: string,
  kind: WagerTransactionKind,
): Promise<string> {
  const suffix = uniqueSuffix();
  const command: SubmitWagerCommand = {
    providerId: 'provider-a',
    externalTransactionId: `external-${suffix}`,
    idempotencyKey: `provider-a:external-${suffix}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: `round-${suffix}`,
    gameId: 'fortune-chimp',
    kind,
    money: { amount, currency: 'BRL' },
    correlationId: `correlation-${suffix}`,
  };
  const result = await app.submitWager.execute(command);
  return result.transactionId;
}

function pageOf(
  walletId: string,
  limit: number,
  after?: LedgerCursor,
): Promise<{ entries: readonly WalletLedgerEntry[]; hasMore: boolean }> {
  return app.unitOfWork.readOnly(async (repositories) => {
    const wallet = await repositories.wallets.findById(walletId);
    if (wallet === undefined) {
      throw new Error(`wallet ${walletId} não existe`);
    }
    return repositories.ledger.page(wallet, limit, after);
  });
}

function cursorOf(entry: WalletLedgerEntry): LedgerCursor {
  return { createdAt: entry.createdAt, id: entry.id };
}

describe('paginação do ledger', () => {
  test('a primeira página traz os lançamentos mais recentes primeiro', async () => {
    const wallet = await openWallet('1000.00');
    app.clock.advance(1_000);
    await bet(wallet, '10.00');
    app.clock.advance(1_000);
    await bet(wallet, '20.00');

    const page = await pageOf(wallet.id, 50);

    expect(page.hasMore).toBe(false);
    expect(page.entries.map((entry) => entry.money.toString())).toEqual([
      '20.00',
      '10.00',
      '1000.00',
    ]);
  });

  test('o cursor continua exatamente de onde a página parou', async () => {
    const wallet = await openWallet('1000.00');
    for (const amount of ['10.00', '20.00', '30.00', '40.00']) {
      app.clock.advance(1_000);
      await bet(wallet, amount);
    }

    const first = await pageOf(wallet.id, 2);
    expect(first.hasMore).toBe(true);
    expect(first.entries).toHaveLength(2);

    const last = first.entries[first.entries.length - 1];
    if (last === undefined) {
      throw new Error('a primeira página deveria ter lançamentos');
    }
    const second = await pageOf(wallet.id, 2, cursorOf(last));

    const seen = [...first.entries, ...second.entries].map((entry) => entry.id);
    expect(new Set(seen).size).toBe(seen.length);
    expect(second.entries.map((entry) => entry.money.toString())).toEqual(['20.00', '10.00']);
    expect(second.hasMore).toBe(true);
  });

  test('a última página não anuncia continuação', async () => {
    const wallet = await openWallet('1000.00');
    app.clock.advance(1_000);
    await bet(wallet, '10.00');

    const first = await pageOf(wallet.id, 1);
    const last = first.entries[0];
    if (last === undefined) {
      throw new Error('a primeira página deveria ter lançamentos');
    }

    const second = await pageOf(wallet.id, 1, cursorOf(last));
    expect(second.entries).toHaveLength(1);
    expect(second.hasMore).toBe(false);
  });

  test('wallet aberta com saldo zero tem ledger vazio', async () => {
    const wallet = await openWallet('0.00');

    const page = await pageOf(wallet.id, 50);

    expect(page.entries).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  test('o lançamento carrega o saldo antes e depois do movimento', async () => {
    const wallet = await openWallet('1000.00');
    app.clock.advance(1_000);
    await bet(wallet, '25.00');

    const [entry] = (await pageOf(wallet.id, 1)).entries;

    expect(entry?.balanceBefore.toString()).toBe('1000.00');
    expect(entry?.balanceAfter.toString()).toBe('975.00');
  });
});

describe('reconciliação', () => {
  test('wallet íntegra reporta saldo igual ao reconstruído', async () => {
    const wallet = await openWallet('1000.00');
    app.clock.advance(1_000);
    await bet(wallet, '25.00');

    const report = await app.reconcileWallet.execute(wallet.id);

    expect(report).toMatchObject({
      walletId: wallet.id,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 2,
    });
  });

  test('wallet com ledger adulterado reporta a divergência sem corrigir nada', async () => {
    const wallet = await openWallet('1000.00');
    app.clock.advance(1_000);
    await bet(wallet, '25.00');
    const orphan = await loss(wallet, '5.00');

    await sql`
      INSERT INTO wallet_ledger_entry (
        id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after, created_at
      ) VALUES (
        ${uuid()}::uuid, ${wallet.id}::uuid, ${orphan}::uuid,
        'DEBIT'::ledger_direction, 5.00::numeric, 'BRL', 975.00::numeric, 970.00::numeric, now()
      )
    `;

    const report = await app.reconcileWallet.execute(wallet.id);

    expect(report).toMatchObject({
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '970.00', currency: 'BRL' },
      difference: { amount: '5.00', currency: 'BRL' },
      consistent: false,
      checkedEntries: 3,
    });

    const rows = (await sql`
      SELECT balance::text AS balance FROM wallet WHERE id = ${wallet.id}::uuid
    `) as { balance: string }[];
    expect(rows[0]?.balance).toBe('975.00');

    // Administrative cleanup after proving reconciliation performed no write.
    await sql`UPDATE wallet SET balance = 970.00 WHERE id = ${wallet.id}::uuid`;
  });

  test('wallet aberta com saldo zero reconcilia sem lançamento nenhum', async () => {
    const wallet = await openWallet('0.00');

    const report = await app.reconcileWallet.execute(wallet.id);

    expect(report).toMatchObject({
      calculatedBalance: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 0,
    });
  });

  test('wallet inexistente é recurso ausente', async () => {
    const missing = app.reconcileWallet.execute(uuid());

    await expect(missing).rejects.toBeInstanceOf(ApplicationError);
    await expect(missing).rejects.toMatchObject({ code: ErrorCode.ResourceNotFound });
  });
});
