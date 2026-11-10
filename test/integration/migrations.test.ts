import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import { describe, expect, test } from 'bun:test';
import ormConfig from '../../src/mikro-orm.config';

describe('migrations', () => {
  test('all migrations are applied and none are pending', async () => {
    const orm = await MikroORM.init(ormConfig);
    try {
      const migrator = orm.getMigrator();
      await migrator.up();
      expect(await migrator.getPendingMigrations()).toHaveLength(0);
      const executed = await migrator.getExecutedMigrations();
      expect(executed.map((m) => m.name)).toContain('Migration20261108000000_initial');
    } finally {
      await orm.close(true);
    }
  });
  // Reversibility (down + up) is exercised by `bun run migration:down && bun run migration:up`;
  // it is not run here because `down` drops the data other test files rely on.
});
