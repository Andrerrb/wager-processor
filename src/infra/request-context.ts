import { AsyncLocalStorage } from 'node:async_hooks';

/** Correlation data attached to every log line written while handling a request or message. */
export interface RequestContext {
  correlationId: string;
  messageId?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(context: RequestContext, fn: () => Promise<T>): Promise<T> {
  return requestContext.run(context, fn);
}
