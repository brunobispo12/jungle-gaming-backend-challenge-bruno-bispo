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
    super(`moeda incompatível: esperado ${expected}, recebido ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor(
    readonly balance: string,
    readonly requested: string,
  ) {
    super(`saldo insuficiente: disponível ${balance}, solicitado ${requested}`);
  }
}

export class InvalidTransactionStateError extends DomainError {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`transição inválida: ${from} para ${to}`);
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
