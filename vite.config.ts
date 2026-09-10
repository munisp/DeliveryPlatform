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
        { src: "node_modules/cesium/Build/Cesium/Assets", dest: "cesium" },
        { src: "node_modules/cesium/Build/Cesium/ThirdParty", dest: "cesium" },
        { src: "node_modules/cesium/Build/Cesium/Workers", dest: "cesium" },
        { src: "node_modules/cesium/Build/Cesium/Widgets", dest: "cesium" },
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
          if (id.includes("cesium") || id.includes("@cesium")) return "vendor-cesium";
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
