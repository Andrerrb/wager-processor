import { createApp } from './bootstrap';
import { config } from './infra/config';
import { logger } from './infra/logger';

async function bootstrap(): Promise<void> {
  const app = await createApp();
  await app.listen(config.port);
  logger.info({ port: config.port, workers: config.workersEnabled }, 'wager-processor listening');
}

void bootstrap();
