#!/usr/bin/env python3
"""pgserver-boot.py — start a throwaway PostgreSQL 16 for the perf harness.

Uses the `pgserver` pip package (PostgreSQL 16.2 binaries). The server listens
on a unix socket inside the data dir; connect with:

    postgresql://postgres@/deliveryplatform?host=<PGDATA>

Usage:
    pip install pgserver
    XDG_RUNTIME_DIR=/tmp/xdg-runtime python3 scripts/perf/pgserver-boot.py [pgdata]

Stays in the foreground; Ctrl-C stops the server. Default pgdata:
/tmp/pgdata-perf
"""
import os
import sys
import time

os.environ.setdefault("XDG_RUNTIME_DIR", "/tmp/xdg-runtime")
os.makedirs(os.environ["XDG_RUNTIME_DIR"], exist_ok=True)

import pgserver  # noqa: E402

pgdata = sys.argv[1] if len(sys.argv) > 1 else "/tmp/pgdata-perf"
srv = pgserver.get_server(pgdata)
uri = srv.get_uri()
print(f"[pgserver] URI: {uri}", flush=True)
print(f"[pgserver] DATABASE_URL base: postgresql://postgres@/postgres?host={pgdata}", flush=True)
print("[pgserver] create the bench DB with:", flush=True)
print(f"  psql -h {pgdata} -U postgres -c 'CREATE DATABASE deliveryplatform;'", flush=True)
try:
    while True:
        time.sleep(3600)
except KeyboardInterrupt:
    print("[pgserver] stopping", flush=True)
