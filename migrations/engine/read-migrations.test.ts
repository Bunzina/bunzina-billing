import { describe, expect, mock, test, afterEach } from 'bun:test';

describe('readLocalMigrations', () => {
  afterEach(() => {
    mock.restore();
  });

  test('should read and normalize local migration files', async () => {
    const readdirMock = mock(() => Promise.resolve([] as string[]));

    mock.module('node:fs/promises', () => ({
      readdir: readdirMock,
    }));

    const { readLocalMigrations } = await import(
      `./read-migrations.ts?test=${Math.random()}`
    );

    readdirMock.mockResolvedValueOnce([
      '001_create_schema_and_enums.sql',
      'README.md',
      '002_create_customers.sql',
    ]);

    const result = await readLocalMigrations();

    expect(result).toEqual([
      { version: '001', name: 'create_schema_and_enums' },
      { version: '002', name: 'create_customers' },
    ]);
  });

  test('should throw error when file name misses pattern', async () => {
    const readdirMock = mock(() => Promise.resolve([] as string[]));

    mock.module('node:fs/promises', () => ({
      readdir: readdirMock,
    }));

    const { readLocalMigrations } = await import(
      `./read-migrations.ts?test=${Math.random()}`
    );

    readdirMock.mockResolvedValueOnce([
      '001-create_schema_and_enums.sql',
      'README.md',
      '002_create_customers.sql',
    ]);

    await expect(readLocalMigrations()).rejects.toThrow();
  });
});

describe('readDatabaseMigrations', () => {
  afterEach(() => {
    mock.restore();
  });

  test('should map migration names from database records', async () => {
    const dbMock = mock(() => Promise.resolve([] as { name: string }[]));

    mock.module('./config/database', () => ({
      db: dbMock,
    }));

    const { readDatabaseMigrations } = await import(
      `./read-migrations.ts?test=${Math.random()}`
    );

    dbMock.mockResolvedValueOnce([
      { name: '001_create_schema_and_enums' },
      { name: '002_create_customers' },
    ]);

    const result = await readDatabaseMigrations();

    expect(result).toEqual([
      { version: '001', name: 'create_schema_and_enums' },
      { version: '002', name: 'create_customers' },
    ]);
    expect(dbMock).toHaveBeenCalledTimes(1);
  });
});
