import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const buildVersion = process.env.VITE_APP_BUILD_VERSION
  ?? process.env.GITHUB_SHA
  ?? new Date().toISOString();

export default defineConfig({
  plugins: [react()],
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
  },
});
