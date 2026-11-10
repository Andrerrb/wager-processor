import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config';

const command = process.argv[2];
const orm = await MikroORM.init(config);
const migrator = orm.getMigrator();

try {
  switch (command) {
    case 'up':
      console.log('Applied:', (await migrator.up()).map((m) => m.name));
      break;
    case 'down':
      // Reverts only the last migration.
      console.log('Reverted:', (await migrator.down()).map((m) => m.name));
      break;
    case 'status':
      console.log('Executed:', (await migrator.getExecutedMigrations()).map((m) => m.name));
      console.log('Pending:', (await migrator.getPendingMigrations()).map((m) => m.name));
      break;
    default:
      console.error('Usage: bun src/scripts/migrate.ts <up|down|status>');
      process.exitCode = 1;
  }
} finally {
  await orm.close(true);
}
