/**
 * Errors that are NOT business rejections. Business rejections are a normal
 * result (a REJECTED transaction with a failure code), not an exception.
 */
export abstract class AppError extends Error {
  abstract readonly httpStatus: number;
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}

/** 400: malformed payload or header. */
export class ValidationError extends AppError {
  override readonly httpStatus = 400;
}

/** 404 */
export class NotFoundError extends AppError {
  override readonly httpStatus = 404;
}

/** 409: same Idempotency-Key (or provider+externalId) with a different payload. */
export class IdempotencyConflictError extends AppError {
  override readonly httpStatus = 409;
}

/** 409: other state conflicts, e.g. wallet already exists. */
export class ConflictError extends AppError {
  override readonly httpStatus = 409;
}

/** 503: transient infrastructure failure, safe to retry with the same key. */
export class TransientError extends AppError {
  override readonly httpStatus = 503;
}
