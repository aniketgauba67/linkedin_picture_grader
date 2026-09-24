#!/usr/bin/env bash
#
# Boots a throwaway Postgres for the migration integration tests.
#
# `supabase start` is the real thing and needs Docker. This is the
# fallback for machines and CI runners without it: a bare cluster with
# pgvector and pg_cron, which is everything the migrations touch. The
# auth and storage objects Supabase would provide come from
# test/supabase-shim.sql.
#
#   macOS:  brew install postgresql@17 pgvector pg_cron
#   Debian: apt-get install postgresql-17 postgresql-17-pgvector postgresql-17-cron
#
# Usage:
#   ./scripts/pg-test-server.sh start
#   export PPS_TEST_DATABASE_URL="postgresql://postgres@localhost:55432/pps_test"
#   pnpm --filter @pps/db test
#   ./scripts/pg-test-server.sh stop
set -euo pipefail

PORT="${PPS_TEST_PG_PORT:-55432}"
DB_NAME="pps_test"
PGDATA="${PPS_TEST_PGDATA:-${TMPDIR:-/tmp}/pps-pgdata}"

if [ -n "${PPS_TEST_PG_BIN:-}" ]; then
  PGBIN="$PPS_TEST_PG_BIN"
elif command -v pg_ctl >/dev/null 2>&1; then
  PGBIN="$(dirname "$(command -v pg_ctl)")"
elif [ -d /opt/homebrew/opt/postgresql@17/bin ]; then
  PGBIN=/opt/homebrew/opt/postgresql@17/bin
else
  echo "Could not find pg_ctl. Set PPS_TEST_PG_BIN to your Postgres bin directory." >&2
  exit 1
fi

start() {
  if [ ! -d "$PGDATA" ]; then
    mkdir -p "$PGDATA"
    "$PGBIN/initdb" -D "$PGDATA" -U postgres -E UTF8 >/dev/null
    {
      echo "port = $PORT"
      echo "listen_addresses = 'localhost'"
      # A scratch data directory often sits past the 103-byte limit on a
      # unix socket path, so this cluster is TCP only.
      echo "unix_socket_directories = ''"
      echo "shared_preload_libraries = 'pg_cron'"
      echo "cron.database_name = '$DB_NAME'"
      echo "fsync = off"
      echo "full_page_writes = off"
    } >> "$PGDATA/postgresql.conf"
  fi

  "$PGBIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" -w start
  "$PGBIN/psql" -h localhost -p "$PORT" -U postgres -d postgres -q \
    -c "select 1 from pg_database where datname = '$DB_NAME'" -tA | grep -q 1 \
    || "$PGBIN/psql" -h localhost -p "$PORT" -U postgres -d postgres -q \
         -c "create database $DB_NAME"

  echo
  echo "Ready. Run the integration tests with:"
  echo "  export PPS_TEST_DATABASE_URL=\"postgresql://postgres@localhost:$PORT/$DB_NAME\""
}

stop() {
  "$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w stop || true
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  destroy) stop; rm -rf "$PGDATA"; echo "removed $PGDATA" ;;
  *) echo "usage: $0 {start|stop|destroy}" >&2; exit 1 ;;
esac
