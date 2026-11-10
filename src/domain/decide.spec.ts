import { describe, expect, test } from 'bun:test';
import { type DecisionInput, decide, type ReferenceView } from './decide';
import { Money } from './money';

const brl = (amount: string) => Money.of(amount, 'BRL');
const wallet = (balance: string) => ({ id: 'w1', balance: brl(balance) });

const base = (overrides: Partial<DecisionInput>): DecisionInput => ({
  kind: 'BET',
  amount: brl('10.00'),
  playerId: 'p1',
  currency: 'BRL',
  roundId: 'r1',
  wallet: wallet('100.00'),
  ...overrides,
});

const ref = (overrides: Partial<ReferenceView> = {}): ReferenceView => ({
  kind: 'BET',
  status: 'PROCESSED',
  amount: brl('10.00'),
  playerId: 'p1',
  walletId: 'w1',
  currency: 'BRL',
  roundId: 'r1',
  ...overrides,
});

describe('decide', () => {
  test('rejects when the wallet does not exist', () => {
    expect(decide(base({ wallet: null }))).toEqual({ status: 'REJECTED', failureCode: 'WALLET_NOT_FOUND' });
  });

  describe('BET', () => {
    test('debits when funds are enough (exact balance allowed)', () => {
      const decision = decide(base({ amount: brl('100.00') }));
      expect(decision.status).toBe('PROCESSED');
      if (decision.status === 'PROCESSED') {
        expect(decision.movement?.direction).toBe('DEBIT');
        expect(decision.movement?.amount.toString()).toBe('100.00');
      }
    });

    test('rejects with INSUFFICIENT_FUNDS, never goes negative', () => {
      expect(decide(base({ amount: brl('100.01') }))).toEqual({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS' });
    });
  });

  test('WIN credits', () => {
    const decision = decide(base({ kind: 'WIN', wallet: wallet('0.00') }));
    expect(decision.status === 'PROCESSED' && decision.movement?.direction).toBe('CREDIT');
  });

  test('WIN of zero is processed without a movement', () => {
    expect(decide(base({ kind: 'WIN', amount: brl('0') }))).toEqual({ status: 'PROCESSED', movement: null });
  });

  test('LOSS is processed without touching the balance', () => {
    expect(decide(base({ kind: 'LOSS' }))).toEqual({ status: 'PROCESSED', movement: null });
  });

  test('OPENING credits', () => {
    const decision = decide(base({ kind: 'OPENING', wallet: wallet('0.00'), roundId: null }));
    expect(decision.status === 'PROCESSED' && decision.movement?.direction).toBe('CREDIT');
  });

  describe('REFUND', () => {
    test('credits back a processed BET', () => {
      const decision = decide(base({ kind: 'REFUND', reference: ref() }));
      expect(decision.status === 'PROCESSED' && decision.movement?.direction).toBe('CREDIT');
    });

    test('waits when the reference has not arrived', () => {
      expect(decide(base({ kind: 'REFUND', reference: null }))).toEqual({ status: 'PENDING_REFERENCE' });
    });

    test('waits when the reference is itself pending', () => {
      expect(decide(base({ kind: 'REFUND', reference: ref({ status: 'PENDING_REFERENCE' }) })).status).toBe(
        'PENDING_REFERENCE',
      );
    });

    test('cannot refund a WIN', () => {
      expect(decide(base({ kind: 'REFUND', reference: ref({ kind: 'WIN' }) }))).toEqual({
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_REVERSIBLE',
      });
    });

    test('rejects partial refunds', () => {
      expect(decide(base({ kind: 'REFUND', amount: brl('5.00'), reference: ref() }))).toEqual({
        status: 'REJECTED',
        failureCode: 'AMOUNT_MISMATCH',
      });
    });

    test('rejects a second reversal', () => {
      expect(decide(base({ kind: 'REFUND', reference: ref(), referenceAlreadyReversed: true }))).toEqual({
        status: 'REJECTED',
        failureCode: 'REFERENCE_ALREADY_REVERSED',
      });
    });

    test('rejects a reference that was rejected', () => {
      expect(decide(base({ kind: 'REFUND', reference: ref({ status: 'REJECTED' }) }))).toEqual({
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_PROCESSED',
      });
    });

    test.each([
      ['player', { playerId: 'p2' }],
      ['wallet', { walletId: 'w2' }],
      ['currency', { currency: 'USD', amount: Money.of('10.00', 'USD') }],
      ['round', { roundId: 'r2' }],
    ])('rejects a reference with a different %s', (_label, overrides) => {
      expect(decide(base({ kind: 'REFUND', reference: ref(overrides) }))).toEqual({
        status: 'REJECTED',
        failureCode: 'REFERENCE_MISMATCH',
      });
    });
  });

  describe('ROLLBACK', () => {
    test('of a BET credits back', () => {
      const decision = decide(base({ kind: 'ROLLBACK', reference: ref() }));
      expect(decision.status === 'PROCESSED' && decision.movement?.direction).toBe('CREDIT');
    });

    test('of a WIN debits', () => {
      const decision = decide(base({ kind: 'ROLLBACK', reference: ref({ kind: 'WIN' }) }));
      expect(decision.status === 'PROCESSED' && decision.movement?.direction).toBe('DEBIT');
    });

    test('of a REFUND debits', () => {
      const decision = decide(base({ kind: 'ROLLBACK', reference: ref({ kind: 'REFUND' }) }));
      expect(decision.status === 'PROCESSED' && decision.movement?.direction).toBe('DEBIT');
    });

    test('of a WIN with spent funds is rejected with a distinct code', () => {
      expect(decide(base({ kind: 'ROLLBACK', wallet: wallet('3.00'), reference: ref({ kind: 'WIN' }) }))).toEqual({
        status: 'REJECTED',
        failureCode: 'INSUFFICIENT_FUNDS_FOR_REVERSAL',
      });
    });

    test('of a LOSS is not allowed', () => {
      expect(decide(base({ kind: 'ROLLBACK', reference: ref({ kind: 'LOSS' }) }))).toEqual({
        status: 'REJECTED',
        failureCode: 'REFERENCE_NOT_REVERSIBLE',
      });
    });
  });
});
