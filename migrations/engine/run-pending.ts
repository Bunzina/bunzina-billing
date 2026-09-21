import { db } from './config/database';

export const runPendingMigrations = async (
  migrations: { name: string; version: string }[],
) => {
  await db.transaction(async (sql) => {
    const migrationsInOrder = [...migrations].sort(
      (migrationA, migrationB) => +migrationA.version - +migrationB.version,
    );

    for (const migration of migrationsInOrder) {
      const fileNameWithoutExtension = `${migration.version}_${migration.name}`;
      await sql.file(`./migrations/${fileNameWithoutExtension}.sql`);
      await sql`INSERT INTO public.migrations (name) VALUES (${fileNameWithoutExtension})`;
    }
  });
};
