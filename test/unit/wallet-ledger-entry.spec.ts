import { describe, expect, test } from 'bun:test';

import { InvalidLedgerEntryError } from '@/domain/domain-error';
import { Money } from '@/domain/money';
import { LedgerDirection, WalletLedgerEntry } from '@/domain/wallet-ledger-entry';

const AT = new Date('2026-07-29T15:00:00.000Z');
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

const base = {
  id: 'entry-1',
  walletId: 'wallet-1',
  transactionId: 'transaction-1',
  createdAt: AT,
};

describe('WalletLedgerEntry', () => {
  test('create aceita débito com aritmética coerente', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  test('create aceita crédito com aritmética coerente', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Credit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('125.00'),
    });

    expect(entry.isBalanced()).toBe(true);
  });

  test('create recusa aritmética inconsistente', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('80.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('create recusa direção invertida mesmo com valores plausíveis', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: brl('25.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('75.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('create recusa valor zero', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Credit,
        money: Money.zero('BRL'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('100.00'),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('create recusa saldo resultante negativo', () => {
    expect(() =>
      WalletLedgerEntry.create({
        ...base,
        direction: LedgerDirection.Debit,
        money: brl('150.00'),
        balanceBefore: brl('100.00'),
        balanceAfter: brl('50.00').negate(),
      }),
    ).toThrow(InvalidLedgerEntryError);
  });

  test('não expõe transição nem setter: o lançamento nasce final', () => {
    const entry = WalletLedgerEntry.create({
      ...base,
      direction: LedgerDirection.Debit,
      money: brl('25.00'),
      balanceBefore: brl('100.00'),
      balanceAfter: brl('75.00'),
    });

    const mutators = Object.getOwnPropertyNames(Object.getPrototypeOf(entry)).filter((name) =>
      /^(set|update|mark|apply|change|revert|reverse|adjust)/.test(name),
    );

    expect(mutators).toEqual([]);
  });
});
