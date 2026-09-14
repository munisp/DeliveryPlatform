/**
 * Prometheus /metrics endpoint for the central app: request counts, latency
 * histogram, error counts, uptime and version gauges. Reuses the vendored
 * text-exposition Registry from vehicleTrackerMetrics (no new dependencies).
 */
import type { NextFunction, Request, Response } from "express";
import { Registry } from "./vehicleTrackerMetrics";

const registry = new Registry();
const startedAtMs = Date.now();
const SERVICE = "central-app";
const VERSION = process.env.SERVICE_VERSION ?? process.env.npm_package_version ?? "unknown";

function routeLabel(req: Request): string {
  // Prefer the matched route pattern to bound label cardinality.
  const routePath = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof routePath === "string") return routePath;
  return req.path || "unknown";
}

export function httpMetricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = { service: SERVICE, method: req.method, path: routeLabel(req) };
    registry.counter("http_requests_total", "Total HTTP requests handled.", {
      ...labels,
      status: String(res.statusCode),
    });
    registry.histogram("http_request_duration_seconds", "HTTP request latency in seconds.", labels, seconds);
    if (res.statusCode >= 500) {
      registry.counter("http_errors_total", "Total HTTP 5xx responses.", {
        ...labels,
        status: String(res.statusCode),
      });
    }
  });
  next();
}

export function httpMetricsHandler(_req: Request, res: Response): void {
  registry.gauge("service_info", "Static service metadata gauge (always 1).", { service: SERVICE, version: VERSION }, 1);
  registry.gauge(
    "service_uptime_seconds",
    "Seconds since the service process started.",
    { service: SERVICE },
    (Date.now() - startedAtMs) / 1000,
  );
  res
    .status(200)
    .set("content-type", "text/plain; version=0.0.4; charset=utf-8")
    .set("cache-control", "no-store")
    .send(registry.render());
}
