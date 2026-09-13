import { defineConfig } from "drizzle-kit";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required to run drizzle commands");
}

// Wired to the existing hand-authored migrations in ./drizzle. Those .sql
// files are applied by CI shell scripts; this config lets drizzle-kit
// generate/migrate/push operate against the same folder and the real schema.
export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: connectionString,
  },
});
