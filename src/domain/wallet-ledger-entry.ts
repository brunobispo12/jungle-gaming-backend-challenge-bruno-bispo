import { InvalidLedgerEntryError } from './domain-error';
import { Money } from './money';

export const LedgerDirection = {
  Debit: 'DEBIT',
  Credit: 'CREDIT',
} as const;

export type LedgerDirection = (typeof LedgerDirection)[keyof typeof LedgerDirection];

export interface LedgerEntryState {
  readonly id: string;
  readonly walletId: string;
  readonly transactionId: string;
  readonly direction: LedgerDirection;
  readonly money: Money;
  readonly balanceBefore: Money;
  readonly balanceAfter: Money;
  readonly createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: LedgerEntryState): WalletLedgerEntry {
    if (!props.money.isPositive()) {
      throw new InvalidLedgerEntryError(`lançamento precisa de valor positivo: ${props.money}`);
    }
    if (props.balanceBefore.isNegative() || props.balanceAfter.isNegative()) {
      throw new InvalidLedgerEntryError('lançamento não pode registrar saldo negativo');
    }

    const entry = WalletLedgerEntry.rehydrate(props);
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError(
        `aritmética inconsistente: ${props.balanceBefore} ${props.direction} ${props.money} não resulta em ${props.balanceAfter}`,
      );
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      state.money,
      state.balanceBefore,
      state.balanceAfter,
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    const expected =
      this.direction === LedgerDirection.Credit
        ? this.balanceBefore.add(this.money)
        : this.balanceBefore.subtract(this.money);

    return expected.equals(this.balanceAfter);
  }
}
