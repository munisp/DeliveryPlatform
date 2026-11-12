/**
 * Consumer marketplace catalog source (P2-C).
 *
 * SOURCE OF TRUTH SWAP: the live read path targets the consumerCatalog
 * router (consumerVerticals / consumerProviders / consumerCatalog,
 * authenticatedProcedure) being landed concurrently by coder P2-A
 * (server/_core/consumerCatalog.ts). Until that router exists on the
 * deployed API, live calls fail with a tRPC NOT_FOUND and this module falls
 * back to the MOCK_* fixtures below. Swap to the real router by deleting
 * the mock fallback once `consumerCatalog` is confirmed on main — the hook
 * signatures and contractual shapes already match:
 *
 *   verticals {id,name,slug,description,icon}[]
 *   providers {id,verticalId,name,businessName,address,rating,status}[]
 *   catalog   {id,providerId,sku,itemName,description,priceMajor,currency}[]
 *
 * Offline behavior: when the PowerSync status reports disconnected, reads
 * come from the local replica tables (service_verticals, service_providers,
 * provider_catalog_items) via lib/consumerOffline.ts. Catalog prices stay
 * TEXT major units end-to-end (formatMajorAmount for display;
 * parseMajorToMinor before sending unitPriceMinor to addCartItem).
 */
import { useMemo } from "react";

import { trpc } from "@/lib/trpc";
import {
  useConsumerDataMode,
  useReplicaQuery,
  type ReplicaCatalogItemRow,
  type ReplicaProviderRow,
  type ReplicaVerticalRow,
} from "@/lib/consumerOffline";

// ---------------------------------------------------------------------------
// Contractual shapes
// ---------------------------------------------------------------------------

export type CatalogVertical = {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
};

export type CatalogProvider = {
  id: number;
  verticalId: number;
  name: string;
  businessName: string | null;
  address: string | null;
  /** TEXT major-safe decimal ("4.60"). */
  rating: string | null;
  status: string;
};

export type CatalogItem = {
  id: number;
  providerId: number;
  sku: string;
  itemName: string;
  description: string | null;
  /** TEXT MAJOR units (provider_catalog_items.price). */
  priceMajor: string;
  currency: string;
};

export type CatalogSourceKind = "live" | "offline-replica" | "mock";

export type CatalogResult<T> = {
  rows: T[];
  source: CatalogSourceKind;
  loading: boolean;
};

// ---------------------------------------------------------------------------
// Mock fixtures (temporary — deleted with the fallback after P2-A lands)
// ---------------------------------------------------------------------------

const MOCK_VERTICALS: CatalogVertical[] = [
  { id: 1, name: "Food & Groceries", slug: "food", description: "Restaurants, markets, essentials", icon: "cart" },
  { id: 2, name: "Mobility", slug: "mobility", description: "Rides and courier delivery", icon: "car" },
  { id: 3, name: "Home Services", slug: "home", description: "Cleaning, repairs, care", icon: "home" },
];

const MOCK_PROVIDERS: CatalogProvider[] = [
  { id: 11, verticalId: 1, name: "Amala Spot", businessName: "Amala Spot Ltd", address: "12 Broad St, Lagos", rating: "4.60", status: "active" },
  { id: 12, verticalId: 1, name: "FreshMart", businessName: "FreshMart NG", address: "4 Adeola Odeku, VI", rating: "4.30", status: "active" },
  { id: 21, verticalId: 2, name: "SwiftMove", businessName: "SwiftMove Logistics", address: "Ikeja, Lagos", rating: "4.80", status: "active" },
  { id: 31, verticalId: 3, name: "HomeFix Pros", businessName: "HomeFix Pros", address: "Lekki Phase 1", rating: "4.10", status: "active" },
];

const MOCK_ITEMS: CatalogItem[] = [
  { id: 111, providerId: 11, sku: "AMALA-CLASSIC", itemName: "Amala + Ewedu + Gbegiri", description: "Classic combo, assorted meat", priceMajor: "2500.00", currency: "NGN" },
  { id: 112, providerId: 11, sku: "JOLLOF-CHICKEN", itemName: "Jollof Rice + Chicken", description: "Party-style jollof", priceMajor: "3200.00", currency: "NGN" },
  { id: 121, providerId: 12, sku: "GROCERY-BOX-S", itemName: "Grocery Box (Small)", description: "Weekly essentials", priceMajor: "18500.00", currency: "NGN" },
  { id: 211, providerId: 21, sku: "RIDE-TOWN", itemName: "Town Ride", description: "Within-city ride, up to 15km", priceMajor: "4500.00", currency: "NGN" },
  { id: 311, providerId: 31, sku: "CLEAN-2BR", itemName: "2-Bedroom Deep Clean", description: "Full deep clean, supplies included", priceMajor: "35000.00", currency: "NGN" },
];

// ---------------------------------------------------------------------------
// Bridge (consumerCatalog lands separately — see header)
// ---------------------------------------------------------------------------

const bridge = trpc as any;

function asQuery<T>(query: unknown): T {
  return query as T;
}

function useLiveVerticals() {
  return asQuery<{ data: CatalogVertical[] | undefined; isLoading: boolean; isError: boolean }>(
    bridge.consumerCatalog?.consumerVerticals?.useQuery?.(undefined, { retry: false }),
  );
}

function useLiveProviders(verticalId: number | null) {
  return asQuery<{ data: CatalogProvider[] | undefined; isLoading: boolean; isError: boolean }>(
    bridge.consumerCatalog?.consumerProviders?.useQuery?.(
      { verticalId: verticalId ?? -1 },
      { enabled: verticalId !== null, retry: false },
    ),
  );
}

function useLiveCatalog(providerId: number | null) {
  return asQuery<{ data: CatalogItem[] | undefined; isLoading: boolean; isError: boolean }>(
    bridge.consumerCatalog?.consumerCatalog?.useQuery?.(
      { providerId: providerId ?? -1 },
      { enabled: providerId !== null, retry: false },
    ),
  );
}

// ---------------------------------------------------------------------------
// Replica row -> contract mappers
// ---------------------------------------------------------------------------

export function mapReplicaVertical(row: ReplicaVerticalRow): CatalogVertical {
  return {
    id: Number(row.id),
    name: row.name,
    slug: row.slug,
    description: row.description,
    icon: row.icon,
  };
}

export function mapReplicaProvider(row: ReplicaProviderRow): CatalogProvider {
  return {
    id: Number(row.id),
    verticalId: Number(row.vertical_id),
    name: row.name,
    businessName: row.business_name,
    address: row.address,
    rating: row.rating,
    status: row.status,
  };
}

export function mapReplicaCatalogItem(row: ReplicaCatalogItemRow): CatalogItem {
  return {
    id: Number(row.id),
    providerId: Number(row.provider_id),
    sku: row.sku,
    itemName: row.item_name,
    description: row.description,
    priceMajor: row.price,
    currency: row.currency,
  };
}

// ---------------------------------------------------------------------------
// Public hooks
// ---------------------------------------------------------------------------

/** Verticals: live -> offline replica -> mock fallback (router not landed). */
export function useCatalogVerticals(): CatalogResult<CatalogVertical> {
  const { mode } = useConsumerDataMode();
  const live = useLiveVerticals();
  const replica = useReplicaQuery<ReplicaVerticalRow, CatalogVertical>(
    mode === "offline-replica",
    `SELECT id, name, slug, description, icon
       FROM service_verticals
      WHERE COALESCE(is_active, 1) = 1
      ORDER BY name`,
    [],
    mapReplicaVertical,
  );

  return useMemo(() => {
    if (mode === "offline-replica") {
      return { rows: replica.rows, source: "offline-replica", loading: !replica.loaded };
    }
    if (live.data) return { rows: live.data, source: "live", loading: false };
    if (live.isLoading) return { rows: [], source: "live", loading: true };
    // Live failed (consumerCatalog router not deployed yet) -> mock.
    return { rows: MOCK_VERTICALS, source: "mock", loading: false };
  }, [mode, live.data, live.isLoading, replica.rows, replica.loaded]);
}

/** Providers for one vertical; null verticalId renders nothing. */
export function useCatalogProviders(verticalId: number | null): CatalogResult<CatalogProvider> {
  const { mode } = useConsumerDataMode();
  const live = useLiveProviders(verticalId);
  const replica = useReplicaQuery<ReplicaProviderRow, CatalogProvider>(
    mode === "offline-replica" && verticalId !== null,
    `SELECT id, vertical_id, name, business_name, address, rating, status
       FROM service_providers
      WHERE vertical_id = ?
      ORDER BY name`,
    [String(verticalId)],
    mapReplicaProvider,
  );

  return useMemo(() => {
    if (verticalId === null) return { rows: [], source: "live", loading: false };
    if (mode === "offline-replica") {
      return { rows: replica.rows, source: "offline-replica", loading: !replica.loaded };
    }
    if (live.data) return { rows: live.data, source: "live", loading: false };
    if (live.isLoading) return { rows: [], source: "live", loading: true };
    return {
      rows: MOCK_PROVIDERS.filter((provider) => provider.verticalId === verticalId),
      source: "mock",
      loading: false,
    };
  }, [verticalId, mode, live.data, live.isLoading, replica.rows, replica.loaded]);
}

/** Catalog items for one provider; null providerId renders nothing. */
export function useCatalogItems(providerId: number | null): CatalogResult<CatalogItem> {
  const { mode } = useConsumerDataMode();
  const live = useLiveCatalog(providerId);
  const replica = useReplicaQuery<ReplicaCatalogItemRow, CatalogItem>(
    mode === "offline-replica" && providerId !== null,
    `SELECT id, provider_id, sku, item_name, description, price, currency, is_available
       FROM provider_catalog_items
      WHERE provider_id = ? AND COALESCE(is_available, 1) = 1
      ORDER BY item_name`,
    [String(providerId)],
    mapReplicaCatalogItem,
  );

  return useMemo(() => {
    if (providerId === null) return { rows: [], source: "live", loading: false };
    if (mode === "offline-replica") {
      return { rows: replica.rows, source: "offline-replica", loading: !replica.loaded };
    }
    if (live.data) return { rows: live.data, source: "live", loading: false };
    if (live.isLoading) return { rows: [], source: "live", loading: true };
    return {
      rows: MOCK_ITEMS.filter((item) => item.providerId === providerId),
      source: "mock",
      loading: false,
    };
  }, [providerId, mode, live.data, live.isLoading, replica.rows, replica.loaded]);
}
