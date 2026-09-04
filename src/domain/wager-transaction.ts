import { InvalidTransactionStateError, InvalidWagerTransactionError } from './domain-error';
import { FailureCode } from './failure-code';
import { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export const WagerTransactionKind = {
  Opening: 'OPENING',
  Bet: 'BET',
  Win: 'WIN',
  Loss: 'LOSS',
  Refund: 'REFUND',
  Rollback: 'ROLLBACK',
} as const;

export type WagerTransactionKind =
  (typeof WagerTransactionKind)[keyof typeof WagerTransactionKind];

export const WagerTransactionStatus = {
  Pending: 'PENDING',
  PendingReference: 'PENDING_REFERENCE',
  Processed: 'PROCESSED',
  Rejected: 'REJECTED',
  Failed: 'FAILED',
} as const;

export type WagerTransactionStatus =
  (typeof WagerTransactionStatus)[keyof typeof WagerTransactionStatus];

const TERMINAL: readonly WagerTransactionStatus[] = [
  WagerTransactionStatus.Processed,
  WagerTransactionStatus.Rejected,
  WagerTransactionStatus.Failed,
];

const REVERSAL_KINDS: readonly WagerTransactionKind[] = [
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
];

export const INTERNAL_PROVIDER_ID = 'internal';

export function openingIdentity(walletId: string): {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  roundId: string;
  gameId: string;
} {
  return {
    providerId: INTERNAL_PROVIDER_ID,
    externalTransactionId: `opening:${walletId}`,
    idempotencyKey: `${INTERNAL_PROVIDER_ID}:opening:${walletId}`,
    roundId: INTERNAL_PROVIDER_ID,
    gameId: INTERNAL_PROVIDER_ID,
  };
}

const REVERSIBLE_BY: Readonly<Record<string, readonly WagerTransactionKind[]>> = {
  [WagerTransactionKind.Refund]: [WagerTransactionKind.Bet],
  [WagerTransactionKind.Rollback]: [
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Refund,
  ],
};

export interface CreateWagerTransactionProps {
  readonly id: string;
  readonly providerId: string;
  readonly externalTransactionId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly walletId: string;
  readonly playerId: string;
  readonly roundId: string;
  readonly gameId: string;
  readonly kind: WagerTransactionKind;
  readonly money: Money;
  readonly referenceExternalTransactionId?: string | undefined;
  readonly correlationId: string;
  readonly createdAt: Date;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  readonly status: WagerTransactionStatus;
  readonly referenceTransactionId?: string | undefined;
  readonly failureCode?: FailureCode | undefined;
  readonly resultBalance?: Money | undefined;
  readonly attempts: number;
  readonly nextAttemptAt?: Date | undefined;
  readonly expiresAt?: Date | undefined;
  readonly processedAt?: Date | undefined;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly correlationId: string,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId: string | undefined,
    private _failureCode: FailureCode | undefined,
    private _resultBalance: Money | undefined,
    private _attempts: number,
    private _nextAttemptAt: Date | undefined,
    private _expiresAt: Date | undefined,
    private _processedAt: Date | undefined,
  ) {}

  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        'OPENING is internal and cannot be submitted through the API or the queue',
      );
    }
    if (props.providerId === INTERNAL_PROVIDER_ID) {
      throw new InvalidWagerTransactionError(
        `${INTERNAL_PROVIDER_ID} is a provider reserved for internal transactions`,
      );
    }
    return WagerTransaction.reserve(props);
  }

  static createOpening(props: {
    id: string;
    walletId: string;
    playerId: string;
    money: Money;
    payloadHash: string;
    correlationId: string;
    createdAt: Date;
  }): WagerTransaction {
    return WagerTransaction.reserve({
      ...props,
      ...openingIdentity(props.walletId),
      kind: WagerTransactionKind.Opening,
    });
  }

  private static reserve(props: CreateWagerTransactionProps): WagerTransaction {
    const requiresReference = REVERSAL_KINDS.includes(props.kind);
    if (requiresReference && !props.referenceExternalTransactionId) {
      throw new InvalidWagerTransactionError(`${props.kind} requires referenceExternalTransactionId`);
    }
    if (!props.money.isPositive()) {
      throw new InvalidWagerTransactionError(`${props.kind} requires an amount greater than zero`);
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      props.correlationId,
      props.createdAt,
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      undefined,
      undefined,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.correlationId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.resultBalance,
      state.attempts,
      state.nextAttemptAt,
      state.expiresAt,
      state.processedAt,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get resultBalance(): Money | undefined {
    return this._resultBalance;
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    return this._nextAttemptAt;
  }

  get expiresAt(): Date | undefined {
    return this._expiresAt;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  markProcessed(props: {
    referenceTransactionId?: string | undefined;
    resultBalance: Money;
    at: Date;
  }): void {
    this.assertTransition(WagerTransactionStatus.Processed);

    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = props.referenceTransactionId;
    this._resultBalance = props.resultBalance;
    this._processedAt = props.at;
  }

  markPendingReference(props: {
    resultBalance: Money;
    nextAttemptAt: Date;
    expiresAt: Date;
  }): void {
    this.assertTransition(WagerTransactionStatus.PendingReference);
    if (!this.requiresReference()) {
      throw new InvalidWagerTransactionError(
        `${this.kind} does not await a reference: PENDING_REFERENCE is exclusive to REFUND and ROLLBACK`,
      );
    }

    this._status = WagerTransactionStatus.PendingReference;
    this._resultBalance = props.resultBalance;
    this._nextAttemptAt = props.nextAttemptAt;
    this._expiresAt = props.expiresAt;
  }

  reject(props: { code: FailureCode; resultBalance?: Money | undefined; at: Date }): void {
    this.assertTransition(WagerTransactionStatus.Rejected);
    if (props.code === FailureCode.InfrastructureFailure) {
      throw new InvalidWagerTransactionError('INFRASTRUCTURE_FAILURE belongs to FAILED');
    }

    const observedWallet = props.code !== FailureCode.WalletNotFound;
    if (observedWallet && !props.resultBalance) {
      throw new InvalidWagerTransactionError(
        `rejection ${props.code} observed the wallet and requires the historical balance`,
      );
    }
    if (!observedWallet && props.resultBalance) {
      throw new InvalidWagerTransactionError(
        'WALLET_NOT_FOUND cannot carry a historical balance: no wallet was observed',
      );
    }

    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = props.code;
    this._resultBalance = props.resultBalance;
    this._processedAt = props.at;
  }

  fail(props: { resultBalance: Money; at: Date }): void {
    this.assertTransition(WagerTransactionStatus.Failed);

    this._status = WagerTransactionStatus.Failed;
    this._failureCode = FailureCode.InfrastructureFailure;
    this._resultBalance = props.resultBalance;
    this._processedAt = props.at;
  }

  scheduleRetry(props: { nextAttemptAt: Date }): void {
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this._status, WagerTransactionStatus.PendingReference);
    }

    this._attempts += 1;
    this._nextAttemptAt = props.nextAttemptAt;
  }

  isTerminal(): boolean {
    return TERMINAL.includes(this._status);
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return REVERSAL_KINDS.includes(this.kind);
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  reversibleKinds(): readonly WagerTransactionKind[] {
    return REVERSIBLE_BY[this.kind] ?? [];
  }

  overdraftFailureCode(): FailureCode {
    return this.requiresReference()
      ? FailureCode.ReversalWouldOverdraw
      : FailureCode.InsufficientFunds;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Loss:
        throw new InvalidWagerTransactionError('LOSS produces no ledger entry');
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidWagerTransactionError('ROLLBACK needs its reference to invert');
        }
        return reference.ledgerDirectionFor() === LedgerDirection.Debit
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;
      }
    }
  }

  private assertTransition(to: WagerTransactionStatus): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(this._status, to);
    }
    if (to === WagerTransactionStatus.Failed && this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(this._status, to);
    }
    if (to === WagerTransactionStatus.PendingReference && this._status !== WagerTransactionStatus.Pending) {
      throw new InvalidTransactionStateError(this._status, to);
    }
  }
}
