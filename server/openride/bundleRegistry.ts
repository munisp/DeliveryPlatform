/**
 * OpenRide Phase 3 (contract C3) — offline bundle manifest + geocoder proxy.
 *
 * tRPC routers:
 *   - openrideBundles.list  (public)        → {"schema":"openride.bundles.v1", bundles:[...]}
 *   - openrideGeo.search    (authenticated) → proxy to the server-hosted
 *     OpenRide geocoder service (GET {OPENRIDE_GEO_URL}/search?q=&lat=&lon=).
 *
 * Configuration:
 *   BUNDLE_REGISTRY          JSON array of bundle entries (overrides the
 *                            checked-in default below). File entries may use
 *                            either an absolute "url" or a "path" resolved
 *                            against OPENRIDE_BUNDLE_BASE_URL.
 *   OPENRIDE_BUNDLE_BASE_URL Base URL prepended to bundle file paths.
 *   OPENRIDE_GEO_URL         Base URL of the Dart geocoder service. Fail
 *                            closed (TRPCError) when unset.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { authenticatedProcedure, publicProcedure, router } from "../_core/trpc";

const GEO_PROXY_TIMEOUT_MS = 3_000;

const bundleFileSchema = z.object({
  url: z.string().url().optional(),
  path: z.string().trim().min(1).max(512).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

const bundleEntrySchema = z.object({
  city: z.string().trim().min(2).max(64),
  version: z.string().trim().min(4).max(32),
  bounds: z.object({
    minLat: z.number().min(-90).max(90),
    minLon: z.number().min(-180).max(180),
    maxLat: z.number().min(-90).max(90),
    maxLon: z.number().min(-180).max(180),
  }),
  sizeBytes: z.number().int().positive(),
  files: z.object({
    graph: bundleFileSchema,
    tiles: bundleFileSchema,
    geocoder: bundleFileSchema,
  }),
});

type BundleEntry = z.infer<typeof bundleEntrySchema>;

/**
 * Checked-in default registry (contract C3 example values for Lagos).
 * NOTE: the spec ships placeholder digests ("sha256":"..."); the values below
 * MUST be replaced with the real artifact digests at first publish — until
 * then prefer the BUNDLE_REGISTRY env var in any real deployment.
 */
const DEFAULT_BUNDLE_REGISTRY: BundleEntry[] = [
  {
    city: "lagos",
    version: "2026-11-09",
    bounds: { minLat: 6.4, minLon: 3.2, maxLat: 6.7, maxLon: 3.55 },
    sizeBytes: 148_000_000,
    files: {
      graph: {
        path: "lagos/2026-11-09/graph.bin",
        sha256:
          "0000000000000000000000000000000000000000000000000000000000000000",
      },
      tiles: {
        path: "lagos/2026-11-09/tiles.mbtiles",
        sha256:
          "0000000000000000000000000000000000000000000000000000000000000000",
      },
      geocoder: {
        path: "lagos/2026-11-09/geocoder.bin",
        sha256:
          "0000000000000000000000000000000000000000000000000000000000000000",
      },
    },
  },
];

function bundleBaseUrl(): string {
  return (
    process.env.OPENRIDE_BUNDLE_BASE_URL?.trim() ||
    "https://bundles.deliveryplatform.example/openride"
  );
}

function loadRegistry(): BundleEntry[] {
  const raw = process.env.BUNDLE_REGISTRY?.trim();
  if (!raw) {
    return DEFAULT_BUNDLE_REGISTRY;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "BUNDLE_REGISTRY_INVALID_JSON",
      cause: error,
    });
  }
  const result = z.array(bundleEntrySchema).safeParse(parsed);
  if (!result.success) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "BUNDLE_REGISTRY_INVALID_SHAPE",
      cause: result.error,
    });
  }
  return result.data;
}

function resolveFileUrl(file: z.infer<typeof bundleFileSchema>): string {
  if (file.url) {
    return file.url;
  }
  const base = bundleBaseUrl().replace(/\/+$/, "");
  const path = (file.path ?? "").replace(/^\/+/, "");
  return `${base}/${path}`;
}

function toManifest(registry: BundleEntry[]) {
  return {
    schema: "openride.bundles.v1" as const,
    bundles: registry.map((entry) => ({
      city: entry.city,
      version: entry.version,
      bounds: entry.bounds,
      sizeBytes: entry.sizeBytes,
      files: {
        graph: {
          url: resolveFileUrl(entry.files.graph),
          sha256: entry.files.graph.sha256,
        },
        tiles: {
          url: resolveFileUrl(entry.files.tiles),
          sha256: entry.files.tiles.sha256,
        },
        geocoder: {
          url: resolveFileUrl(entry.files.geocoder),
          sha256: entry.files.geocoder.sha256,
        },
      },
    })),
  };
}

export const openrideBundlesRouter = router({
  list: publicProcedure.query(() => toManifest(loadRegistry())),
});

/**
 * Contract C3 geo search I/O — field names are FROZEN and shared with the
 * mobile client (PlaceSearchField), which typechecks against AppRouter.
 */
export const openrideGeoSearchInput = z.object({
  q: z.string().trim().min(1).max(200),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export const openrideGeoSearchResultSchema = z.array(
  z.object({
    name: z.string(),
    kind: z.string(),
    lat: z.number(),
    lon: z.number(),
    distanceM: z.number().nullable().optional(),
  }),
);

export type OpenrideGeoSearchResult = z.infer<
  typeof openrideGeoSearchResultSchema
>;

export const openrideGeoRouter = router({
  /**
   * Proxy to the server-hosted OpenRide geocoder (same Dart search code as the
   * app, serving from a bundle's geocoder.bin). 3 s timeout; fails closed with
   * a clear error when OPENRIDE_GEO_URL is not configured.
   */
  search: authenticatedProcedure
    .input(openrideGeoSearchInput)
    .query(async ({ input }): Promise<OpenrideGeoSearchResult> => {
      const base = process.env.OPENRIDE_GEO_URL?.trim();
      if (!base) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "OPENRIDE_GEO_URL_NOT_CONFIGURED",
        });
      }

      const url = new URL("/search", base.endsWith("/") ? base : `${base}/`);
      url.searchParams.set("q", input.q);
      if (input.lat !== undefined) url.searchParams.set("lat", String(input.lat));
      if (input.lon !== undefined) url.searchParams.set("lon", String(input.lon));
      if (input.limit !== undefined)
        url.searchParams.set("limit", String(input.limit));

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(GEO_PROXY_TIMEOUT_MS),
        });
      } catch (error) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "OPENRIDE_GEO_UNREACHABLE",
          cause: error,
        });
      }

      if (!response.ok) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: `OPENRIDE_GEO_UPSTREAM_${response.status}`,
        });
      }

      // Validate the upstream payload so the AppRouter output type stays
      // exactly the contract shape the mobile client compiles against.
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "OPENRIDE_GEO_INVALID_RESPONSE",
          cause: error,
        });
      }
      const parsed = openrideGeoSearchResultSchema.safeParse(payload);
      if (!parsed.success) {
        throw new TRPCError({
          code: "SERVICE_UNAVAILABLE",
          message: "OPENRIDE_GEO_INVALID_RESPONSE",
          cause: parsed.error,
        });
      }
      return parsed.data;
    }),
});
