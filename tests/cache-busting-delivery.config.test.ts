import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("cache-busting delivery contracts", () => {
  it("requires a build-versioned service worker and stable production registration", () => {
    const worker = source("public/sw.js");
    const client = source("client/src/main.tsx");
    const packageJson = source("package.json");

    expect(worker).toContain('const BUILD_VERSION = "__SW_BUILD_VERSION__"');
    expect(worker).toContain("clearStaleShellCaches");
    expect(worker).toContain('pathname.startsWith("/api/")');
    expect(client).toContain('navigator.serviceWorker.register("/sw.js"');
    expect(client).toContain('meta[name="switchos-build-version"]');
    expect(client).toContain("import.meta.env.PROD");
    expect(packageJson).toContain("inject-service-worker-version.mjs dist/sw.js dist/index.html");
  });

  it("keeps HTML and service-worker responses non-cacheable at every web delivery layer", () => {
    const entryHtml = source("index.html");
    const server = source("server/_core/index.ts");
    const apisix = source("deploy/gateway/apisix/apisix.yaml");
    const caddy = source("deploy/gateway/caddy/Caddyfile");

    expect(entryHtml).toContain('http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate"');
    expect(server).toContain('req.path === "/sw.js"');
    expect(server).toContain('Service-Worker-Allowed", "/"');
    expect(apisix).toContain("id: switchos-service-worker");
    expect(apisix).toContain("id: switchos-html-entry");
    expect(caddy).toContain("@pwa_service_worker path /sw.js");
    expect(caddy).toContain("@pwa_html_entry path / /index.html");
  });

  it("allows long-lived caching only for content-addressed browser assets", () => {
    const server = source("server/_core/index.ts");
    const apisix = source("deploy/gateway/apisix/apisix.yaml");
    const caddy = source("deploy/gateway/caddy/Caddyfile");

    expect(server).toContain("public, max-age=31536000, immutable");
    expect(apisix).toContain("id: switchos-static-assets");
    expect(caddy).toContain("@pwa_hashed_assets path_regexp");
  });

  it("pins the central build and native runtime to cache-compatible versions", () => {
    const dockerfile = source("Dockerfile");
    const workflow = source(".github/workflows/kubernetes-cicd.yml");
    const nativeConfig = source("mobile/switchos-native/app.config.ts");

    expect(dockerfile).toContain("ARG PWA_BUILD_VERSION");
    expect(dockerfile).toContain("ENV SW_BUILD_VERSION=${PWA_BUILD_VERSION}");
    expect(workflow).toContain("PWA_BUILD_VERSION=${{ github.sha }}");
    expect(nativeConfig).toContain('policy: "fingerprint"');
  });
});
