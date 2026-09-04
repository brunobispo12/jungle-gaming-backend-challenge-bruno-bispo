import { describe, expect, test } from 'bun:test';

import { InvalidTransactionStateError, InvalidWagerTransactionError } from '@/domain/domain-error';
import { FailureCode } from '@/domain/failure-code';
import { Money } from '@/domain/money';
import { reversalFailure } from '@/domain/reversal';
import { LedgerDirection, type WalletLedgerEntry } from '@/domain/wallet-ledger-entry';
import { Wallet } from '@/domain/wallet';
import {
  INTERNAL_PROVIDER_ID,
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  openingIdentity,
  type CreateWagerTransactionProps,
} from '@/domain/wager-transaction';

const AT = new Date('2026-07-29T15:00:00.000Z');
const brl = (amount: string): Money => Money.from({ amount, currency: 'BRL' });

function props(overrides: Partial<CreateWagerTransactionProps> = {}): CreateWagerTransactionProps {
  return {
    id: 'transaction-1',
    providerId: 'provider-a',
    externalTransactionId: 'transaction-123',
    idempotencyKey: 'provider-a:transaction-123',
    payloadHash: 'a'.repeat(64),
    walletId: 'wallet-1',
    playerId: 'player-1',
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: brl('25.00'),
    correlationId: 'correlation-1',
    createdAt: AT,
    ...overrides,
  };
}

const bet = (overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction =>
  WagerTransaction.create(props(overrides));

const opening = (): WagerTransaction =>
  WagerTransaction.createOpening({
    id: 'opening-1',
    walletId: 'wallet-1',
    playerId: 'player-1',
    money: brl('1000.00'),
    payloadHash: 'a'.repeat(64),
    correlationId: 'correlation-1',
    createdAt: AT,
  });

function processed(overrides: Partial<CreateWagerTransactionProps> = {}): WagerTransaction {
  const transaction = WagerTransaction.create(props(overrides));
  transaction.markProcessed({ resultBalance: brl('975.00'), at: AT });
  return transaction;
}

describe('WagerTransaction — criação', () => {
  test('nasce em PENDING', () => {
    expect(bet().status).toBe(WagerTransactionStatus.Pending);
  });

  test('OPENING não pode ser submetido por API nem por fila', () => {
    expect(() => bet({ kind: WagerTransactionKind.Opening })).toThrow(InvalidWagerTransactionError);
    expect(() => opening()).not.toThrow();
  });

  test('o provider reservado é recusado na entrada externa', () => {
    expect(() => bet({ providerId: INTERNAL_PROVIDER_ID })).toThrow(InvalidWagerTransactionError);
  });

  test('createOpening deriva a identidade interna e não aceita uma de fora', () => {
    const transaction = opening();

    expect(transaction.kind).toBe(WagerTransactionKind.Opening);
    expect(transaction.providerId).toBe(INTERNAL_PROVIDER_ID);
    expect(transaction.externalTransactionId).toBe('opening:wallet-1');
    expect(transaction.idempotencyKey).toBe('internal:opening:wallet-1');
    expect(transaction.roundId).toBe(INTERNAL_PROVIDER_ID);
    expect(transaction.gameId).toBe(INTERNAL_PROVIDER_ID);
    expect(transaction.requiresReference()).toBe(false);
  });

  test('a identidade do OPENING é única por wallet', () => {
    expect(openingIdentity('wallet-1')).not.toEqual(openingIdentity('wallet-2'));
  });

  test.each([[WagerTransactionKind.Refund], [WagerTransactionKind.Rollback]])(
    '%s exige referenceExternalTransactionId',
    (kind) => {
      expect(() => bet({ kind })).toThrow(InvalidWagerTransactionError);
      expect(() => bet({ kind, referenceExternalTransactionId: 'transaction-123' })).not.toThrow();
    },
  );

  test('valor zero é recusado na criação', () => {
    expect(() => bet({ money: Money.zero('BRL') })).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction — consultas de domínio', () => {
  test('affectsBalance é falso apenas para LOSS', () => {
    expect(bet({ kind: WagerTransactionKind.Loss }).affectsBalance()).toBe(false);
    expect(bet({ kind: WagerTransactionKind.Bet }).affectsBalance()).toBe(true);
    expect(bet({ kind: WagerTransactionKind.Win }).affectsBalance()).toBe(true);
  });

  test('requiresReference é verdadeiro apenas para REFUND e ROLLBACK', () => {
    const reference = { referenceExternalTransactionId: 'transaction-123' };

    expect(bet({ kind: WagerTransactionKind.Refund, ...reference }).requiresReference()).toBe(true);
    expect(bet({ kind: WagerTransactionKind.Rollback, ...reference }).requiresReference()).toBe(true);
    expect(bet({ kind: WagerTransactionKind.Bet }).requiresReference()).toBe(false);
    expect(bet({ kind: WagerTransactionKind.Win }).requiresReference()).toBe(false);
    expect(bet({ kind: WagerTransactionKind.Loss }).requiresReference()).toBe(false);
  });

  test('matchesPayload distingue replay de conflito', () => {
    const transaction = bet();

    expect(transaction.matchesPayload('a'.repeat(64))).toBe(true);
    expect(transaction.matchesPayload('b'.repeat(64))).toBe(false);
  });

  test('TST-019 o código de saldo da reversão é distinto do de aposta sem saldo', () => {
    const wager = bet({ kind: WagerTransactionKind.Bet });
    const rollback = bet({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'transaction-123',
    });

    expect(wager.overdraftFailureCode()).toBe(FailureCode.InsufficientFunds);
    expect(rollback.overdraftFailureCode()).toBe(FailureCode.ReversalWouldOverdraw);
    expect(wager.overdraftFailureCode()).not.toBe(rollback.overdraftFailureCode());
  });
});

describe('WagerTransaction — direção do lançamento', () => {
  test('kinds com direção fixa', () => {
    expect(bet({ kind: WagerTransactionKind.Bet }).ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(bet({ kind: WagerTransactionKind.Win }).ledgerDirectionFor()).toBe(
      LedgerDirection.Credit,
    );
    expect(opening().ledgerDirectionFor()).toBe(LedgerDirection.Credit);
  });

  test('TST-016 LOSS não tem direção porque não gera lançamento', () => {
    expect(() => bet({ kind: WagerTransactionKind.Loss }).ledgerDirectionFor()).toThrow(
      InvalidWagerTransactionError,
    );
  });

  test('TST-061 ROLLBACK inverte a direção da referência', () => {
    const rollback = bet({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'transaction-123',
    });

    const referenceBet = processed({ kind: WagerTransactionKind.Bet });
    const referenceWin = processed({ kind: WagerTransactionKind.Win });

    expect(rollback.ledgerDirectionFor(referenceBet)).toBe(LedgerDirection.Credit);
    expect(rollback.ledgerDirectionFor(referenceWin)).toBe(LedgerDirection.Debit);
  });

  test('ROLLBACK sem referência não decide direção', () => {
    const rollback = bet({
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: 'transaction-123',
    });

    expect(() => rollback.ledgerDirectionFor()).toThrow(InvalidWagerTransactionError);
  });
});

describe('WagerTransaction — state machine', () => {
  test('PENDING vai para PROCESSED, REJECTED ou PENDING_REFERENCE', () => {
    expect(() => bet().markProcessed({ resultBalance: brl('975.00'), at: AT })).not.toThrow();
    expect(() =>
      bet().reject({ code: FailureCode.InsufficientFunds, resultBalance: brl('10.00'), at: AT }),
    ).not.toThrow();
    expect(() =>
      bet({
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: 'transaction-123',
      }).markPendingReference({
        resultBalance: brl('10.00'),
        nextAttemptAt: AT,
        expiresAt: AT,
      }),
    ).not.toThrow();
  });

  test('PENDING_REFERENCE é exclusivo de REFUND e ROLLBACK', () => {
    expect(() =>
      bet().markPendingReference({ resultBalance: brl('10.00'), nextAttemptAt: AT, expiresAt: AT }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('FAILED só nasce de PENDING_REFERENCE', () => {
    expect(() => bet().fail({ resultBalance: brl('10.00'), at: AT })).toThrow(
      InvalidTransactionStateError,
    );

    const pending = bet({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'transaction-123',
    });
    pending.markPendingReference({ resultBalance: brl('10.00'), nextAttemptAt: AT, expiresAt: AT });

    expect(() => pending.fail({ resultBalance: brl('10.00'), at: AT })).not.toThrow();
    expect(pending.failureCode).toBe(FailureCode.InfrastructureFailure);
  });

  test.each([
    ['PROCESSED', (t: WagerTransaction) => t.markProcessed({ resultBalance: brl('1.00'), at: AT })],
    [
      'REJECTED',
      (t: WagerTransaction) =>
        t.reject({ code: FailureCode.InsufficientFunds, resultBalance: brl('1.00'), at: AT }),
    ],
  ])('%s é terminal e recusa nova transição', (_label, terminalize) => {
    const transaction = bet();
    terminalize(transaction);

    expect(transaction.isTerminal()).toBe(true);
    expect(() => transaction.markProcessed({ resultBalance: brl('1.00'), at: AT })).toThrow(
      InvalidTransactionStateError,
    );
    expect(() =>
      transaction.reject({ code: FailureCode.ReferenceMismatch, resultBalance: brl('1.00'), at: AT }),
    ).toThrow(InvalidTransactionStateError);
    expect(() => transaction.fail({ resultBalance: brl('1.00'), at: AT })).toThrow(
      InvalidTransactionStateError,
    );
  });

  test('INFRASTRUCTURE_FAILURE não é rejeição de negócio', () => {
    expect(() =>
      bet().reject({ code: FailureCode.InfrastructureFailure, resultBalance: brl('1.00'), at: AT }),
    ).toThrow(InvalidWagerTransactionError);
  });

  test('processedAt é gravado nos três estados terminais', () => {
    const done = bet();
    done.markProcessed({ resultBalance: brl('975.00'), at: AT });
    expect(done.processedAt).toEqual(AT);

    const rejected = bet();
    rejected.reject({ code: FailureCode.InsufficientFunds, resultBalance: brl('1.00'), at: AT });
    expect(rejected.processedAt).toEqual(AT);
  });

  test('scheduleRetry incrementa attempts apenas em PENDING_REFERENCE', () => {
    const refund = bet({
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: 'transaction-123',
    });

    expect(() => refund.scheduleRetry({ nextAttemptAt: AT })).toThrow(InvalidTransactionStateError);

    refund.markPendingReference({ resultBalance: brl('10.00'), nextAttemptAt: AT, expiresAt: AT });
    refund.scheduleRetry({ nextAttemptAt: new Date('2026-07-29T15:00:05.000Z') });

    expect(refund.attempts).toBe(1);
  });

  test('rehydrate reconstrói estado terminal sem revalidar transição', () => {
    const transaction = WagerTransaction.rehydrate({
      ...props({ kind: WagerTransactionKind.Refund, referenceExternalTransactionId: 'external-1' }),
      status: WagerTransactionStatus.Processed,
      referenceTransactionId: 'transaction-0',
      resultBalance: brl('50.00'),
      attempts: 3,
      processedAt: AT,
    });

    expect(transaction.status).toBe(WagerTransactionStatus.Processed);
    expect(transaction.attempts).toBe(3);
    expect(transaction.isTerminal()).toBe(true);
  });
});

describe('Reversões — validação da referência', () => {
  const reversal = (kind: typeof WagerTransactionKind.Refund | typeof WagerTransactionKind.Rollback, money = '25.00') =>
    bet({ kind, money: brl(money), referenceExternalTransactionId: 'transaction-123' });

  test('REFUND de BET PROCESSED com mesmo valor é aceito', () => {
    expect(reversalFailure(reversal(WagerTransactionKind.Refund), processed())).toBeUndefined();
  });

  test('TST-018 REFUND de WIN é rejeitado por tipo de referência', () => {
    const reference = processed({ kind: WagerTransactionKind.Win });

    expect(reversalFailure(reversal(WagerTransactionKind.Refund), reference)).toBe(
      FailureCode.ReferenceKindNotReversible,
    );
  });

  test('ROLLBACK aceita BET, WIN e REFUND, e recusa LOSS e ROLLBACK', () => {
    const rollback = reversal(WagerTransactionKind.Rollback);

    for (const kind of [
      WagerTransactionKind.Bet,
      WagerTransactionKind.Win,
      WagerTransactionKind.Refund,
    ]) {
      const reference = processed({
        kind,
        ...(kind === WagerTransactionKind.Refund
          ? { referenceExternalTransactionId: 'transaction-0' }
          : {}),
      });
      expect(reversalFailure(rollback, reference)).toBeUndefined();
    }

    expect(reversalFailure(rollback, processed({ kind: WagerTransactionKind.Loss }))).toBe(
      FailureCode.ReferenceKindNotReversible,
    );
  });

  test('TST-017 valor diferente da referência é rejeitado', () => {
    expect(reversalFailure(reversal(WagerTransactionKind.Refund, '10.00'), processed())).toBe(
      FailureCode.ReversalAmountMismatch,
    );
  });

  test('referência que não está em PROCESSED é rejeitada', () => {
    expect(reversalFailure(reversal(WagerTransactionKind.Refund), bet())).toBe(
      FailureCode.ReferenceNotProcessed,
    );
  });

  test.each([
    ['provider', { providerId: 'provider-b' }],
    ['player', { playerId: 'player-2' }],
    ['wallet', { walletId: 'wallet-2' }],
    ['rodada', { roundId: 'round-000' }],
  ])('referência divergente em %s é rejeitada', (_label, overrides) => {
    const reference = processed({ ...overrides, externalTransactionId: 'transaction-999' });

    expect(reversalFailure(reversal(WagerTransactionKind.Refund), reference)).toBe(
      FailureCode.ReferenceMismatch,
    );
  });

  test('referência em outra moeda é rejeitada antes da comparação de valor', () => {
    const reference = processed({ money: Money.from({ amount: '25.00', currency: 'USD' }) });

    expect(reversalFailure(reversal(WagerTransactionKind.Refund), reference)).toBe(
      FailureCode.CurrencyMismatch,
    );
  });
});

describe('Reversões — efeito aplicado na wallet', () => {
  const openWallet = (balance: string): Wallet =>
    Wallet.open({
      id: 'wallet-1',
      playerId: 'player-1',
      initialBalance: brl(balance),
      at: AT,
      openingEntryId: 'entry-0',
      openingTransactionId: 'opening-1',
    }).wallet;

  const apply = (
    wallet: Wallet,
    transaction: WagerTransaction,
    reference: WagerTransaction,
  ): WalletLedgerEntry => {
    const movement = { entryId: 'entry-1', transactionId: transaction.id, money: transaction.money, at: AT };
    return transaction.ledgerDirectionFor(reference) === LedgerDirection.Credit
      ? wallet.credit(movement)
      : wallet.debit(movement);
  };

  test('TST-060 REFUND devolve à wallet exatamente o valor da BET, com um lançamento CREDIT', () => {
    const wallet = openWallet('75.00');
    const referencedBet = processed({ kind: WagerTransactionKind.Bet, money: brl('25.00') });
    const refund = bet({
      kind: WagerTransactionKind.Refund,
      money: brl('25.00'),
      referenceExternalTransactionId: 'transaction-123',
    });

    expect(reversalFailure(refund, referencedBet)).toBeUndefined();
    const entry = apply(wallet, refund, referencedBet);

    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.money.equals(referencedBet.money)).toBe(true);
    expect(wallet.balance.toString()).toBe('100.00');
    expect(entry.isBalanced()).toBe(true);
  });

  test('TST-061 ROLLBACK de WIN debita a wallet com o lançamento inverso ao da referência', () => {
    const wallet = openWallet('50.00');
    const referencedWin = processed({ kind: WagerTransactionKind.Win, money: brl('50.00') });
    const rollback = bet({
      kind: WagerTransactionKind.Rollback,
      money: brl('50.00'),
      referenceExternalTransactionId: 'transaction-123',
    });

    expect(reversalFailure(rollback, referencedWin)).toBeUndefined();
    const entry = apply(wallet, rollback, referencedWin);

    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(referencedWin.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(wallet.balance.toString()).toBe('0.00');
  });

  test('TST-019 ROLLBACK de WIN sobre saldo já gasto não é aplicado, e o código difere do de BET', () => {
    const wallet = openWallet('10.00');
    const referencedWin = processed({ kind: WagerTransactionKind.Win, money: brl('50.00') });
    const rollback = bet({
      kind: WagerTransactionKind.Rollback,
      money: brl('50.00'),
      referenceExternalTransactionId: 'transaction-123',
    });

    expect(reversalFailure(rollback, referencedWin)).toBeUndefined();
    expect(wallet.canDebit(rollback.money)).toBe(false);
    expect(rollback.overdraftFailureCode()).toBe(FailureCode.ReversalWouldOverdraw);

    rollback.reject({
      code: rollback.overdraftFailureCode(),
      resultBalance: wallet.balance,
      at: AT,
    });

    expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
    expect(rollback.failureCode).toBe(FailureCode.ReversalWouldOverdraw);
    expect(wallet.balance.toString()).toBe('10.00');
    expect(wallet.version).toBe(1);
  });
});
