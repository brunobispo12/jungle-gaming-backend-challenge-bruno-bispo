import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
  InvalidTimestampError,
} from './domain-error';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  readonly id: string;
  readonly playerId: string;
  readonly currency: string;
  readonly balance: Money;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MovementProps {
  readonly entryId: string;
  readonly transactionId: string;
  readonly money: Money;
  readonly at: Date;
}

export interface WalletOpening {
  readonly wallet: Wallet;
  readonly openingEntry: WalletLedgerEntry | undefined;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    at: Date;
    openingEntryId: string;
    openingTransactionId: string;
  }): WalletOpening {
    if (props.initialBalance.isNegative()) {
      throw new InsufficientFundsError('0.00', props.initialBalance.toString());
    }

    const wallet = new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.at,
      props.at,
    );

    if (!props.initialBalance.isPositive()) {
      return { wallet, openingEntry: undefined };
    }

    return {
      wallet,
      openingEntry: WalletLedgerEntry.create({
        id: props.openingEntryId,
        walletId: wallet.id,
        transactionId: props.openingTransactionId,
        direction: LedgerDirection.Credit,
        money: props.initialBalance,
        balanceBefore: Money.zero(wallet.currency),
        balanceAfter: props.initialBalance,
        createdAt: props.at,
      }),
    };
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  canDebit(money: Money): boolean {
    this.assertSameCurrency(money);
    return !this._balance.isLessThan(money);
  }

  debit(props: MovementProps): WalletLedgerEntry {
    this.assertMovement(props);
    if (!this.canDebit(props.money)) {
      throw new InsufficientFundsError(this._balance.toString(), props.money.toString());
    }

    return this.apply(LedgerDirection.Debit, this._balance.subtract(props.money), props);
  }

  credit(props: MovementProps): WalletLedgerEntry {
    this.assertMovement(props);
    return this.apply(LedgerDirection.Credit, this._balance.add(props.money), props);
  }

  private apply(
    direction: LedgerDirection,
    balanceAfter: Money,
    props: MovementProps,
  ): WalletLedgerEntry {
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      walletId: this.id,
      transactionId: props.transactionId,
      direction,
      money: props.money,
      balanceBefore: this._balance,
      balanceAfter,
      createdAt: props.at,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = props.at;

    return entry;
  }

  private assertMovement(props: MovementProps): void {
    this.assertSameCurrency(props.money);
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError(`movement requires a positive amount: ${props.money}`);
    }
    if (props.at.getTime() < this.createdAt.getTime()) {
      throw new InvalidTimestampError(props.at, this.createdAt);
    }
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}
