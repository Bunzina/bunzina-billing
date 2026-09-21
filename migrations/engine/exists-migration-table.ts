import { db } from './config/database';

export const existsMigrationTable = async (): Promise<boolean> => {
  const [record] = await db<{ to_regclass: string | null }[]>`
      SELECT to_regclass('public.migrations');
    `;

  return !!record?.to_regclass;
};
