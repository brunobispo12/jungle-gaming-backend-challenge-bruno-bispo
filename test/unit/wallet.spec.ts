import { describe, expect, test } from 'bun:test';

import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
  InvalidTimestampError,
} from '@/domain/domain-error';
import { Money } from '@/domain/money';
import { LedgerDirection } from '@/domain/wallet-ledger-entry';
import { Wallet, type WalletOpening } from '@/domain/wallet';

const AT = new Date('2026-07-29T15:00:00.000Z');
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

function openingOf(balance: string): WalletOpening {
  return Wallet.open({
    id: 'wallet-1',
    playerId: 'player-1',
    initialBalance: brl(balance),
    at: AT,
    openingEntryId: 'entry-0',
    openingTransactionId: 'opening-1',
  });
}

function openWallet(balance = '1000.00'): Wallet {
  return openingOf(balance).wallet;
}

const movement = (money: Money) => ({
  entryId: 'entry-1',
  transactionId: 'transaction-1',
  money,
  at: new Date('2026-07-29T15:05:00.000Z'),
});

describe('Wallet — abertura', () => {
  test('nasce com version 1 e o saldo inicial, porque o OPENING faz parte da criação', () => {
    const wallet = openWallet('1000.00');

    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.version).toBe(1);
    expect(wallet.currency).toBe('BRL');
  });

  test('saldo inicial zero cria wallet sem lançamento de abertura', () => {
    const { wallet, openingEntry } = openingOf('0.00');

    expect(wallet.balance.toString()).toBe('0.00');
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });

  test('saldo inicial positivo devolve o lançamento CREDIT junto da wallet, sem mexer em version', () => {
    const { wallet, openingEntry } = openingOf('1000.00');

    expect(openingEntry).toBeDefined();
    expect(openingEntry?.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry?.balanceBefore.toString()).toBe('0.00');
    expect(openingEntry?.balanceAfter.toString()).toBe('1000.00');
    expect(openingEntry?.isBalanced()).toBe(true);
    expect(wallet.version).toBe(1);
  });

  test('abrir com saldo positivo sempre produz o lançamento correspondente ao saldo', () => {
    for (const balance of ['0.01', '1000.00', '999999999999999999.99']) {
      const { wallet, openingEntry } = openingOf(balance);

      expect(openingEntry?.money.equals(wallet.balance)).toBe(true);
      expect(openingEntry?.balanceAfter.equals(wallet.balance)).toBe(true);
      expect(openingEntry?.balanceBefore.isZero()).toBe(true);
      expect(openingEntry?.walletId).toBe(wallet.id);
    }
  });
});

describe('Wallet — invariantes de saldo', () => {
  test('TST-012 rejeita débito que produziria saldo negativo e não altera estado', () => {
    const wallet = openWallet('10.00');

    expect(() => wallet.debit(movement(brl('20.00')))).toThrow(InsufficientFundsError);
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
    expect(wallet.updatedAt).toEqual(AT);
  });

  test('débito exatamente igual ao saldo é permitido e zera a wallet', () => {
    const wallet = openWallet('10.00');

    wallet.debit(movement(brl('10.00')));

    expect(wallet.balance.toString()).toBe('0.00');
  });

  test('TST-013 rejeita operação em moeda diferente da wallet', () => {
    const wallet = openWallet('1000.00');
    const dollar = Money.from({ amount: '10.00', currency: 'USD' });

    expect(() => wallet.credit(movement(dollar))).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(movement(dollar))).toThrow(CurrencyMismatchError);
    expect(wallet.balance.toString()).toBe('1000.00');
    expect(wallet.version).toBe(1);
  });

  test('movimento anterior à criação da wallet é rejeitado', () => {
    const wallet = openWallet('1000.00');
    const before = new Date(AT.getTime() - 1);

    expect(() =>
      wallet.debit({ entryId: 'e', transactionId: 't', money: brl('1.00'), at: before }),
    ).toThrow(InvalidTimestampError);
    expect(wallet.updatedAt).toEqual(AT);
    expect(wallet.version).toBe(1);
  });

  test('movimento de valor zero é rejeitado', () => {
    const wallet = openWallet('1000.00');

    expect(() => wallet.credit(movement(Money.zero('BRL')))).toThrow(InvalidLedgerEntryError);
    expect(() => wallet.debit(movement(Money.zero('BRL')))).toThrow(InvalidLedgerEntryError);
  });
});

describe('Wallet — version e lançamentos', () => {
  test('TST-014 version incrementa somente quando o saldo muda', () => {
    const wallet = openWallet('1000.00');
    expect(wallet.version).toBe(1);

    wallet.debit(movement(brl('25.00')));
    expect(wallet.version).toBe(2);

    expect(wallet.canDebit(brl('1.00'))).toBe(true);
    expect(() => wallet.debit(movement(brl('999999.00')))).toThrow(InsufficientFundsError);
    expect(wallet.version).toBe(2);

    wallet.credit(movement(brl('25.00')));
    expect(wallet.version).toBe(3);
  });

  test('TST-058 débito gera exatamente um lançamento DEBIT coerente', () => {
    const wallet = openWallet('1000.00');

    const entry = wallet.debit(movement(brl('25.00')));

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.money.toString()).toBe('25.00');
    expect(entry.balanceBefore.toString()).toBe('1000.00');
    expect(entry.balanceAfter.toString()).toBe('975.00');
    expect(entry.isBalanced()).toBe(true);
    expect(wallet.balance.toString()).toBe('975.00');
  });

  test('TST-059 crédito gera exatamente um lançamento CREDIT coerente', () => {
    const wallet = openWallet('1000.00');

    const entry = wallet.credit(movement(brl('50.00')));

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.balanceBefore.toString()).toBe('1000.00');
    expect(entry.balanceAfter.toString()).toBe('1050.00');
    expect(entry.isBalanced()).toBe(true);
    expect(wallet.balance.toString()).toBe('1050.00');
  });

  test('o saldo reconstruído pelos lançamentos bate com o saldo materializado', () => {
    const { wallet, openingEntry } = openingOf('100.00');
    const entries = [
      openingEntry!,
      wallet.debit(movement(brl('30.00'))),
      wallet.credit(movement(brl('12.50'))),
      wallet.debit(movement(brl('2.50'))),
    ];

    const reconstructed = entries.reduce(
      (total, entry) =>
        entry.direction === LedgerDirection.Credit
          ? total.add(entry.money)
          : total.subtract(entry.money),
      Money.zero('BRL'),
    );

    expect(reconstructed.equals(wallet.balance)).toBe(true);
    expect(wallet.balance.toString()).toBe('80.00');
  });

  test('rehydrate reconstrói o estado persistido sem revalidar transição', () => {
    const wallet = Wallet.rehydrate({
      id: 'wallet-1',
      playerId: 'player-1',
      currency: 'BRL',
      balance: brl('42.00'),
      version: 7,
      createdAt: AT,
      updatedAt: AT,
    });

    expect(wallet.balance.toString()).toBe('42.00');
    expect(wallet.version).toBe(7);
  });
});
