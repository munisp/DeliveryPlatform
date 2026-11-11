/**
 * React provider that owns the PowerSync sync lifecycle for the PWA.
 *
 * Connects the lazily-initialised local database (lib/powersync.ts) as soon
 * as an authenticated session exists (lib/sessionProfile.ts) and disconnects
 * on logout. Pages read sync state through `usePowerSyncStatus`; the UI pill
 * lives in components/PowerSyncStatus.tsx.
 *
 * Written without JSX so this stays a .ts module (see main.tsx wiring).
 */
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type {
  AbstractPowerSyncDatabase,
  SyncStatus,
} from "@powersync/web";

import {
  disconnectPowerSync,
  getPowerSyncConnector,
  getPowerSyncDatabase,
} from "./powersync";
import { reportClientError } from "./logger";
import { useSessionProfile } from "./sessionProfile";

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
  /** Number of local writes still waiting in the FIFO upload queue. */
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

/** Sync status for pages/components (see components/PowerSyncStatus.tsx). */
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
  const sessionQuery = useSessionProfile();
  const userId = sessionQuery.data?.id ?? null;
  const [status, setStatus] = useState<PowerSyncStatusSnapshot>(
    DEFAULT_POWERSYNC_STATUS,
  );

  useEffect(() => {
    if (userId == null) {
      // Signed out (or session expired): stop syncing and reset the pill.
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
        // Transient read failure while the worker is (re)starting; the next
        // poll or status change refreshes the count.
      }
    };

    (async () => {
      const db = await getPowerSyncDatabase();
      if (cancelled) return;
      if (!db) {
        // Unsupported browser / init failure: stay in online-only mode.
        setStatus(DEFAULT_POWERSYNC_STATUS);
        return;
      }

      removeListener = db.registerListener({
        statusChanged: (syncStatus) => {
          if (cancelled) return;
          setStatus((previous) =>
            snapshotFromSyncStatus(previous, syncStatus),
          );
          void refreshQueueSize(db);
        },
      });

      setStatus((previous) =>
        snapshotFromSyncStatus(previous, db.currentStatus),
      );
      await refreshQueueSize(db);
      queueTimer = setInterval(() => void refreshQueueSize(db), 5_000);

      try {
        await db.connect(getPowerSyncConnector());
      } catch (error) {
        if (!cancelled) reportClientError("powersync.connect_failed", error);
      }
    })().catch((error) => {
      if (!cancelled) reportClientError("powersync.setup_failed", error);
    });

    return () => {
      cancelled = true;
      removeListener?.();
      if (queueTimer) clearInterval(queueTimer);
    };
  }, [userId]);

  return createElement(
    PowerSyncStatusContext.Provider,
    { value: status },
    children,
  );
}
