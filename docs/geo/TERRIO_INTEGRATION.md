# terrio geospatial ETL integration

[terrio](https://github.com/opengeos/terrio) (MIT) is a pure-Rust geospatial
raster, vector and point-cloud engine — effectively a GDAL/PROJ/PDAL
replacement with no C dependencies. Its commands and options follow GDAL's,
many algorithms are ports of GDAL/PROJ/PDAL code, and outputs are tested file
by file against GDAL. It ships as a standalone `terrio` CLI, Rust crates,
Python bindings, and a WebAssembly package (`terrio-js`).

DeliveryPlatform uses terrio **server-side only**, through the subprocess
wrapper in `server/geo/terrioEtl.ts`. That wrapper:

- spawns the binary with `node:child_process` `execFile` — never a shell,
  arguments always as arrays;
- allowlists subcommands (`convert`, `--version` only);
- requires absolute, traversal-free paths and a pre-existing output parent;
- fails closed with `terrio_not_configured` when `TERRIO_BIN` is unset;
- kills the child on timeout (`TERRIO_TIMEOUT_MS`, default 120s, clamped to
  1s..600s) and surfaces the last 2KB of stderr on non-zero exit.

## Install

Static binary (no Rust toolchain needed):

```sh
curl -LsSf https://terrio.dev/install.sh | sh      # Linux, macOS
pip install terrio                                 # also provides the CLI
```

Then point the server at it:

```sh
export TERRIO_BIN=/usr/local/bin/terrio
export TERRIO_TIMEOUT_MS=120000   # optional
```

Health check: `terrioVersion()` runs `terrio --version`.

## Pipelines

All four map to `terrio convert` (format inferred from the output extension /
`-f` flag):

1. **OSM PBF → GeoParquet** — `osmPbfToGeoParquet({inputPath, outputPath})`
   runs `terrio convert in.osm.pbf out.parquet -f Parquet`. This is the ingest
   path for OpenStreetMap extracts into the Sedona/GeoLibre lakehouse.
2. **Delivery zones → PMTiles** —
   `vectorToPmTiles({inputPath, outputPath, minZoom?, maxZoom?})` runs
   `terrio convert zones.geojson zones.pmtiles --minzoom N --maxzoom M`,
   producing static MVT-in-PMTiles archives for delivery-zone maps that can
   be served from object storage without a tile server.
3. **CRS reprojection** — `reprojectFile({inputPath, outputPath, targetCrs})`
   runs `terrio convert in out --t-srs EPSG:xxxx`. `targetCrs` is validated
   against `/^EPSG:\d{4,6}$/`. Nigeria spans UTM zones 31N–33N, so use
   **EPSG:32631** (west), **EPSG:32632** (central), **EPSG:32633** (east) for
   metric operations; EPSG:4326/3857 for interchange/web display.
4. **Raster → COG** — `rasterToCog({inputPath, outputPath})` runs
   `terrio convert in.tif out.tif -f COG --compress DEFLATE` for
   cloud-optimized GeoTIFFs readable over HTTP range requests.

## PWA / client-side guidance (documented, not wired)

terrio builds to WebAssembly as the `terrio-js` npm package (~3.4MB), which
makes offline client-side reprojection in the PWA feasible (e.g. converting
cached geometries between EPSG:4326 and UTM zones without a round trip).
This is **guidance only**: no npm dependency is added and no client code is
wired in this change. If adopted later, lazy-load the WASM bundle so it stays
out of the critical path, and pin the exact version (see below).

## Version pinning policy

terrio is pre-1.0 and explicitly warns that its API may change before 1.0.
Therefore:

- pin the exact terrio version in deployment images/install scripts;
- record the pinned version alongside `terrioVersion()` in health output;
- re-run the geospatial regression checks on every terrio bump before
  promoting it.

## Risk note

terrio is a young project. It is GDAL-conformance-tested (results compared
file by file against GDAL, with projections ported from PROJ and point-cloud
filters following PDAL), but for money-critical or safety-critical paths
(pricing geofences, zone eligibility, distance-based payouts) validate its
outputs independently against the incumbent toolchain before relying on them.
