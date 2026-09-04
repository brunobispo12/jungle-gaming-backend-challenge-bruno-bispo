import { Decimal } from 'decimal.js';

import { CurrencyMismatchError, InvalidMoneyError } from './domain-error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const Exact = Decimal.clone({ precision: 34, rounding: Decimal.ROUND_HALF_UP });

const SCALE = 2;
const AMOUNT_FORMAT = /^-?\d{1,25}(\.\d{1,2})?$/;
const CURRENCY_FORMAT = /^[A-Z]{3}$/;
const ZERO = '0';
const MAX_ABSOLUTE = new Exact('999999999999999999.99');

export class Money {
  private constructor(
    private readonly value: InstanceType<typeof Exact>,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const currency = assertCurrency(props.currency);
    const amount = props.amount;

    if (typeof amount !== 'string') {
      throw new InvalidMoneyError(`amount must be a decimal string, received ${typeof amount}`);
    }
    if (!AMOUNT_FORMAT.test(amount)) {
      throw new InvalidMoneyError(`invalid amount: ${JSON.stringify(amount)}`);
    }

    const value = new Exact(amount);
    if (value.isNegative() && !value.isZero()) {
      throw new InvalidMoneyError(`negative amount is not accepted on an input contract: ${amount}`);
    }
    if (value.abs().greaterThan(MAX_ABSOLUTE)) {
      throw new InvalidMoneyError(`amount above the supported maximum: ${amount}`);
    }

    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return new Money(new Exact(ZERO), assertCurrency(currency));
  }

  // Waives only the external non-negative rule; range, scale and finiteness
  // still hold, because every Money must fit numeric(20,2).
  private static of(value: InstanceType<typeof Exact>, currency: string): Money {
    if (!value.isFinite()) {
      throw new InvalidMoneyError('non-finite result');
    }
    if (value.decimalPlaces() > SCALE) {
      throw new InvalidMoneyError(`result with more than ${SCALE} decimal places: ${value.toString()}`);
    }
    if (value.abs().greaterThan(MAX_ABSOLUTE)) {
      throw new InvalidMoneyError(`result outside the supported range: ${value.toFixed(SCALE)}`);
    }
    return new Money(value, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.of(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(ZERO);
  }

  isNegative(): boolean {
    return this.value.lessThan(ZERO);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  isGreaterThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.greaterThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

function assertCurrency(currency: string): string {
  if (typeof currency !== 'string' || !CURRENCY_FORMAT.test(currency)) {
    throw new InvalidMoneyError(`invalid currency: ${JSON.stringify(currency)}`);
  }
  return currency;
}
