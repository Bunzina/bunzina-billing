import { readdir } from 'node:fs/promises';
import { db } from './config/database';

const MIGRATIONS_FILE_PATTERN = /^(\d{3})_(.+)\.sql$/;

export const readLocalMigrations = async () => {
  const files = await readdir('./migrations');

  const localMigrations = files
    .filter((file) => file.endsWith('.sql'))
    .map((file) => {
      const match = file.match(MIGRATIONS_FILE_PATTERN);

      if (!match) {
        throw new Error(
          `Invalid migration filename "${file}". Expected format: NNN_name.sql`,
        );
      }

      return {
        version: match[1]!,
        name: match[2]!,
      };
    });

  return removeNullValues(localMigrations);
};

export const readDatabaseMigrations = async () => {
  const migrations = await db<{ name: string }[]>`
    SELECT m.name FROM public.migrations m
    ORDER BY m.run_at
  `;

  return removeNullValues(
    migrations.map((migration) => ({
      version: migration.name.slice(0, 3),
      name: migration.name.slice(4),
    })),
  );
};

const removeNullValues = (
  migrations: ({ version: string; name: string } | null)[],
) => {
  return migrations.filter(
    (migration): migration is { version: string; name: string } =>
      migration !== null,
  );
};
