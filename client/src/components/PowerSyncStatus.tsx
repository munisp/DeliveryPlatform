import { CloudOff, RefreshCw, CheckCircle2 } from "lucide-react";

import { usePowerSyncStatus } from "@/lib/usePowerSync";

/**
 * Offline-sync status pill for the consumer account surface.
 *
 * Visual vocabulary matches ConsumerLayout: quiet low-saturation pills
 * (stone baseline, cyan for active syncing, amber for offline/queued work).
 * Renders nothing when offline sync is unavailable (unsupported browser) or
 * when the user is signed out — the app simply behaves online-only.
 */
export function PowerSyncStatus() {
  const status = usePowerSyncStatus();

  if (!status.available) return null;

  const pillClass =
    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium";

  if (!status.connected && !status.connecting) {
    return (
      <span
        className={`${pillClass} bg-amber-100 text-amber-800`}
        role="status"
        aria-live="polite"
        title="You are offline. Changes are stored on this device and will sync when you are back online."
      >
        <CloudOff className="h-3.5 w-3.5" />
        {status.uploadQueueSize > 0
          ? `Offline — ${status.uploadQueueSize} queued`
          : "Offline"}
      </span>
    );
  }

  if (
    status.connecting ||
    status.downloading ||
    status.uploading ||
    !status.hasSynced
  ) {
    return (
      <span
        className={`${pillClass} bg-cyan-50 text-cyan-800`}
        role="status"
        aria-live="polite"
      >
        <RefreshCw className="h-3.5 w-3.5 animate-spin" />
        {status.uploadQueueSize > 0
          ? `Syncing — ${status.uploadQueueSize} queued`
          : "Syncing"}
      </span>
    );
  }

  return (
    <span
      className={`${pillClass} bg-stone-100 text-stone-600`}
      role="status"
      title={
        status.lastSyncAt
          ? `Last synced ${new Date(status.lastSyncAt).toLocaleString()}`
          : undefined
      }
    >
      <CheckCircle2 className="h-3.5 w-3.5 text-cyan-700" />
      Synced
    </span>
  );
}
