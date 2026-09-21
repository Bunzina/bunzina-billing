import logger from '@lucas-pmelo/logger';
import { createMigrationTable } from './create-migration-table';
import { existsMigrationTable } from './exists-migration-table';
import { readDatabaseMigrations, readLocalMigrations } from './read-migrations';
import { runPendingMigrations } from './run-pending';

type Migration = { version: string; name: string };

const migrationKey = (migration: Migration) =>
  `${migration.version}_${migration.name}`;

export const runMigrations = async () => {
  const migrationTableExists = await existsMigrationTable();

  if (!migrationTableExists) await createMigrationTable();

  const [localMigrations, dbMigrations] = await Promise.all([
    readLocalMigrations(),
    readDatabaseMigrations(),
  ]);

  const localMigrationKeys = new Set(localMigrations.map(migrationKey));
  const dbMigrationKeys = new Set(dbMigrations.map(migrationKey));

  const dbMigrationsMissingLocally = dbMigrations.filter(
    (dbMigration) => !localMigrationKeys.has(migrationKey(dbMigration)),
  );

  if (dbMigrationsMissingLocally.length !== 0)
    throw new Error(
      `The database contains migrations whose corresponding local .sql files are missing (they may have been deleted or renamed):\n${dbMigrationsMissingLocally
        .map(migrationKey)
        .join('\n')}`,
    );

  const dbMigrationsMissing = localMigrations.filter(
    (localMigration) => !dbMigrationKeys.has(migrationKey(localMigration)),
  );

  if (dbMigrationsMissing.length !== 0) {
    logger.info({
      message: 'Running pending migrations',
      data: { migrations: dbMigrationsMissing.map(migrationKey) },
    });

    await runPendingMigrations(dbMigrationsMissing);
  }

  logger.info({ message: 'Migrations ran successfully' });
};

if (import.meta.main) {
  await runMigrations();
}
