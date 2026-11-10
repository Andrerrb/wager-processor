import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import { CurrencyMismatchError, Money } from '../domain/money';
import { LedgerEntry } from './ledger-entry.entity';
import { InsufficientFundsError, Wallet } from './wallet.entity';

const brl = (amount: string) => Money.of(amount, 'BRL');

describe('Wallet', () => {
  test('opens with zero balance at version 1', () => {
    const wallet = Wallet.open('p1', 'BRL');
    expect(wallet.balance).toBe('0.00');
    expect(wallet.version).toBe(1);
  });

  test('every balance change increments the version exactly once', () => {
    const wallet = Wallet.open('p1', 'BRL');
    wallet.apply({ direction: 'CREDIT', amount: brl('100.00') });
    wallet.apply({ direction: 'DEBIT', amount: brl('80.00') });
    expect(wallet.balance).toBe('20.00');
    expect(wallet.version).toBe(3);
  });

  test('refuses to go negative and leaves state untouched', () => {
    const wallet = Wallet.open('p1', 'BRL');
    wallet.apply({ direction: 'CREDIT', amount: brl('10.00') });
    expect(() => wallet.apply({ direction: 'DEBIT', amount: brl('10.01') })).toThrow(InsufficientFundsError);
    expect(wallet.balance).toBe('10.00');
    expect(wallet.version).toBe(2);
  });

  test('refuses zero movements (they must not create ledger entries)', () => {
    const wallet = Wallet.open('p1', 'BRL');
    expect(() => wallet.apply({ direction: 'CREDIT', amount: brl('0') })).toThrow();
    expect(wallet.version).toBe(1);
  });

  test('refuses a movement in another currency', () => {
    const wallet = Wallet.open('p1', 'BRL');
    expect(() => wallet.apply({ direction: 'CREDIT', amount: Money.of('1.00', 'USD') })).toThrow(CurrencyMismatchError);
  });

  test('ledger entry captures balance and version after the change', () => {
    const wallet = Wallet.open('p1', 'BRL');
    const movement = { direction: 'CREDIT' as const, amount: brl('50.00') };
    wallet.apply(movement);
    const entry = LedgerEntry.record(wallet, 'tx-1', movement);
    expect(entry.balanceAfter).toBe('50.00');
    expect(entry.walletVersion).toBe(2);
    expect(entry.amount).toBe('50.00');
  });
});
