import { describe, expect, mock, test, afterEach } from 'bun:test';

describe('runPendingMigrations', () => {
  afterEach(() => {
    mock.restore();
  });

  test('should run pending migrations in ascending version order', async () => {
    const sqlFileMock = mock(() => Promise.resolve(undefined));
    const sqlInsertMock = mock(() => Promise.resolve(undefined));

    const sqlMock = ((..._args: unknown[]) => sqlInsertMock()) as unknown as {
      (..._args: unknown[]): Promise<unknown>;
      file: (..._args: unknown[]) => Promise<unknown>;
    };

    sqlMock.file = sqlFileMock;

    const transactionMock = mock(
      async (callback: (_sql: typeof sqlMock) => Promise<void>) => {
        await callback(sqlMock);
      },
    );

    mock.module('./config/database', () => ({
      db: {
        transaction: transactionMock,
      },
    }));

    const { runPendingMigrations } = await import(
      `./run-pending.ts?test=${Math.random()}`
    );

    await runPendingMigrations([
      { version: '003', name: 'create_vehicles' },
      { version: '001', name: 'create_schema_and_enums' },
      { version: '002', name: 'create_customers' },
    ]);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(sqlFileMock).toHaveBeenNthCalledWith(
      1,
      './migrations/001_create_schema_and_enums.sql',
    );
    expect(sqlFileMock).toHaveBeenNthCalledWith(
      2,
      './migrations/002_create_customers.sql',
    );
    expect(sqlFileMock).toHaveBeenNthCalledWith(
      3,
      './migrations/003_create_vehicles.sql',
    );
    expect(sqlInsertMock).toHaveBeenCalledTimes(3);
  });
});
