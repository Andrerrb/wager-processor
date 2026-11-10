import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { ENTITIES } from './entities';
import { Migration20261108000000_initial } from './migrations/Migration20261108000000_initial';

export default defineConfig({
  clientUrl: process.env.DATABASE_URL ?? 'postgres://wagering:wagering@localhost:5432/wagering',
  entities: ENTITIES,
  extensions: [Migrator],
  // Explicit list instead of a file glob: deterministic under Bun and in tests.
  migrations: {
    migrationsList: [{ name: 'Migration20261108000000_initial', class: Migration20261108000000_initial }],
    snapshot: false,
    transactional: true,
    allOrNothing: true,
  },
  pool: { min: 2, max: 20 },
});
