import { type BeforeApplicationShutdown, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { config } from '../infra/config';
import { lifecycle } from '../infra/lifecycle';
import { metrics } from '../infra/metrics';
import { WorkerLoop } from '../infra/worker-loop';
import { OutboxPublisher } from './outbox.publisher';
import { PendingReferenceWorker } from './pending-reference.worker';
import { SqsConsumer } from './sqs.consumer';

/** Starts the background loops with the app and drains them on shutdown. */
@Injectable()
export class BackgroundWorkers implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private loops: WorkerLoop[] = [];

  constructor(
    private readonly pending: PendingReferenceWorker,
    private readonly outbox: OutboxPublisher,
    private readonly consumer: SqsConsumer,
  ) {}

  onApplicationBootstrap(): void {
    if (!config.workersEnabled) return;
    this.loops = [
      new WorkerLoop('pending-reference', () => this.pending.runOnce(), 1_000),
      new WorkerLoop(
        'outbox',
        async () => {
          const published = await this.outbox.runOnce();
          metrics.set('outbox_lag_seconds', await this.outbox.lagSeconds());
          return published.length;
        },
        500,
      ),
      new WorkerLoop('sqs-consumer', (signal) => this.consumer.pollOnce(signal), 0),
    ];
    for (const loop of this.loops) loop.start();
  }

  /** Runs before the DB pool is closed: stop taking work, finish what is in flight. */
  async beforeApplicationShutdown(): Promise<void> {
    lifecycle.shuttingDown = true;
    await Promise.all(this.loops.map((loop) => loop.stop()));
  }
}
