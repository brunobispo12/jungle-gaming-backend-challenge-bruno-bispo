import { Money } from '@/domain/money';
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from '@/domain/wager-transaction';
import type { FailureCode } from '@/domain/failure-code';
import { Wallet } from '@/domain/wallet';
import {
  WalletLedgerEntry,
  type LedgerDirection,
} from '@/domain/wallet-ledger-entry';
import type { WagerTransactionRow, WalletLedgerEntryRow, WalletRow } from './rows';

export function toWallet(row: WalletRow): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: Money.from({ amount: row.balance, currency: row.currency }),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function toWalletRow(wallet: Wallet): WalletRow {
  return {
    id: wallet.id,
    playerId: wallet.playerId,
    currency: wallet.currency,
    balance: wallet.balance.toString(),
    version: wallet.version,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}

export function toWagerTransaction(row: WagerTransactionRow): WagerTransaction {
  const resultBalance =
    row.resultBalanceAmount !== null && row.resultBalanceCurrency !== null
      ? Money.from({ amount: row.resultBalanceAmount, currency: row.resultBalanceCurrency })
      : undefined;

  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: Money.from({ amount: row.amount, currency: row.currency }),
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: (row.failureCode as FailureCode | null) ?? undefined,
    resultBalance,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    expiresAt: row.expiresAt ?? undefined,
    processedAt: row.processedAt ?? undefined,
  });
}

export function toWagerTransactionRow(transaction: WagerTransaction): WagerTransactionRow {
  return {
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    idempotencyKey: transaction.idempotencyKey,
    payloadHash: transaction.payloadHash,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    amount: transaction.money.toString(),
    currency: transaction.money.currency,
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    resultBalanceAmount: transaction.resultBalance?.toString() ?? null,
    resultBalanceCurrency: transaction.resultBalance?.currency ?? null,
    attempts: transaction.attempts,
    nextAttemptAt: transaction.nextAttemptAt ?? null,
    expiresAt: transaction.expiresAt ?? null,
    correlationId: transaction.correlationId,
    createdAt: transaction.createdAt,
    processedAt: transaction.processedAt ?? null,
  };
}

export function toLedgerEntryRow(entry: WalletLedgerEntry): WalletLedgerEntryRow {
  return {
    id: entry.id,
    walletId: entry.walletId,
    transactionId: entry.transactionId,
    direction: entry.direction,
    amount: entry.money.toString(),
    currency: entry.money.currency,
    balanceBefore: entry.balanceBefore.toString(),
    balanceAfter: entry.balanceAfter.toString(),
    createdAt: entry.createdAt,
  };
}

export function toLedgerEntry(row: WalletLedgerEntryRow): WalletLedgerEntry {
  const money = (amount: string): Money => Money.from({ amount, currency: row.currency });

  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction as LedgerDirection,
    money: money(row.amount),
    balanceBefore: money(row.balanceBefore),
    balanceAfter: money(row.balanceAfter),
    createdAt: row.createdAt,
  });
}
