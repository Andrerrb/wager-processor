import {
  ConnectionException,
  DeadlockException,
  LockWaitTimeoutException,
} from '@mikro-orm/core';
import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';
import { AppError } from '../application/errors';
import { CurrencyMismatchError, InvalidMoneyError } from '../domain/money';
import { logger } from '../infra/logger';

interface HttpError {
  status: number;
  body: { error: string; message: string; details?: Record<string, string> };
}

export function toHttpError(error: unknown): HttpError {
  if (error instanceof AppError) {
    return { status: error.httpStatus, body: { error: error.code, message: error.message, details: error.details } };
  }
  if (error instanceof InvalidMoneyError || error instanceof CurrencyMismatchError) {
    return { status: 400, body: { error: 'INVALID_PAYLOAD', message: error.message } };
  }
  // Malformed JSON body (thrown by the body parser).
  if (typeof error === 'object' && error !== null && (error as { type?: string }).type === 'entity.parse.failed') {
    return { status: 400, body: { error: 'INVALID_JSON', message: 'Request body is not valid JSON' } };
  }
  if (
    error instanceof LockWaitTimeoutException ||
    error instanceof DeadlockException ||
    error instanceof ConnectionException
  ) {
    return { status: 503, body: { error: 'TRANSIENT_FAILURE', message: 'Temporary failure, retry with the same Idempotency-Key' } };
  }
  if (error instanceof HttpException) {
    return { status: error.getStatus(), body: { error: 'HTTP_ERROR', message: error.message } };
  }
  return { status: 500, body: { error: 'INTERNAL_ERROR', message: 'Unexpected error' } };
}

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, body } = toHttpError(error);
    if (status >= 500) {
      logger.error({ err: error, status }, 'request failed');
    }
    if (status === 503) response.setHeader('Retry-After', '1');
    response.status(status).json(body);
  }
}
