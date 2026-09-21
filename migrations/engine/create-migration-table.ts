import { db } from './config/database';

export const createMigrationTable = async () => {
  await db.file('./migrations/engine/queries/init_system_migration.sql');
};
