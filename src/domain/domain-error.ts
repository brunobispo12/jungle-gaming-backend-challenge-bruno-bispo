export abstract class DomainError extends Error {
  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(
    readonly expected: string,
    readonly received: string,
  ) {
    super(`currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(
    readonly balance: string,
    readonly requested: string,
  ) {
    super(`insufficient funds: available ${balance}, requested ${requested}`);
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`invalid transition: ${from} to ${to}`);
  }
}

export class InvalidTimestampError extends DomainError {
  constructor(readonly at: Date) {
    super(`timestamp is not a usable instant: ${at.getTime()}`);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}

export class InvalidWagerTransactionError extends DomainError {
  constructor(message: string) {
    super(message);
  }
}
