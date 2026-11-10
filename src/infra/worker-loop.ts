import { logger } from './logger';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Runs `tick` in a loop until stopped. `tick` returns how much work it did;
 * when it did none, the loop sleeps `idleMs`. `stop()` lets the current tick
 * finish (graceful shutdown) and aborts any wait / long poll.
 */
export class WorkerLoop {
  private running = false;
  private current: Promise<void> | null = null;
  private readonly abort = new AbortController();

  constructor(
    private readonly name: string,
    private readonly tick: (signal: AbortSignal) => Promise<number>,
    private readonly idleMs: number,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.current = this.loop();
    logger.info({ worker: this.name }, 'worker started');
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    await this.current;
    logger.info({ worker: this.name }, 'worker stopped');
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const done = await this.tick(this.abort.signal);
        if (done === 0) await sleep(this.idleMs, this.abort.signal);
      } catch (error) {
        if (!this.running) break;
        logger.error({ err: error, worker: this.name }, 'worker iteration failed');
        await sleep(Math.max(this.idleMs, 1_000), this.abort.signal);
      }
    }
  }
}
