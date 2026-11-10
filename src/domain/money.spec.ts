import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, InvalidMoneyError, Money, NegativeMoneyError } from './money';

describe('Money', () => {
  test('parses and normalizes to 2 decimals', () => {
    expect(Money.of('10', 'BRL').toString()).toBe('10.00');
    expect(Money.of('10.5', 'BRL').toString()).toBe('10.50');
    expect(Money.of('0.01', 'BRL').toString()).toBe('0.01');
    expect(Money.of('9999999999999999.99', 'BRL').toString()).toBe('9999999999999999.99');
  });

  test('avoids floating-point errors', () => {
    const sum = Money.of('0.10', 'BRL').add(Money.of('0.20', 'BRL'));
    expect(sum.toString()).toBe('0.30');
  });

  test.each([
    ['number input', 10],
    ['negative', '-1.00'],
    ['three decimals', '1.001'],
    ['exponent', '1e3'],
    ['leading zero', '01.00'],
    ['empty', ''],
    ['whitespace', ' 1.00'],
    ['trailing dot', '1.'],
    ['too many digits', '12345678901234567.00'],
  ])('rejects %s', (_label, value) => {
    expect(() => Money.of(value, 'BRL')).toThrow(InvalidMoneyError);
  });

  test.each(['brl', 'BR', 'BRLL', '', 123])('rejects currency %p', (currency) => {
    expect(() => Money.of('1.00', currency)).toThrow(InvalidMoneyError);
  });

  test('is immutable', () => {
    const money = Money.of('1.00', 'BRL');
    expect(Object.isFrozen(money)).toBe(true);
    money.add(Money.of('1.00', 'BRL'));
    expect(money.toString()).toBe('1.00');
  });

  test('subtract never goes negative', () => {
    const balance = Money.of('100.00', 'BRL');
    const bet = Money.of('100.01', 'BRL');
    expect(balance.canSubtract(bet)).toBe(false);
    expect(() => balance.subtract(bet)).toThrow(NegativeMoneyError);
    expect(balance.subtract(Money.of('80.00', 'BRL')).toString()).toBe('20.00');
  });

  test('rejects mixing currencies', () => {
    expect(() => Money.of('1.00', 'BRL').add(Money.of('1.00', 'USD'))).toThrow(CurrencyMismatchError);
    expect(() => Money.of('1.00', 'BRL').canSubtract(Money.of('1.00', 'USD'))).toThrow(CurrencyMismatchError);
  });

  test('equality considers currency', () => {
    expect(Money.of('1.00', 'BRL').equals(Money.of('1', 'BRL'))).toBe(true);
    expect(Money.of('1.00', 'BRL').equals(Money.of('1.00', 'USD'))).toBe(false);
  });

  test('serializes amounts as strings', () => {
    expect(JSON.stringify(Money.of('5', 'BRL'))).toBe('{"amount":"5.00","currency":"BRL"}');
  });
});
