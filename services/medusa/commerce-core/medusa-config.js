const { defineConfig } = require("@medusajs/framework/utils");

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const boundedInteger = (name, fallback, minimum, maximum) => {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^[0-9]+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
};

const workerMode = (process.env.MEDUSA_WORKER_MODE || "shared").trim().toLowerCase();
if (!["server", "worker", "shared"].includes(workerMode)) {
  throw new Error("MEDUSA_WORKER_MODE must be server, worker, or shared");
}
const frameworkPoolMax = boundedInteger("MEDUSA_FRAMEWORK_DB_POOL_MAX", 4, 1, 16);
const frameworkPoolMin = boundedInteger("MEDUSA_FRAMEWORK_DB_POOL_MIN", 0, 0, frameworkPoolMax);

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: required("MEDUSA_DATABASE_URL"),
    redisUrl: required("MEDUSA_REDIS_URL"),
    workerMode,
    databaseDriverOptions: {
      connection: {
        pool: {
          min: frameworkPoolMin,
          max: frameworkPoolMax,
          idleTimeoutMillis: 30000,
          reapIntervalMillis: 1000,
          createRetryIntervalMillis: 200,
        },
      },
      idle_in_transaction_session_timeout: 15000,
    },
    http: {
      storeCors: required("MEDUSA_STORE_CORS"),
      adminCors: required("MEDUSA_ADMIN_CORS"),
      authCors: required("MEDUSA_AUTH_CORS"),
      jwtSecret: required("MEDUSA_JWT_SECRET"),
      cookieSecret: required("MEDUSA_COOKIE_SECRET"),
    },
  },
  admin: {
    disable: process.env.MEDUSA_ADMIN_DISABLED === "true",
  },
  modules: [
    { resolve: "./src/modules/deliveryplatform-inventory-outbox" },
    {
      resolve: "@medusajs/medusa/cache-redis",
      options: { redisUrl: required("MEDUSA_REDIS_URL") },
    },
    {
      resolve: "@medusajs/medusa/event-bus-redis",
      options: { redisUrl: required("MEDUSA_REDIS_URL") },
    },
    {
      resolve: "@medusajs/medusa/workflow-engine-redis",
      options: { redisUrl: required("MEDUSA_REDIS_URL") },
    },
  ],
});
