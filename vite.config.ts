/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { viteStaticCopy } from "vite-plugin-static-copy";

const buildVersion =
  process.env.VITE_APP_BUILD_VERSION ??
  process.env.GITHUB_SHA ??
  new Date().toISOString();

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    viteStaticCopy({
      targets: [
        // The optional Cesium fleet globe is terrain-free and disables sky,
        // atmosphere, moon, sun, water, widgets, Ion, 3D Tiles, and decoders.
        // Preserve only the flat worker files its WebGL engine resolves from
        // CESIUM_BASE_URL; no multi-megabyte texture catalog is deployed.
        {
          src: "node_modules/@cesium/engine/Source/Workers/*",
          dest: "cesium/Workers",
        },
      ],
    }),
  ],
  define: {
    __APP_BUILD_VERSION__: JSON.stringify(buildVersion),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client/src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  server: {
    port: 3005,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("maplibre-gl") || id.includes("@mapbox") || id.includes("geojson"))
            return "vendor-map";
          if (id.includes("recharts") || id.includes("d3-"))
            return "vendor-visualization";
          if (id.includes("@radix-ui")) return "vendor-ui";
          if (
            id.includes("@tanstack") ||
            id.includes("@trpc") ||
            id.includes("zod")
          )
            return "vendor-data";
          if (
            id.includes("/node_modules/react/") ||
            id.includes("/node_modules/react-dom/") ||
            id.includes("/node_modules/scheduler/") ||
            id.includes("/node_modules/use-sync-external-store/")
          )
            return "vendor-react";
        },
      },
    },
  },
});
