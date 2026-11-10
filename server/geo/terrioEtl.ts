/**
 * server/geo/terrioEtl.ts — server-side geospatial ETL via the terrio CLI.
 *
 * terrio (https://github.com/opengeos/terrio, MIT) is a pure-Rust
 * GDAL/PROJ/PDAL replacement. This module wraps the `terrio` binary as the
 * platform's geospatial ETL engine; see docs/geo/TERRIO_INTEGRATION.md.
 *
 * Safety model:
 *   - node:child_process execFile only. No shell is ever spawned, and
 *     arguments are always passed as an array, so shell metacharacters in
 *     paths are inert.
 *   - Subcommands are allowlisted (ALLOWED_SUBCOMMANDS).
 *   - Paths must be absolute, free of null bytes and ".." traversal
 *     segments; the output parent directory must already exist.
 *   - Config fails closed: when TERRIO_BIN is unset, every entry point
 *     throws TerrioError with code "terrio_not_configured".
 *
 * Pure helpers (buildArgLists, validateEpsg, validatePaths, resolveTimeoutMs)
 * are exported so tests can exercise them without the real binary.
 */

import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;

/** Only the last 2KB of stderr is surfaced in failure errors. */
const STDERR_TAIL_CHARS = 2_048;

/** Only the last 2KB of stdout is returned as the run summary. */
const STDOUT_SUMMARY_CHARS = 2_048;

/** Subcommands this wrapper may ever execute (arg allowlist root). */
const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "convert",
  "--version",
]);

/** Accepted target CRS form. Nigeria is covered by UTM zones 31N-33N, i.e.
 * EPSG:32631, EPSG:32632 and EPSG:32633; EPSG:4326/3857 also pass. */
const EPSG_PATTERN = /^EPSG:\d{4,6}$/;

const MIN_ZOOM = 0;
const MAX_ZOOM = 24;

export class TerrioError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "TerrioError";
    this.code = code;
  }
}

export type PathPair = {
  inputPath: string;
  outputPath: string;
};

export type TerrioConfig = {
  bin: string;
  timeoutMs: number;
};

export type TerrioRunResult = {
  /** Trimmed stdout, truncated to the trailing 2KB. */
  stdout: string;
  durationMs: number;
};

/** Resolve TERRIO_TIMEOUT_MS, clamped to [1000, 600000]; default 120000. */
export function resolveTimeoutMs(raw: string | undefined): number {
  const parsed =
    raw === undefined || raw.trim() === "" ? NaN : Number.parseInt(raw, 10);
  const base = Number.isFinite(parsed) ? parsed : DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, base));
}

/** Fail-closed configuration: throws terrio_not_configured when unset. */
export function getTerrioConfig(): TerrioConfig {
  const bin = process.env.TERRIO_BIN?.trim();
  if (!bin) {
    throw new TerrioError(
      "terrio_not_configured",
      "TERRIO_BIN is not set; point it at the terrio binary to enable geospatial ETL",
    );
  }
  return { bin, timeoutMs: resolveTimeoutMs(process.env.TERRIO_TIMEOUT_MS) };
}

/** Validate a target CRS of the form EPSG:<4-6 digits>; returns it unchanged. */
export function validateEpsg(targetCrs: string): string {
  if (!EPSG_PATTERN.test(targetCrs)) {
    throw new TerrioError(
      "invalid_crs",
      `targetCrs must match ${EPSG_PATTERN.source} (e.g. EPSG:4326 or Nigeria's UTM zones EPSG:32631/32632/32633); got ${JSON.stringify(targetCrs)}`,
    );
  }
  return targetCrs;
}

function resolveSafePath(raw: string, label: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TerrioError("invalid_path", `${label} must be a non-empty string`);
  }
  if (raw.includes("\0")) {
    throw new TerrioError("invalid_path", `${label} must not contain null bytes`);
  }
  if (!path.isAbsolute(raw)) {
    throw new TerrioError(
      "invalid_path",
      `${label} must be absolute; got ${JSON.stringify(raw)}`,
    );
  }
  if (raw.split(/[\\/]+/).includes("..")) {
    throw new TerrioError(
      "invalid_path",
      `${label} must not contain ".." traversal segments; got ${JSON.stringify(raw)}`,
    );
  }
  return path.resolve(raw);
}

/**
 * Validate and normalize input/output paths: absolute, resolved, no null
 * bytes or traversal, and the output parent directory must already exist
 * (terrio is not used as a directory-creation oracle).
 */
export function validatePaths(paths: PathPair): PathPair {
  const inputPath = resolveSafePath(paths.inputPath, "inputPath");
  const outputPath = resolveSafePath(paths.outputPath, "outputPath");
  const parent = path.dirname(outputPath);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    throw new TerrioError(
      "output_parent_missing",
      `outputPath parent directory does not exist: ${JSON.stringify(parent)}`,
    );
  }
  return { inputPath, outputPath };
}

function validateZoom(value: number, label: string): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_ZOOM ||
    value > MAX_ZOOM
  ) {
    throw new TerrioError(
      "invalid_zoom",
      `${label} must be an integer in [${MIN_ZOOM}, ${MAX_ZOOM}]; got ${value}`,
    );
  }
  return value;
}

/**
 * Pure argv builders. Every pipeline is a single allowlisted subcommand with
 * an argument array — safe to hand to execFile verbatim.
 */
export const buildArgLists = {
  version(): string[] {
    return ["--version"];
  },

  /** OSM PBF → GeoParquet (Sedona/GeoLibre lakehouse ingest). */
  osmPbfToGeoParquet(paths: PathPair): string[] {
    return ["convert", paths.inputPath, paths.outputPath, "-f", "Parquet"];
  },

  /** Delivery-zone GeoJSON → PMTiles static vector tiles. */
  vectorToPmTiles(
    paths: PathPair & { minZoom?: number; maxZoom?: number },
  ): string[] {
    if (
      paths.minZoom !== undefined &&
      paths.maxZoom !== undefined &&
      paths.minZoom > paths.maxZoom
    ) {
      throw new TerrioError(
        "invalid_zoom",
        `minZoom (${paths.minZoom}) must not exceed maxZoom (${paths.maxZoom})`,
      );
    }
    const args = ["convert", paths.inputPath, paths.outputPath];
    if (paths.minZoom !== undefined) {
      args.push("--minzoom", String(validateZoom(paths.minZoom, "minZoom")));
    }
    if (paths.maxZoom !== undefined) {
      args.push("--maxzoom", String(validateZoom(paths.maxZoom, "maxZoom")));
    }
    return args;
  },

  /**
   * CRS reprojection. For Nigeria use UTM zones 31N-33N:
   * EPSG:32631 (west), EPSG:32632 (central, incl. Abuja/Lagos fringe),
   * EPSG:32633 (east).
   */
  reprojectFile(paths: PathPair & { targetCrs: string }): string[] {
    return [
      "convert",
      paths.inputPath,
      paths.outputPath,
      "--t-srs",
      validateEpsg(paths.targetCrs),
    ];
  },

  /** Raster → Cloud Optimized GeoTIFF. */
  rasterToCog(paths: PathPair): string[] {
    return [
      "convert",
      paths.inputPath,
      paths.outputPath,
      "-f",
      "COG",
      "--compress",
      "DEFLATE",
    ];
  },
} as const;

function tail(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/** Run an allowlisted argv against TERRIO_BIN; timeouts kill the child. */
async function runTerrio(args: string[]): Promise<TerrioRunResult> {
  const { bin, timeoutMs } = getTerrioConfig();
  const subcommand = args[0];
  if (!ALLOWED_SUBCOMMANDS.has(subcommand)) {
    throw new TerrioError(
      "subcommand_not_allowed",
      `refusing to run subcommand ${JSON.stringify(subcommand)}`,
    );
  }
  const startedAt = Date.now();
  return new Promise<TerrioRunResult>((resolve, reject) => {
    // execFile spawns the binary directly: no shell, args stay an array.
    execFile(
      bin,
      args,
      {
        timeout: timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startedAt;
        if (error) {
          if (error.killed || error.signal) {
            reject(
              new TerrioError(
                "terrio_timeout",
                `terrio ${subcommand} timed out after ${timeoutMs}ms and was killed (${error.signal ?? "timeout"})`,
              ),
            );
            return;
          }
          const exitCode =
            typeof error.code === "number" ? error.code : "unknown";
          reject(
            new TerrioError(
              "terrio_failed",
              `terrio ${subcommand} exited ${exitCode}; stderr tail: ${tail(
                stderr.trim(),
                STDERR_TAIL_CHARS,
              )}`,
            ),
          );
          return;
        }
        resolve({
          stdout: tail(stdout.trim(), STDOUT_SUMMARY_CHARS),
          durationMs,
        });
      },
    );
  });
}

/** OSM PBF → GeoParquet for the Sedona/GeoLibre lakehouse. */
export async function osmPbfToGeoParquet(
  paths: PathPair,
): Promise<TerrioRunResult> {
  return runTerrio(buildArgLists.osmPbfToGeoParquet(validatePaths(paths)));
}

/** Delivery-zone GeoJSON → PMTiles static tiles. */
export async function vectorToPmTiles(
  paths: PathPair & { minZoom?: number; maxZoom?: number },
): Promise<TerrioRunResult> {
  return runTerrio(
    buildArgLists.vectorToPmTiles({
      ...validatePaths(paths),
      minZoom: paths.minZoom,
      maxZoom: paths.maxZoom,
    }),
  );
}

/** Reproject a vector/raster file to targetCrs (e.g. EPSG:32631-32633). */
export async function reprojectFile(
  paths: PathPair & { targetCrs: string },
): Promise<TerrioRunResult> {
  return runTerrio(
    buildArgLists.reprojectFile({
      ...validatePaths(paths),
      targetCrs: paths.targetCrs,
    }),
  );
}

/** Raster → Cloud Optimized GeoTIFF. */
export async function rasterToCog(
  paths: PathPair,
): Promise<TerrioRunResult> {
  return runTerrio(buildArgLists.rasterToCog(validatePaths(paths)));
}

/** Health check: resolves the terrio version string from `terrio --version`. */
export async function terrioVersion(): Promise<{
  version: string;
  durationMs: number;
}> {
  const { stdout, durationMs } = await runTerrio(buildArgLists.version());
  return { version: stdout.split("\n")[0]?.trim() ?? "", durationMs };
}
