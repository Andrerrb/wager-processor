/**
 * Money value object.
 *
 * - Internally stored as an integer number of minor units (cents) in a bigint,
 *   so there is never any floating-point arithmetic.
 * - Input and output are decimal strings with scale 2 ("100.00"), which is
 *   also how PostgreSQL returns NUMERIC(18,2) values.
 * - Immutable: every operation returns a new instance.
 * - Currency-aware: operations between different currencies throw.
 */

const SCALE = 2;
const MINOR_PER_UNIT = 100n;
/** Matches NUMERIC(18,2): at most 16 integer digits, at most 2 decimals, no sign, no leading zeros. */
const AMOUNT_PATTERN = /^(0|[1-9]\d{0,15})(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MAX_MINOR = 10n ** 18n - 1n;

export class InvalidMoneyError extends Error {
  override readonly name = 'InvalidMoneyError';
}

export class CurrencyMismatchError extends Error {
  override readonly name = 'CurrencyMismatchError';
  constructor(readonly left: string, readonly right: string) {
    super(`Currency mismatch: ${left} vs ${right}`);
  }
}

export class NegativeMoneyError extends Error {
  override readonly name = 'NegativeMoneyError';
}

export class Money {
  private constructor(
    readonly minorUnits: bigint,
    readonly currency: string,
  ) {
    Object.freeze(this);
  }

  /** Parses a decimal string such as "10", "10.5" or "10.50". Rejects numbers, signs, exponents and extra decimals. */
  static of(amount: unknown, currency: unknown): Money {
    const cur = Money.parseCurrency(currency);
    if (typeof amount !== 'string') {
      throw new InvalidMoneyError('Amount must be a decimal string, not a number');
    }
    if (!AMOUNT_PATTERN.test(amount)) {
      throw new InvalidMoneyError(`Invalid amount "${amount}": expected a non-negative decimal with up to ${SCALE} decimals`);
    }
    const [integerPart, fractionPart = ''] = amount.split('.');
    const minor = BigInt(integerPart!) * MINOR_PER_UNIT + BigInt(fractionPart.padEnd(SCALE, '0'));
    return new Money(minor, cur);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  static fromMinorUnits(minorUnits: bigint, currency: string): Money {
    if (minorUnits < 0n) throw new NegativeMoneyError('Money cannot be negative');
    if (minorUnits > MAX_MINOR) throw new InvalidMoneyError('Amount exceeds NUMERIC(18,2) range');
    return new Money(minorUnits, Money.parseCurrency(currency));
  }

  static parseCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency "${String(currency)}": expected ISO 4217 code like "BRL"`);
    }
    return currency;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits + other.minorUnits, this.currency);
  }

  /** Throws NegativeMoneyError if the result would be negative. Use `canSubtract` to check first. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits - other.minorUnits, this.currency);
  }

  canSubtract(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits >= other.minorUnits;
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  /** Always renders with exactly 2 decimals: "100.00". */
  toString(): string {
    const integerPart = this.minorUnits / MINOR_PER_UNIT;
    const fractionPart = (this.minorUnits % MINOR_PER_UNIT).toString().padStart(SCALE, '0');
    return `${integerPart}.${fractionPart}`;
  }

  toJSON(): { amount: string; currency: string } {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new CurrencyMismatchError(this.currency, other.currency);
  }
}
