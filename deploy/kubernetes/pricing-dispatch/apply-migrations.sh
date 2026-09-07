#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL must be provided}"

for migration in /migrations/*.sql; do
  echo "Applying $(basename "$migration")"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
done

