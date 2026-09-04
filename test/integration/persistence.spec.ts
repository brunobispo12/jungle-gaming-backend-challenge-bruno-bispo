import { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { Repositories } from '@/application/ports';
import { Money } from '@/domain/money';
import { WagerTransaction, WagerTransactionKind } from '@/domain/wager-transaction';
import { Wallet } from '@/domain/wallet';
import { runtimeOrmConfig } from '@/infrastructure/persistence/orm.config';
import { SCHEMAS } from '@/infrastructure/persistence/rows';
import { StaleWriteError } from '@/infrastructure/persistence/stale-write-error';
import { MikroUnitOfWork } from '@/infrastructure/persistence/unit-of-work';
import { MIGRATOR_URL, uniqueSuffix, uuid } from './support/database';

let orm: MikroORM;
let unitOfWork: MikroUnitOfWork;

const AT = new Date('2026-07-29T15:00:00.000Z');

beforeAll(async () => {
  orm = await MikroORM.init({
    ...runtimeOrmConfig(MIGRATOR_URL),
    entities: SCHEMAS,
    discovery: {},
  });
  unitOfWork = new MikroUnitOfWork(orm, 5_000);
});

afterAll(async () => {
  await orm.close(true);
});

function newWallet(currency: string, balance: string): Wallet {
  return Wallet.open({
    id: uuid(),
    playerId: `player-${uniqueSuffix()}`,
    initialBalance: Money.from({ amount: balance, currency }),
    at: AT,
    openingEntryId: uuid(),
    openingTransactionId: uuid(),
  }).wallet;
}

function newBet(wallet: Wallet, amount: string, id = uuid()): WagerTransaction {
  const suffix = uniqueSuffix();
  return WagerTransaction.create({
    id,
    providerId: 'provider-a',
    externalTransactionId: `external-${suffix}`,
    idempotencyKey: `provider-a:external-${suffix}`,
    payloadHash: 'a'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: `round-${suffix}`,
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: Money.from({ amount, currency: wallet.currency }),
    correlationId: `correlation-${suffix}`,
    createdAt: AT,
  });
}

describe('persistência — Money atravessa o banco sem virar número', () => {
  test('saldo e valores voltam como string decimal exata', async () => {
    const wallet = newWallet('BRL', '1000.55');

    const reread = await unitOfWork.transactional(async (repositories: Repositories) => {
      await repositories.wallets.insertIfAbsent(wallet);
      return repositories.wallets.findById(wallet.id);
    });

    expect(reread?.balance.toString()).toBe('1000.55');
    expect(reread?.balance.equals(wallet.balance)).toBe(true);
  });
});

describe('persistência — reserva de identidade', () => {
  test('a segunda wallet do mesmo par não é inserida e é detectável', async () => {
    const wallet = newWallet('BRL', '10.00');
    const twin = Wallet.open({
      id: uuid(),
      playerId: wallet.playerId,
      initialBalance: Money.from({ amount: '99.00', currency: 'BRL' }),
      at: AT,
      openingEntryId: uuid(),
      openingTransactionId: uuid(),
    }).wallet;

    const [first, second] = await unitOfWork.transactional(async (repositories) => [
      await repositories.wallets.insertIfAbsent(wallet),
      await repositories.wallets.insertIfAbsent(twin),
    ]);

    expect(first?.id).toBe(wallet.id);
    expect(second).toBeUndefined();
  });

  test('a reserva de wager perde para a identidade existente, por key ou por external id', async () => {
    const wallet = newWallet('BRL', '100.00');
    const bet = newBet(wallet, '25.00');

    const outcome = await unitOfWork.transactional(async (repositories) => {
      await repositories.wallets.insertIfAbsent(wallet);
      const owned = await repositories.wagerTransactions.reserve(bet);
      const duplicate = await repositories.wagerTransactions.reserve(bet);
      return { owned, duplicate };
    });

    expect(outcome.owned?.id).toBe(bet.id);
    expect(outcome.duplicate).toBeUndefined();
  });
});

describe('persistência — escrita financeira nunca falha em silêncio', () => {
  test('atualizar wallet inexistente levanta StaleWriteError', async () => {
    const orphan = newWallet('BRL', '10.00');

    await expect(
      unitOfWork.transactional((repositories) => repositories.wallets.update(orphan)),
    ).rejects.toThrow(StaleWriteError);
  });

  test('atualizar wager inexistente levanta StaleWriteError', async () => {
    const wallet = newWallet('BRL', '100.00');
    const orphan = newBet(wallet, '25.00');
    orphan.markProcessed({ resultBalance: wallet.balance, at: AT });

    await expect(
      unitOfWork.transactional((repositories) => repositories.wagerTransactions.update(orphan)),
    ).rejects.toThrow(StaleWriteError);
  });
});

describe('persistência — reconstrução do saldo pelo ledger', () => {
  test('wallet sem lançamento reconstrói zero na moeda da wallet, não em BRL', async () => {
    const wallet = newWallet('USD', '0.00');

    const reconstructed = await unitOfWork.transactional(async (repositories) => {
      await repositories.wallets.insertIfAbsent(wallet);
      return repositories.ledger.reconstructBalance(wallet);
    });

    expect(reconstructed.entries).toBe(0);
    expect(reconstructed.balance.currency).toBe('USD');
    expect(reconstructed.balance.toString()).toBe('0.00');
    // The comparison only works because the currencies match; a BRL default would throw.
    expect(reconstructed.balance.equals(wallet.balance)).toBe(true);
  });

  test('reconstrução negativa é reportada, não lançada: é o que a reconciliação existe para detectar', async () => {
    const wallet = newWallet('BRL', '100.00');
    const debit = newBet(wallet, '30.00');

    const reconstructed = await unitOfWork.transactional(async (repositories) => {
      await repositories.wallets.insertIfAbsent(wallet);
      await repositories.wagerTransactions.reserve(debit);

      const entry = wallet.debit({
        entryId: uuid(),
        transactionId: debit.id,
        money: debit.money,
        at: AT,
      });
      debit.markProcessed({ resultBalance: wallet.balance, at: AT });
      await repositories.wagerTransactions.update(debit);
      await repositories.ledger.insert(entry);

      // The opening entry is deliberately omitted, so the ledger disagrees with
      // the wallet: that disagreement is what reconciliation must report.
      return repositories.ledger.reconstructBalance(wallet);
    });

    expect(reconstructed.balance.toString()).toBe('-30.00');
    expect(reconstructed.balance.isNegative()).toBe(true);
    expect(reconstructed.balance.equals(wallet.balance)).toBe(false);
  });

  test('o saldo reconstruído bate com o saldo materializado quando o ledger está completo', async () => {
    const opening = Wallet.open({
      id: uuid(),
      playerId: `player-${uniqueSuffix()}`,
      initialBalance: Money.from({ amount: '100.00', currency: 'BRL' }),
      at: AT,
      openingEntryId: uuid(),
      openingTransactionId: uuid(),
    });
    const wallet = opening.wallet;
    const openingEntry = opening.openingEntry!;
    // The opening entry references this transaction, so the id must match.
    const openingTransaction = newBet(wallet, '100.00', openingEntry.transactionId);
    const debit = newBet(wallet, '30.00');
    const credit = newBet(wallet, '12.50');

    const reconstructed = await unitOfWork.transactional(async (repositories) => {
      await repositories.wallets.insertIfAbsent(wallet);

      await repositories.wagerTransactions.reserve(openingTransaction);
      openingTransaction.markProcessed({ resultBalance: wallet.balance, at: AT });
      await repositories.wagerTransactions.update(openingTransaction);
      await repositories.ledger.insert(openingEntry);

      for (const [transaction, apply] of [
        [debit, () => wallet.debit({ entryId: uuid(), transactionId: debit.id, money: debit.money, at: AT })],
        [credit, () => wallet.credit({ entryId: uuid(), transactionId: credit.id, money: credit.money, at: AT })],
      ] as const) {
        await repositories.wagerTransactions.reserve(transaction);
        const entry = apply();
        transaction.markProcessed({ resultBalance: wallet.balance, at: AT });
        await repositories.wagerTransactions.update(transaction);
        await repositories.ledger.insert(entry);
      }

      await repositories.wallets.update(wallet);
      return repositories.ledger.reconstructBalance(wallet);
    });

    expect(reconstructed.entries).toBe(3);
    expect(reconstructed.balance.toString()).toBe('82.50');
    expect(reconstructed.balance.equals(wallet.balance)).toBe(true);
  });
});
