import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { runWithContext } from '../infra/request-context';

const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Reuses an incoming X-Correlation-Id (or creates one), echoes it back and attaches it to every log line. */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header('x-correlation-id');
  const correlationId = incoming && VALID_ID.test(incoming) ? incoming : randomUUID();
  res.setHeader('x-correlation-id', correlationId);
  void runWithContext({ correlationId }, async () => next());
}
