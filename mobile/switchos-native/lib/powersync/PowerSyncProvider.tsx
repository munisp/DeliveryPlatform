/**
 * PowerSync provider for SwitchOS Native — owns the offline DATA sync
 * lifecycle (server→client replicas + whitelisted client writes).
 *
 * BOUNDARY with the existing offline layer: lib/mobile/offline-sync-sqlite.ts
 * is the operator ACTION outbox (user-initiated actions needing guaranteed
 * execution). It stays untouched. PowerSync owns replicated read data plus
 * the whitelisted upload path (v1: support_tickets PUT via
 * lib/powersync/localWrites.ts). See docs/powersync/CLIENT_MOBILE.md.
 *
 * Storage engine:
 *   - Dev client / production build: @op-engineering/op-sqlite via
 *     @powersync/op-sqlite (OPSqliteOpenFactory) — the default.
 *   - Expo Go: @powersync/adapter-sql-js (SQLJSOpenFactory) fallback —
 *     in-memory unless a persister is configured; sync still works for a
 *     session. Detected via Constants.appOwnership === 'expo'.
 *   - Web: unsupported here (the PWA owns that path); parks cleanly.
 *
 * Any failure anywhere in this module degrades to online-only mode with a
 * logged warning. PowerSync must NEVER crash the app.
 */
import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Platform } from "react-native";
import Constants from "expo-constants";
import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  SyncStatus,
} from "@powersync/common";

import { getApiBaseUrl } from "@/constants/oauth";
import * as Auth from "@/lib/_core/auth";
import { useAuth } from "@/hooks/use-auth";
import { MobilePowerSyncConnector } from "./connector";
import { selectSqliteBackend, type PowerSyncSqliteBackend } from "./backend";

const POWERSYNC_DB_FILENAME = "switchos-powersync.db";

export { selectSqliteBackend, type PowerSyncSqliteBackend } from "./backend";

// ---------------------------------------------------------------------------
// Lazy database singleton
// ---------------------------------------------------------------------------

let databasePromise: Promise<AbstractPowerSyncDatabase | null> | null = null;

async function createPowerSyncDatabase(): Promise<AbstractPowerSyncDatabase | null> {
  const backend = selectSqliteBackend({
    platform: Platform.OS,
    appOwnership: Constants.appOwnership,
  });
  if (backend === "unsupported") {
    console.warn(
      "[powersync] offline data sync is not available on this platform; " +
        "continuing in online-only mode.",
    );
    return null;
  }

  try {
    const [{ PowerSyncDatabase }, schemaModule] = await Promise.all([
      import("@powersync/react-native"),
      import("./schema"),
    ]);

    let factory;
    if (backend === "op-sqlite") {
      const { OPSqliteOpenFactory } = await import("@powersync/op-sqlite");
      factory = new OPSqliteOpenFactory({ dbFilename: POWERSYNC_DB_FILENAME });
    } else {
      const { SQLJSOpenFactory } = await import("@powersync/adapter-sql-js");
      // No persister: session-scoped in-memory database (Expo Go fallback).
      factory = new SQLJSOpenFactory({ dbFilename: `${POWERSYNC_DB_FILENAME}.sqljs` });
    }

    return new PowerSyncDatabase({
      database: factory,
      schema: schemaModule.PowerSyncAppSchema,
    });
  } catch (error) {
    // Allow a later retry after a transient failure (e.g. OOM during init).
    databasePromise = null;
    console.warn(
      "[powersync] failed to initialise offline sync; continuing in online-only mode.",
      error,
    );
    return null;
  }
}

/** Lazily-initialised singleton database; null when unsupported/failed. */
export function getPowerSyncDatabase(): Promise<AbstractPowerSyncDatabase | null> {
  if (!databasePromise) {
    databasePromise = createPowerSyncDatabase();
  }
  return databasePromise;
}

let connector: MobilePowerSyncConnector | null = null;

/** Shared connector bound to the app's session mechanism. */
export function getPowerSyncConnector(): PowerSyncBackendConnector {
  connector ??= new MobilePowerSyncConnector({
    getBaseUrl: () => getApiBaseUrl(),
    getSessionToken: () => Auth.getSessionToken(),
  });
  return connector;
}

/** Stops syncing (e.g. on logout). Local data is kept for the next sign-in. */
export async function disconnectPowerSync(): Promise<void> {
  if (!databasePromise) return;
  const pending = databasePromise;
  databasePromise = null;
  const db = await pending.catch(() => null);
  try {
    await db?.disconnect();
  } catch (error) {
    console.warn("[powersync] disconnect failed", error);
  }
}

// ---------------------------------------------------------------------------
// Status context
// ---------------------------------------------------------------------------

export type PowerSyncStatusSnapshot = {
  /** False while unauthenticated, unsupported, or still initialising. */
  available: boolean;
  connected: boolean;
  connecting: boolean;
  /** True once at least one full sync has completed. */
  hasSynced: boolean;
  /** ISO timestamp of the last completed sync, if any. */
  lastSyncAt: string | null;
  uploading: boolean;
  downloading: boolean;
  /** Local writes still waiting in the FIFO upload queue. */
  uploadQueueSize: number;
  /** Download progress 0..1 for the current sync iteration, if running. */
  downloadProgress: number | null;
};

export const DEFAULT_POWERSYNC_STATUS: PowerSyncStatusSnapshot = {
  available: false,
  connected: false,
  connecting: false,
  hasSynced: false,
  lastSyncAt: null,
  uploading: false,
  downloading: false,
  uploadQueueSize: 0,
  downloadProgress: null,
};

const PowerSyncStatusContext = createContext<PowerSyncStatusSnapshot>(
  DEFAULT_POWERSYNC_STATUS,
);

/** Sync status for screens (Queue tab "Data sync (PowerSync)" section). */
export function usePowerSyncStatus(): PowerSyncStatusSnapshot {
  return useContext(PowerSyncStatusContext);
}

function snapshotFromSyncStatus(
  previous: PowerSyncStatusSnapshot,
  status: SyncStatus,
): PowerSyncStatusSnapshot {
  return {
    ...previous,
    available: true,
    connected: status.connected,
    connecting: status.connecting,
    hasSynced: status.hasSynced ?? previous.hasSynced,
    lastSyncAt: status.lastSyncedAt
      ? status.lastSyncedAt.toISOString()
      : previous.lastSyncAt,
    uploading: status.dataFlowStatus.uploading ?? false,
    downloading: status.dataFlowStatus.downloading ?? false,
    downloadProgress: status.downloadProgress
      ? status.downloadProgress.downloadedFraction
      : null,
  };
}

export function PowerSyncProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [status, setStatus] = useState<PowerSyncStatusSnapshot>(
    DEFAULT_POWERSYNC_STATUS,
  );

  useEffect(() => {
    if (!isAuthenticated) {
      // Signed out (or session expired): stop syncing and reset status.
      setStatus(DEFAULT_POWERSYNC_STATUS);
      void disconnectPowerSync();
      return;
    }

    let cancelled = false;
    let removeListener: (() => void) | undefined;
    let queueTimer: ReturnType<typeof setInterval> | undefined;

    const refreshQueueSize = async (db: AbstractPowerSyncDatabase) => {
      try {
        const stats = await db.getUploadQueueStats();
        if (!cancelled) {
          setStatus((previous) => ({
            ...previous,
            uploadQueueSize: stats.count,
          }));
        }
      } catch {
        // Transient read while the database is (re)starting; the next poll
        // or status change refreshes the count.
      }
    };

    (async () => {
      const db = await getPowerSyncDatabase();
      if (cancelled) return;
      if (!db) {
        setStatus(DEFAULT_POWERSYNC_STATUS);
        return;
      }

      removeListener = db.registerListener({
        statusChanged: (syncStatus) => {
          if (cancelled) return;
          setStatus((previous) => snapshotFromSyncStatus(previous, syncStatus));
          void refreshQueueSize(db);
        },
      });

      setStatus((previous) => snapshotFromSyncStatus(previous, db.currentStatus));
      await refreshQueueSize(db);
      queueTimer = setInterval(() => void refreshQueueSize(db), 5_000);

      try {
        await db.connect(getPowerSyncConnector());
      } catch (error) {
        if (!cancelled) {
          console.warn("[powersync] connect failed; online-only mode.", error);
        }
      }
    })().catch((error) => {
      if (!cancelled) {
        console.warn("[powersync] setup failed; online-only mode.", error);
      }
    });

    return () => {
      cancelled = true;
      removeListener?.();
      if (queueTimer) clearInterval(queueTimer);
    };
  }, [isAuthenticated]);

  return (
    <PowerSyncStatusContext.Provider value={status}>
      {children}
    </PowerSyncStatusContext.Provider>
  );
}
