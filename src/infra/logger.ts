import pino from 'pino';
import { requestContext } from './request-context';

/**
 * Structured JSON logs. Every line automatically carries correlationId /
 * messageId from the current request context. Call sites log identifiers
 * (transactionId, walletId, provider), never full payloads.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'wager-processor' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  mixin: () => ({ ...requestContext.getStore() }),
  redact: { paths: ['*.authorization', '*.password', '*.token'], remove: true },
});
