import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Subprocess } from 'bun';
import { client, createWallet, expectConsistent, migrateUp, uid, wager } from './helpers';

const PORTS = [4101, 4102, 4103];
let instances: Subprocess[] = [];

async function spawnInstance(port: number): Promise<Subprocess> {
  const proc = Bun.spawn(['bun', 'src/main.ts'], {
    env: { ...process.env, PORT: String(port), WORKERS_ENABLED: 'false', LOG_LEVEL: 'silent' },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health/live`)).ok) return proc;
    } catch {
      // not up yet
    }
    await Bun.sleep(250);
  }
  proc.kill();
  throw new Error(`instance on port ${port} did not start`);
}

beforeAll(async () => {
  await migrateUp();
  instances = await Promise.all(PORTS.map(spawnInstance));
});
afterAll(() => {
  for (const proc of instances) proc.kill();
});

describe('three application instances (separate processes)', () => {
  test('bets spread across instances on one wallet never overdraw it', async () => {
    const apis = PORTS.map((port) => client(`http://127.0.0.1:${port}`));
    const player = uid('multi');
    const walletId = await createWallet(apis[0]!, player, '100.00');

    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        apis[i % apis.length]!.post('/wagering/transactions', wager(player, `multi-${i}`, '10.00'), uid(`multi-${i}`)),
      ),
    );

    expect(results.filter((r) => r.status === 201)).toHaveLength(10);
    expect(results.filter((r) => r.status === 422)).toHaveLength(20);
    for (const api of apis) expect((await api.get(`/wallets/${walletId}`)).body.balance).toBe('0.00');
    await expectConsistent(apis[1]!, walletId);
  });

  test('restart consistency: after restarting every instance the state is unchanged and consistent', async () => {
    const api = client(`http://127.0.0.1:${PORTS[0]}`);
    const player = uid('restart');
    const walletId = await createWallet(api, player, '50.00');
    await api.post('/wagering/transactions', wager(player, 'restart-bet', '20.00'), uid('restart-bet'));

    for (const proc of instances) proc.kill();
    await Promise.all(instances.map((proc) => proc.exited));
    instances = await Promise.all(PORTS.map(spawnInstance));

    const after = client(`http://127.0.0.1:${PORTS[2]}`);
    expect((await after.get(`/wallets/${walletId}`)).body.balance).toBe('30.00');
    const replay = await after.post('/wagering/transactions', wager(player, 'restart-bet', '20.00'), uid('restart-bet'));
    expect(replay.status).toBe(200);
    await expectConsistent(after, walletId);
  });
});
