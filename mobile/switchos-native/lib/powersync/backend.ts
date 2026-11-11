/**
 * Storage-backend selection for the PowerSync client (pure — unit-tested
 * in Node; the provider wires the actual platform values).
 *
 *   - Dev client / production build: @op-engineering/op-sqlite via
 *     @powersync/op-sqlite (OPSqliteOpenFactory) — the default. Requires a
 *     dev build; Expo Go cannot load the native module.
 *   - Expo Go (Constants.appOwnership === 'expo'): @powersync/adapter-sql-js
 *     (SQLJSOpenFactory) fallback — JS/WASM SQLite, in-memory unless a
 *     persister is configured; sync works for the session only.
 *   - Web: unsupported here — the PWA (client/src/lib/powersync.ts) owns the
 *     web sync path (wa-sqlite/OPFS); the RN web build stays tRPC-only.
 */
export type PowerSyncSqliteBackend = "op-sqlite" | "sql-js" | "unsupported";

export function selectSqliteBackend(env: {
  platform: string;
  appOwnership: string | null | undefined;
}): PowerSyncSqliteBackend {
  if (env.platform === "web") {
    return "unsupported";
  }
  if (env.appOwnership === "expo") {
    return "sql-js";
  }
  return "op-sqlite";
}
