#!/usr/bin/env bash
# Runs the integration suite against a throwaway local Postgres (db-test, tmpfs).
set -uo pipefail
cd "$(dirname "$0")/.."

docker compose up -d --wait db-test || exit 1
bun run test:integration:run "$@"
status=$?
docker compose rm -sfv db-test >/dev/null
exit $status
