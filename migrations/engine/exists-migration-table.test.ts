import { describe, expect, mock, test, afterEach } from 'bun:test';

describe('existsMigrationTable', () => {
  afterEach(() => {
    mock.restore();
  });

  test('should return true when migrations table exists', async () => {
    const dbMock = mock(() => Promise.resolve([] as { to_regclass: string }[]));
    mock.module('./config/database', () => ({
      db: dbMock,
    }));

    const { existsMigrationTable } = await import(
      `./exists-migration-table.ts?test=${Math.random()}`
    );

    dbMock.mockResolvedValueOnce([{ to_regclass: 'migrations' }]);

    const result = await existsMigrationTable();

    expect(result).toBe(true);
    expect(dbMock).toHaveBeenCalledTimes(1);
  });

  test('should return false when migrations table does not exist', async () => {
    const dbMock = mock(() => Promise.resolve([] as { to_regclass: string }[]));
    mock.module('./config/database', () => ({
      db: dbMock,
    }));

    const { existsMigrationTable } = await import(
      `./exists-migration-table.ts?test=${Math.random()}`
    );

    dbMock.mockResolvedValueOnce([{ to_regclass: null as unknown as string }]);

    const result = await existsMigrationTable();

    expect(result).toBe(false);
    expect(dbMock).toHaveBeenCalledTimes(1);
  });
});
