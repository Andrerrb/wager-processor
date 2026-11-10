import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { EntityManager } from '@mikro-orm/postgresql';
import { Controller, Get, Header, Res } from '@nestjs/common';
import type { Response } from 'express';
import { config } from '../infra/config';
import { lifecycle } from '../infra/lifecycle';
import { metrics } from '../infra/metrics';

async function probe(check: () => Promise<unknown>, timeoutMs = 2_000): Promise<'up' | 'down'> {
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return 'up';
  } catch {
    return 'down';
  }
}

@Controller()
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SQSClient,
  ) {}

  /** Liveness: the process is running. No dependencies checked (a DB outage must not restart pods). */
  @Get('health/live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: can serve traffic right now (DB + SQS reachable, not shutting down). */
  @Get('health/ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks = {
      database: await probe(() => this.em.fork().execute('select 1')),
      sqs: await probe(() =>
        this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: config.sqs.queueUrl, AttributeNames: ['QueueArn'] })),
      ),
    };
    const ready = !lifecycle.shuttingDown && checks.database === 'up' && checks.sqs === 'up';
    res.status(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', shuttingDown: lifecycle.shuttingDown, checks };
  }

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4')
  metrics() {
    return metrics.render();
  }
}
