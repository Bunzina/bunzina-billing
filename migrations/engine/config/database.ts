import { SQL } from 'bun';

const appEnv = process.env.APP_ENV || process.env.NODE_ENV || 'dev';

let connectionString: string;

if (appEnv === 'prod') {
  const prodDatabaseUrl = process.env.PROD_DATABASE_URL;
  if (prodDatabaseUrl) {
    connectionString = prodDatabaseUrl;
  } else {
    const host = process.env.PROD_DB_HOST;
    const user = process.env.PROD_DB_USER;
    const pass = process.env.PROD_DB_PASSWORD;
    const port = process.env.PROD_DB_PORT;
    const name = process.env.PROD_DB_NAME;
    connectionString = `postgres://${user}:${pass}@${host}:${port}/${name}`;
  }
} else {
  connectionString =
    process.env.DATABASE_URL || 'postgres://bun:bun@db:5432/bunzina';
}

// prepare:false -> compatível com o transaction-mode pooler do Supabase (porta 6543).
export const db = new SQL(connectionString, { prepare: false });
