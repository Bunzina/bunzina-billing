import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/infrastructure/configs/database';

const MIGRATIONS_DIR = join(import.meta.dir, '../../migrations');

export const hasIntegrationDatabase = Boolean(process.env.DATABASE_URL);

export const applyMigrations = async (): Promise<void> => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d+_.+\.sql$/.test(file))
    .sort();

  for (const file of files) {
    await db.file(join(MIGRATIONS_DIR, file));
  }
};

export const resetMessagingTables = async (): Promise<void> => {
  await db`TRUNCATE bunzina.outbox_messages, bunzina.processed_events, bunzina.payment_events`;
};

export const resetQuoteTables = async (): Promise<void> => {
  await db`TRUNCATE bunzina.payments, bunzina.quotes, bunzina.outbox_messages, bunzina.processed_events CASCADE`;
};

export const countRows = async (table: string): Promise<number> => {
  const [row] = await db`SELECT count(*)::int AS count FROM ${db(table)}`;

  return Number(row?.count);
};

export { db };
