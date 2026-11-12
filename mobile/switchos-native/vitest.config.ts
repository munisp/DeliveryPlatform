import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["tests/**/*.test.ts", "lib/__tests__/**/*.test.ts"], clearMocks: true } });
