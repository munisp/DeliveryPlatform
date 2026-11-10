import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  buildArgLists,
  osmPbfToGeoParquet,
  rasterToCog,
  reprojectFile,
  resolveTimeoutMs,
  terrioVersion,
  validateEpsg,
  validatePaths,
  vectorToPmTiles,
} from "../server/geo/terrioEtl";

let workDir: string;
let okBin: string;
let failBin: string;
let sleepBin: string;
let argsCapture: string;
let pwnedPath: string;

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "terrio-etl-test-"));
  argsCapture = join(workDir, "argv.txt");
  pwnedPath = join(workDir, "pwned");

  // Success double: echoes argv (one per line) to TERRIO_ARGS_CAPTURE, exits 0.
  okBin = join(workDir, "terrio-ok.sh");
  writeFileSync(
    okBin,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$TERRIO_ARGS_CAPTURE"\necho "terrio 0.6.0 fake"\nexit 0\n',
  );

  // Failure double: writes a marker to stderr, exits 3.
  failBin = join(workDir, "terrio-fail.sh");
  writeFileSync(
    failBin,
    '#!/bin/sh\necho "terrio convert: unsupported driver for output" >&2\nexit 3\n',
  );

  // Slow double: hangs well past the minimum clamped timeout.
  sleepBin = join(workDir, "terrio-sleep.sh");
  writeFileSync(sleepBin, "#!/bin/sh\nsleep 30\n");

  for (const bin of [okBin, failBin, sleepBin]) {
    chmodSync(bin, 0o755);
  }

  for (const key of [
    "TERRIO_BIN",
    "TERRIO_TIMEOUT_MS",
    "TERRIO_ARGS_CAPTURE",
  ]) {
    savedEnv[key] = process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

const validPair = () => ({
  inputPath: join(workDir, "zones.geojson"),
  outputPath: join(workDir, "zones.pmtiles"),
});

describe("fail-closed configuration", () => {
  it("throws terrio_not_configured for every entry point when TERRIO_BIN is unset", async () => {
    delete process.env.TERRIO_BIN;
    await expect(osmPbfToGeoParquet(validPair())).rejects.toThrow(
      /terrio_not_configured/,
    );
    await expect(vectorToPmTiles(validPair())).rejects.toThrow(
      /terrio_not_configured/,
    );
    await expect(
      reprojectFile({ ...validPair(), targetCrs: "EPSG:32632" }),
    ).rejects.toThrow(/terrio_not_configured/);
    await expect(rasterToCog(validPair())).rejects.toThrow(
      /terrio_not_configured/,
    );
    await expect(terrioVersion()).rejects.toThrow(/terrio_not_configured/);
  });

  it("still validates CRS before consulting the binary config", async () => {
    delete process.env.TERRIO_BIN;
    await expect(
      reprojectFile({ ...validPair(), targetCrs: "bogus" }),
    ).rejects.toThrow(/invalid_crs/);
  });
});

describe("validateEpsg", () => {
  it("accepts well-formed EPSG codes, including Nigeria's UTM zones", () => {
    for (const crs of [
      "EPSG:4326",
      "EPSG:3857",
      "EPSG:32631",
      "EPSG:32632",
      "EPSG:32633",
    ]) {
      expect(validateEpsg(crs)).toBe(crs);
    }
  });

  it("rejects malformed and injection-shaped CRS strings", () => {
    for (const crs of [
      "EPSG:123",
      "EPSG:1234567",
      "epsg:4326",
      "EPSG:4326; rm -rf /",
      "EPSG:32631$(id)",
      "EPSG:32631 --overwrite",
      "+proj=utm +zone=32",
      "",
    ]) {
      expect(() => validateEpsg(crs)).toThrow(/invalid_crs/);
    }
  });
});

describe("validatePaths", () => {
  it("accepts absolute paths with an existing output parent", () => {
    const resolved = validatePaths(validPair());
    expect(resolved.inputPath).toBe(join(workDir, "zones.geojson"));
    expect(resolved.outputPath).toBe(join(workDir, "zones.pmtiles"));
  });

  it("rejects relative paths", () => {
    expect(() =>
      validatePaths({ inputPath: "data/zones.geojson", outputPath: validPair().outputPath }),
    ).toThrow(/invalid_path/);
    expect(() =>
      validatePaths({ inputPath: validPair().inputPath, outputPath: "out.pmtiles" }),
    ).toThrow(/invalid_path/);
  });

  it("rejects null bytes and traversal segments", () => {
    expect(() =>
      validatePaths({ inputPath: `${workDir}/a\0.geojson`, outputPath: validPair().outputPath }),
    ).toThrow(/invalid_path/);
    expect(() =>
      validatePaths({ inputPath: `${workDir}/../etc/passwd`, outputPath: validPair().outputPath }),
    ).toThrow(/invalid_path/);
  });

  it("rejects an output whose parent directory does not exist", () => {
    expect(() =>
      validatePaths({
        inputPath: validPair().inputPath,
        outputPath: join(workDir, "no-such-dir", "zones.pmtiles"),
      }),
    ).toThrow(/output_parent_missing/);
  });
});

describe("buildArgLists", () => {
  it("builds the OSM PBF -> GeoParquet argv", () => {
    expect(
      buildArgLists.osmPbfToGeoParquet({
        inputPath: "/data/ng.osm.pbf",
        outputPath: "/data/ng.parquet",
      }),
    ).toEqual(["convert", "/data/ng.osm.pbf", "/data/ng.parquet", "-f", "Parquet"]);
  });

  it("builds the delivery-zone PMTiles argv with zoom bounds", () => {
    expect(
      buildArgLists.vectorToPmTiles({
        inputPath: "/data/zones.geojson",
        outputPath: "/data/zones.pmtiles",
        minZoom: 4,
        maxZoom: 14,
      }),
    ).toEqual([
      "convert",
      "/data/zones.geojson",
      "/data/zones.pmtiles",
      "--minzoom",
      "4",
      "--maxzoom",
      "14",
    ]);
  });

  it("rejects inverted or out-of-range zoom levels", () => {
    const pair = { inputPath: "/data/a", outputPath: "/data/b" };
    expect(() =>
      buildArgLists.vectorToPmTiles({ ...pair, minZoom: 10, maxZoom: 4 }),
    ).toThrow(/invalid_zoom/);
    expect(() => buildArgLists.vectorToPmTiles({ ...pair, maxZoom: 99 })).toThrow(
      /invalid_zoom/,
    );
    expect(() =>
      buildArgLists.vectorToPmTiles({ ...pair, minZoom: 2.5 }),
    ).toThrow(/invalid_zoom/);
  });

  it("builds the reprojection and COG argv, validating the CRS", () => {
    expect(
      buildArgLists.reprojectFile({
        inputPath: "/data/zones.geojson",
        outputPath: "/data/zones-utm.geojson",
        targetCrs: "EPSG:32632",
      }),
    ).toEqual([
      "convert",
      "/data/zones.geojson",
      "/data/zones-utm.geojson",
      "--t-srs",
      "EPSG:32632",
    ]);
    expect(
      buildArgLists.rasterToCog({
        inputPath: "/data/dem.tif",
        outputPath: "/data/dem-cog.tif",
      }),
    ).toEqual([
      "convert",
      "/data/dem.tif",
      "/data/dem-cog.tif",
      "-f",
      "COG",
      "--compress",
      "DEFLATE",
    ]);
    expect(() =>
      buildArgLists.reprojectFile({
        inputPath: "/data/a",
        outputPath: "/data/b",
        targetCrs: "EPSG:4326; rm -rf /",
      }),
    ).toThrow(/invalid_crs/);
  });

  it("only ever builds allowlisted subcommands", () => {
    const pair = { inputPath: "/data/a", outputPath: "/data/b" };
    const all = [
      buildArgLists.version(),
      buildArgLists.osmPbfToGeoParquet(pair),
      buildArgLists.vectorToPmTiles({ ...pair, maxZoom: 12 }),
      buildArgLists.reprojectFile({ ...pair, targetCrs: "EPSG:32633" }),
      buildArgLists.rasterToCog(pair),
    ];
    for (const argv of all) {
      expect(["convert", "--version"]).toContain(argv[0]);
      expect(Array.isArray(argv)).toBe(true);
    }
  });
});

describe("resolveTimeoutMs", () => {
  it("defaults to 120000 and clamps into [1000, 600000]", () => {
    expect(resolveTimeoutMs(undefined)).toBe(120_000);
    expect(resolveTimeoutMs("")).toBe(120_000);
    expect(resolveTimeoutMs("not-a-number")).toBe(120_000);
    expect(resolveTimeoutMs("500")).toBe(1_000);
    expect(resolveTimeoutMs("45000")).toBe(45_000);
    expect(resolveTimeoutMs("99999999")).toBe(600_000);
  });
});

describe("execFile smoke tests (fake terrio binaries)", () => {
  it("passes args as an array with no shell: metacharacters stay inert", async () => {
    process.env.TERRIO_BIN = okBin;
    process.env.TERRIO_ARGS_CAPTURE = argsCapture;
    // Absolute path laced with shell metacharacters; harmless without a shell.
    const hostileInput = `${workDir}/in; touch ${pwnedPath} #.geojson`;
    const result = await vectorToPmTiles({
      inputPath: hostileInput,
      outputPath: join(workDir, "zones.pmtiles"),
      minZoom: 0,
      maxZoom: 14,
    });
    expect(result.stdout).toContain("terrio 0.6.0 fake");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // The hostile path arrived as ONE argv element, exactly as passed.
    expect(readFileSync(argsCapture, "utf8").split("\n")).toEqual([
      "convert",
      hostileInput,
      join(workDir, "zones.pmtiles"),
      "--minzoom",
      "0",
      "--maxzoom",
      "14",
      "",
    ]);
    // No shell ever interpreted the metacharacters.
    expect(existsSync(pwnedPath)).toBe(false);
  });

  it("surfaces the stderr tail when terrio exits non-zero", async () => {
    process.env.TERRIO_BIN = failBin;
    await expect(rasterToCog(validPair())).rejects.toThrow(
      /terrio_failed.*unsupported driver for output/s,
    );
  });

  it("kills the child when the (clamped) timeout elapses", async () => {
    process.env.TERRIO_BIN = sleepBin;
    process.env.TERRIO_TIMEOUT_MS = "250"; // clamped up to the 1000ms minimum
    const started = Date.now();
    await expect(osmPbfToGeoParquet(validPair())).rejects.toThrow(
      /terrio_timeout/,
    );
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it("terrioVersion parses the first stdout line for health checks", async () => {
    process.env.TERRIO_BIN = okBin;
    process.env.TERRIO_ARGS_CAPTURE = argsCapture;
    const { version, durationMs } = await terrioVersion();
    expect(version).toBe("terrio 0.6.0 fake");
    expect(durationMs).toBeGreaterThanOrEqual(0);
  });
});
