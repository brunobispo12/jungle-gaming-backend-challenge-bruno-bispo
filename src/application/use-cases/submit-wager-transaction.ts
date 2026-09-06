import { ApplicationError, ErrorCode } from '@/application/errors';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '@/application/events/wager-events';
import type { EventContext, IntegrationEvent } from '@/application/events/integration-event';
import { payloadHashOf } from '@/application/idempotency/payload-hash';
import {
  NOOP_METRICS,
  type Clock,
  type IdGenerator,
  type MetricsPort,
  type Repositories,
  type UnitOfWork,
} from '@/application/ports';
import { FailureCode } from '@/domain/failure-code';
import { Money, type MoneyProps } from '@/domain/money';
import { referenceIsSettled, reversalFailure, winReferenceFailure } from '@/domain/reference';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@/domain/wager-transaction';
import type { Wallet } from '@/domain/wallet';
import { LedgerDirection, type WalletLedgerEntry } from '@/domain/wallet-ledger-entry';

const PENDING_REFERENCE_TTL_MS = 6 * 60 * 60 * 1000;
const FIRST_RETRY_DELAY_MS = 5_000;

export interface SubmitWagerCommand {
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly playerId: string;
  readonly walletId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: MoneyProps;
  readonly referenceExternalTransactionId?: string | undefined;
  readonly correlationId: string;
  readonly causationId?: string | undefined;
}

export interface SubmitWagerResult {
  readonly transactionId: string;
  readonly status: WagerTransactionStatus;
  readonly balance?: MoneyProps | undefined;
  readonly failureCode?: FailureCode | undefined;
  readonly idempotentReplay: boolean;
}

export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: MetricsPort = NOOP_METRICS,
  ) {}

  async execute(command: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const startedAt = performance.now();
    try {
      const result = await this.unitOfWork.transactional((repositories) =>
        this.executeWithin(repositories, command),
      );
      this.metrics.observeWager({
        source: 'http',
        kind: command.kind,
        outcome: result.status,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
        durationSeconds: (performance.now() - startedAt) / 1_000,
      });
      return result;
    } catch (error: unknown) {
      this.metrics.observeWager({
        source: 'http',
        kind: command.kind,
        outcome: 'error',
        durationSeconds: (performance.now() - startedAt) / 1_000,
      });
      throw error;
    }
  }

  // The SQS consumer runs this inside its own transaction so the inbox row, the
  // financial change, the ledger and the outbox commit or roll back together.
  async executeWithin(
    repositories: Repositories,
    command: SubmitWagerCommand,
  ): Promise<SubmitWagerResult> {
    const money = Money.from(command.money);
    if (!money.isPositive()) {
      throw new ApplicationError(ErrorCode.AmountNotPositive, 'amount must be greater than zero');
    }

    const payloadHash = payloadHashOf({ ...command, money });
    const now = this.clock.now();

    const reserved = WagerTransaction.create({
      ...command,
      id: this.ids.next(),
      payloadHash,
      money,
      createdAt: now,
    });

    const owned = await repositories.wagerTransactions.reserve(reserved);
    if (!owned) {
      return this.resolveExisting(repositories, command, payloadHash);
    }

    return this.apply(repositories, owned, command, now);
  }

  private async resolveExisting(
    repositories: Repositories,
    command: SubmitWagerCommand,
    payloadHash: string,
  ): Promise<SubmitWagerResult> {
    const byKey = await repositories.wagerTransactions.findByIdempotencyKey(
      command.providerId,
      command.idempotencyKey,
    );

    if (byKey) {
      if (!byKey.matchesPayload(payloadHash)) {
        throw new ApplicationError(
          ErrorCode.IdempotencyKeyConflict,
          'the idempotency key was already used with a different payload',
          { existingTransactionId: byKey.id },
        );
      }
      return replayOf(byKey);
    }

    const byExternal = await repositories.wagerTransactions.findByExternalId(
      command.providerId,
      command.externalTransactionId,
    );
    if (byExternal) {
      throw new ApplicationError(
        ErrorCode.ExternalTransactionIdReused,
        'externalTransactionId already belongs to another idempotency key',
        { existingTransactionId: byExternal.id },
      );
    }

    throw new ApplicationError(
      ErrorCode.ServiceUnavailable,
      'identity reservation lost a race with no visible owner',
    );
  }

  private async apply(
    repositories: Repositories,
    transaction: WagerTransaction,
    command: SubmitWagerCommand,
    now: Date,
  ): Promise<SubmitWagerResult> {
    const context: EventContext = {
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      causationId: command.causationId,
      occurredAt: now,
    };

    const wallet = await repositories.wallets.lockById(command.walletId);
    if (!wallet) {
      return this.reject(repositories, transaction, FailureCode.WalletNotFound, undefined, now, context);
    }
    if (wallet.playerId !== command.playerId) {
      return this.reject(repositories, transaction, FailureCode.WalletPlayerMismatch, undefined, now, context);
    }
    if (wallet.currency !== transaction.money.currency) {
      return this.reject(repositories, transaction, FailureCode.CurrencyMismatch, wallet.balance, now, context);
    }

    if (transaction.requiresReference()) {
      return this.applyReversal(repositories, transaction, wallet, now, context);
    }

    if (!transaction.affectsBalance()) {
      return this.process(repositories, transaction, wallet, undefined, now, context);
    }

    const link = await this.resolveOptionalReference(repositories, transaction);
    if (link.failure) {
      return this.reject(repositories, transaction, link.failure, wallet.balance, now, context);
    }

    const direction = transaction.ledgerDirectionFor();
    if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
      return this.reject(
        repositories,
        transaction,
        transaction.overdraftFailureCode(),
        wallet.balance,
        now,
        context,
      );
    }

    const entry = this.move(wallet, transaction, direction, now);
    return this.process(repositories, transaction, wallet, entry, now, context, link.referenceId);
  }

  // A WIN may carry the BET of its round. The link is optional, so an unresolved
  // identifier still processes; a resolved one is validated like any other.
  private async resolveOptionalReference(
    repositories: Repositories,
    transaction: WagerTransaction,
  ): Promise<{ referenceId?: string | undefined; failure?: FailureCode | undefined }> {
    const external = transaction.referenceExternalTransactionId;
    if (transaction.kind !== WagerTransactionKind.Win || external === undefined) {
      return {};
    }

    const reference = await repositories.wagerTransactions.findByExternalId(
      transaction.providerId,
      external,
    );
    if (!reference || !isDecidable(transaction, reference)) {
      return {};
    }

    const failure = winReferenceFailure(transaction, reference);
    return failure ? { failure } : { referenceId: reference.id };
  }

  private async applyReversal(
    repositories: Repositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    now: Date,
    context: EventContext,
  ): Promise<SubmitWagerResult> {
    const reference = await repositories.wagerTransactions.findByExternalId(
      transaction.providerId,
      transaction.referenceExternalTransactionId ?? '',
    );

    if (!reference || !isDecidable(transaction, reference)) {
      transaction.markPendingReference({
        resultBalance: wallet.balance,
        nextAttemptAt: new Date(now.getTime() + FIRST_RETRY_DELAY_MS),
        expiresAt: new Date(now.getTime() + PENDING_REFERENCE_TTL_MS),
      });
      await repositories.wagerTransactions.update(transaction);
      await repositories.outbox.enqueue(
        [WagerTransactionPendingReference.from(transaction, context)],
        now,
      );
      return resultOf(transaction, false);
    }

    return this.applyResolvedReversal(repositories, transaction, reference, wallet, now, context);
  }

  // Shared with the pending reference worker: a reversal whose reference shows up
  // later must be decided by exactly these rules, never by a second copy of them.
  async applyResolvedReversal(
    repositories: Repositories,
    transaction: WagerTransaction,
    reference: WagerTransaction,
    wallet: Wallet,
    now: Date,
    context: EventContext,
  ): Promise<SubmitWagerResult> {
    const failure = reversalFailure(transaction, reference);
    if (failure) {
      return this.reject(repositories, transaction, failure, wallet.balance, now, context);
    }

    // Any kind: a BET reversed by REFUND and ROLLBACK is credited twice (§7.4).
    const alreadyReversed = await repositories.wagerTransactions.hasActiveReversal(reference.id);
    if (alreadyReversed) {
      return this.reject(
        repositories,
        transaction,
        FailureCode.ReferenceAlreadyReversed,
        wallet.balance,
        now,
        context,
      );
    }

    const direction = transaction.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
      return this.reject(
        repositories,
        transaction,
        transaction.overdraftFailureCode(),
        wallet.balance,
        now,
        context,
      );
    }

    const entry = this.move(wallet, transaction, direction, now);
    return this.process(repositories, transaction, wallet, entry, now, context, reference.id);
  }

  private move(
    wallet: Wallet,
    transaction: WagerTransaction,
    direction: LedgerDirection,
    now: Date,
  ): WalletLedgerEntry {
    const movement = {
      entryId: this.ids.next(),
      transactionId: transaction.id,
      money: transaction.money,
      at: now,
    };

    return direction === LedgerDirection.Credit ? wallet.credit(movement) : wallet.debit(movement);
  }

  private async process(
    repositories: Repositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    entry: WalletLedgerEntry | undefined,
    now: Date,
    context: EventContext,
    referenceTransactionId?: string,
  ): Promise<SubmitWagerResult> {
    transaction.markProcessed({ referenceTransactionId, resultBalance: wallet.balance, at: now });
    await repositories.wagerTransactions.update(transaction);

    const events: IntegrationEvent<unknown>[] = [
      WagerTransactionProcessed.from(transaction, context),
    ];

    if (entry) {
      await repositories.ledger.insert(entry);
      await repositories.wallets.update(wallet);
      events.push(
        WalletBalanceChanged.from(wallet, entry, {
          ...context,
          eventId: this.ids.next(),
          causationId: transaction.id,
        }),
      );
    }

    await repositories.outbox.enqueue(events, now);
    return resultOf(transaction, false);
  }

  private async reject(
    repositories: Repositories,
    transaction: WagerTransaction,
    code: FailureCode,
    resultBalance: Money | undefined,
    now: Date,
    context: EventContext,
  ): Promise<SubmitWagerResult> {
    transaction.reject({ code, resultBalance, at: now });
    await repositories.wagerTransactions.update(transaction);
    await repositories.outbox.enqueue([WagerTransactionRejected.from(transaction, context)], now);
    return resultOf(transaction, false);
  }
}

// A transaction pointing at itself never settles: waiting would wait forever.
function isDecidable(transaction: WagerTransaction, reference: WagerTransaction): boolean {
  return reference.id === transaction.id || referenceIsSettled(reference);
}

function resultOf(transaction: WagerTransaction, idempotentReplay: boolean): SubmitWagerResult {
  return {
    transactionId: transaction.id,
    status: transaction.status,
    balance: transaction.resultBalance?.toJSON(),
    failureCode: transaction.failureCode,
    idempotentReplay,
  };
}

function replayOf(transaction: WagerTransaction): SubmitWagerResult {
  return resultOf(transaction, true);
}
