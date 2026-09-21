import { describe, expect, mock, test, afterEach } from 'bun:test';

describe('createMigrationTable', () => {
  afterEach(() => {
    mock.restore();
  });
  test('should create migrations table using init script', async () => {
    const dbFile = mock(() => Promise.resolve(undefined));

    mock.module('./config/database', () => ({
      db: {
        file: dbFile,
      },
    }));

    const { createMigrationTable } = await import(
      `./create-migration-table.ts?test=${Math.random()}`
    );

    await createMigrationTable();

    expect(dbFile).toHaveBeenCalledWith(
      './migrations/engine/queries/init_system_migration.sql',
    );
  });
});
