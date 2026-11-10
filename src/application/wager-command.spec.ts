import { describe, expect, test } from 'bun:test';
import { canonicalJson } from './canonical-json';
import { ValidationError } from './errors';
import { parseWagerCommand, wagerPayloadHash } from './wager-command';

const valid = {
  provider: 'acme',
  externalId: 'bet-1',
  kind: 'BET',
  playerId: 'p1',
  currency: 'BRL',
  roundId: 'r1',
  amount: '10.00',
};

const errorsOf = (fn: () => unknown): Record<string, string> => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) return error.details ?? {};
    throw error;
  }
  throw new Error('expected a ValidationError');
};

describe('canonicalJson', () => {
  test('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}');
  });
});

describe('parseWagerCommand', () => {
  test('accepts a valid BET', () => {
    const command = parseWagerCommand(valid, 'key-1');
    expect(command.amount.toString()).toBe('10.00');
    expect(command.referenceExternalId).toBeNull();
  });

  test('requires the Idempotency-Key header', () => {
    expect(errorsOf(() => parseWagerCommand(valid, undefined))).toHaveProperty('Idempotency-Key');
  });

  test('rejects unknown fields', () => {
    expect(errorsOf(() => parseWagerCommand({ ...valid, bonus: true }, 'k'))).toHaveProperty('bonus');
  });

  test('rejects numeric amounts (no floats on the wire)', () => {
    expect(errorsOf(() => parseWagerCommand({ ...valid, amount: 10 }, 'k'))).toHaveProperty('amount');
  });

  test('rejects OPENING from providers', () => {
    expect(errorsOf(() => parseWagerCommand({ ...valid, kind: 'OPENING' }, 'k'))).toHaveProperty('kind');
  });

  test('rejects the reserved internal provider', () => {
    expect(errorsOf(() => parseWagerCommand({ ...valid, provider: 'internal' }, 'k'))).toHaveProperty('provider');
  });

  test('REFUND and ROLLBACK require a reference; others forbid it', () => {
    expect(errorsOf(() => parseWagerCommand({ ...valid, kind: 'REFUND' }, 'k'))).toHaveProperty('referenceExternalId');
    expect(errorsOf(() => parseWagerCommand({ ...valid, referenceExternalId: 'x' }, 'k'))).toHaveProperty(
      'referenceExternalId',
    );
  });

  test('a transaction cannot reference itself', () => {
    expect(
      errorsOf(() => parseWagerCommand({ ...valid, kind: 'ROLLBACK', referenceExternalId: 'bet-1' }, 'k')),
    ).toHaveProperty('referenceExternalId');
  });

  test('rejects a zero BET', () => {
    expect(errorsOf(() => parseWagerCommand({ ...valid, amount: '0' }, 'k'))).toHaveProperty('amount');
  });
});

describe('wagerPayloadHash', () => {
  test('equivalent payloads hash the same, regardless of key order, amount format or idempotency key', () => {
    const a = parseWagerCommand(valid, 'key-a');
    const reordered = {
      amount: '10',
      roundId: 'r1',
      currency: 'BRL',
      playerId: 'p1',
      kind: 'BET',
      externalId: 'bet-1',
      provider: 'acme',
    };
    const b = parseWagerCommand(reordered, 'key-b');
    expect(wagerPayloadHash(a)).toBe(wagerPayloadHash(b));
  });

  test('a divergent payload under the same key hashes differently (=> 409, not replay)', () => {
    const original = parseWagerCommand(valid, 'key-1');
    const divergent = parseWagerCommand({ ...valid, amount: '10.01' }, 'key-1');
    expect(wagerPayloadHash(original)).not.toBe(wagerPayloadHash(divergent));
  });
});
