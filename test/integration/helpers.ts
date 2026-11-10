import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { expect } from 'bun:test';
import { logger } from '../../src/infra/logger';
import ormConfig from '../../src/mikro-orm.config';

logger.level = 'silent';

export const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
export const uid = (label: string) => `${runId}-${label}`;

export async function migrateUp(): Promise<void> {
  const orm = await MikroORM.init(ormConfig);
  await orm.getMigrator().up();
  await orm.close(true);
}

/** Boots the real Nest app in-process on a random port. Background workers off: tests drive them explicitly. */
export async function startApp(): Promise<{ app: INestApplication; url: string }> {
  process.env.WORKERS_ENABLED = 'false';
  await migrateUp();
  const { createApp } = await import('../../src/bootstrap');
  const app = await createApp();
  await app.listen(0);
  const { port } = app.getHttpServer().address() as { port: number };
  return { app, url: `http://127.0.0.1:${port}` };
}

export interface ApiResponse {
  status: number;
  body: any;
}

export function client(url: string) {
  const call = async (method: string, path: string, body?: unknown, key?: string): Promise<ApiResponse> => {
    const res = await fetch(url + path, {
      method,
      headers: { 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return {
    get: (path: string) => call('GET', path),
    post: (path: string, body?: unknown, key?: string) => call('POST', path, body, key),
  };
}

export type Client = ReturnType<typeof client>;

export function wager(player: string, externalId: string, amount: string, extra: Record<string, unknown> = {}) {
  return {
    provider: 'acme',
    externalId: uid(externalId),
    kind: 'BET',
    playerId: player,
    currency: 'BRL',
    roundId: 'round-1',
    amount,
    ...extra,
  };
}

export async function createWallet(api: Client, player: string, initialBalance?: string): Promise<string> {
  const res = await api.post('/wallets', { playerId: player, currency: 'BRL', ...(initialBalance ? { initialBalance } : {}) });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** Final invariant for every test: stored balance == balance rebuilt from the ledger. */
export async function expectConsistent(api: Client, walletId: string): Promise<any> {
  const report = await api.post(`/wallets/${walletId}/reconciliation`);
  expect(report.status).toBe(200);
  expect(report.body.divergences).toEqual([]);
  expect(report.body.consistent).toBe(true);
  return report.body;
}
