// Preload of the integration suite. Those tests TRUNCATE tables, so they only
// ever run against a throwaway local Postgres (`docker compose up db-test`).
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

process.env.DATABASE_URL ??=
  'postgres://bun:bun@localhost:5433/bunzina-billing-test';

const appEnv = process.env.APP_ENV || process.env.NODE_ENV;

if (appEnv === 'prod' || appEnv === 'production') {
  throw new Error('Integration tests refuse to run with APP_ENV=prod.');
}

const url = new URL(process.env.DATABASE_URL);
const database = url.pathname.replace(/^\//, '');

if (!LOCAL_HOSTS.has(url.hostname) || !/[-_]test$/.test(database)) {
  throw new Error(
    `Integration tests TRUNCATE tables and only run against a local test ` +
      `database (host localhost, name ending in "-test"). Got ` +
      `${url.hostname}/${database}.`,
  );
}
