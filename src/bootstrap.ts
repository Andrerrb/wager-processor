import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { correlationMiddleware } from './http/correlation.middleware';

/** Shared by main.ts and the integration tests, so tests run the real app. */
export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.use(correlationMiddleware);
  // Graceful shutdown on SIGTERM/SIGINT: workers drain, then the DB pool closes.
  app.enableShutdownHooks();
  return app;
}
