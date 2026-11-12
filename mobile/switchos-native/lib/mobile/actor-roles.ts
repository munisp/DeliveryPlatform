/**
 * Actor-role detection for tab gating (P4-N).
 *
 * Mirrors the admin-gate pattern in app/(tabs)/_layout.tsx (href: null while
 * the role is unproven). The operator session only distinguishes
 * "user"/"admin" (operator-session.ts); courier/merchant identity lives in
 * the PowerSync token claims, so these roles are detected from the replica:
 * a courier session syncs a `drivers` row (courier_assignments bucket pins
 * token driver_id); a merchant session syncs a `service_providers` row
 * (merchant_store bucket pins token provider_id). Fail-closed: both roles
 * stay false until a completed sync proves them, and stay false on web /
 * Expo Go where the replica is unavailable.
 */
import { useEffect, useState } from "react";

import {
  getPowerSyncDatabase,
  usePowerSyncStatus,
} from "@/lib/powersync/PowerSyncProvider";

export type ActorRoles = {
  isCourier: boolean;
  isMerchant: boolean;
  loading: boolean;
};

/** Pure role decision from probe results (unit-tested). */
export function decideActorRoles(input: {
  hasSynced: boolean;
  driverRowCount: number | null;
  providerRowCount: number | null;
}): { isCourier: boolean; isMerchant: boolean } {
  if (!input.hasSynced) return { isCourier: false, isMerchant: false };
  return {
    isCourier: (input.driverRowCount ?? 0) > 0,
    isMerchant: (input.providerRowCount ?? 0) > 0,
  };
}

export function useActorRoles(pollMs = 10_000): ActorRoles {
  const status = usePowerSyncStatus();
  const [roles, setRoles] = useState<{ isCourier: boolean; isMerchant: boolean }>({
    isCourier: false,
    isMerchant: false,
  });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const probe = async () => {
      if (!status.hasSynced) {
        if (!cancelled) {
          setRoles({ isCourier: false, isMerchant: false });
          setLoading(false);
        }
        return;
      }
      const db = await getPowerSyncDatabase();
      if (!db || cancelled) {
        if (!cancelled) setLoading(false);
        return;
      }
      try {
        const driverRows = await db.getAll<{ id: string }>(
          "SELECT id FROM drivers LIMIT 1",
        );
        const providerRows = await db.getAll<{ id: string }>(
          "SELECT id FROM service_providers LIMIT 1",
        );
        if (cancelled) return;
        setRoles(
          decideActorRoles({
            hasSynced: true,
            driverRowCount: driverRows.length,
            providerRowCount: providerRows.length,
          }),
        );
        setLoading(false);
      } catch {
        if (!cancelled) setLoading(false);
      }
    };

    void probe();
    timer = setInterval(() => void probe(), pollMs);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [status.hasSynced, pollMs]);

  return { ...roles, loading };
}
