import { InvalidMoneyError, Money } from '../domain/money';
import { EXTERNAL_WAGER_KINDS, INTERNAL_PROVIDER, REVERSAL_KINDS, type WagerKind } from '../domain/wager';
import { canonicalJson, sha256Hex } from './canonical-json';
import { ValidationError } from './errors';

export interface WagerCommand {
  readonly idempotencyKey: string;
  readonly provider: string;
  readonly externalId: string;
  readonly kind: WagerKind;
  readonly playerId: string;
  readonly currency: string;
  readonly roundId: string | null;
  readonly amount: Money;
  readonly referenceExternalId: string | null;
}

const ALLOWED_FIELDS = new Set([
  'provider',
  'externalId',
  'kind',
  'playerId',
  'currency',
  'roundId',
  'amount',
  'referenceExternalId',
]);
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/;
const IDEMPOTENCY_KEY = /^[\x21-\x7E]{1,255}$/;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Strict validation of an external wager request (HTTP body or queue message).
 * Unknown fields are rejected so that a typo never silently changes meaning.
 */
export function parseWagerCommand(body: unknown, idempotencyKey: unknown): WagerCommand {
  const errors: Record<string, string> = {};

  if (typeof idempotencyKey !== 'string' || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    errors['Idempotency-Key'] = 'required, 1-255 visible ASCII characters';
  }
  if (!isPlainObject(body)) {
    throw new ValidationError('INVALID_PAYLOAD', 'Body must be a JSON object', errors);
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) errors[key] = 'unknown field';
  }

  const identifier = (field: string, required: boolean): string | null => {
    const value = body[field];
    if (value === undefined || value === null) {
      if (required) errors[field] = 'required';
      return null;
    }
    if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
      errors[field] = 'must match [A-Za-z0-9._:-]{1,128}';
      return null;
    }
    return value;
  };

  const provider = identifier('provider', true);
  if (provider === INTERNAL_PROVIDER) errors.provider = `"${INTERNAL_PROVIDER}" is reserved`;
  const externalId = identifier('externalId', true);
  const playerId = identifier('playerId', true);
  const roundId = identifier('roundId', true);

  const kind = body.kind;
  const isKnownKind = typeof kind === 'string' && (EXTERNAL_WAGER_KINDS as readonly string[]).includes(kind);
  if (!isKnownKind) errors.kind = `must be one of ${EXTERNAL_WAGER_KINDS.join(', ')}`;
  const isReversal = isKnownKind && (REVERSAL_KINDS as readonly string[]).includes(kind);

  const referenceExternalId = identifier('referenceExternalId', isReversal);
  if (isKnownKind && !isReversal && referenceExternalId !== null) {
    errors.referenceExternalId = `not allowed for ${kind}`;
  }
  if (referenceExternalId !== null && referenceExternalId === externalId) {
    errors.referenceExternalId = 'a transaction cannot reference itself';
  }

  let currency: string | null = null;
  try {
    currency = Money.parseCurrency(body.currency);
  } catch {
    errors.currency = 'must be an ISO 4217 code such as "BRL"';
  }

  let amount: Money | null = null;
  if (currency !== null) {
    try {
      amount = Money.of(body.amount, currency);
      if (kind === 'BET' && amount.isZero()) errors.amount = 'BET amount must be greater than zero';
    } catch (error) {
      errors.amount = error instanceof InvalidMoneyError ? error.message : 'invalid amount';
    }
  }

  if (Object.keys(errors).length > 0) {
    throw new ValidationError('INVALID_PAYLOAD', 'Invalid wager transaction payload', errors);
  }

  return {
    idempotencyKey: idempotencyKey as string,
    provider: provider!,
    externalId: externalId!,
    kind: kind as WagerKind,
    playerId: playerId!,
    currency: currency!,
    roundId,
    amount: amount!,
    referenceExternalId,
  };
}

/**
 * Hash of the normalized payload (amount as "10.00"), excluding the
 * idempotency key itself. Same key + different hash = conflict.
 */
export function wagerPayloadHash(command: WagerCommand): string {
  const { idempotencyKey: _ignored, amount, ...rest } = command;
  return sha256Hex(canonicalJson({ ...rest, amount: amount.toString() }));
}
