const { defineConfig } = require("@medusajs/framework/utils");

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

module.exports = defineConfig({
  projectConfig: {
    databaseUrl: required("MEDUSA_DATABASE_URL"),
    redisUrl: required("MEDUSA_REDIS_URL"),
    http: {
      storeCors: required("MEDUSA_STORE_CORS"),
      adminCors: required("MEDUSA_ADMIN_CORS"),
      authCors: required("MEDUSA_AUTH_CORS"),
      jwtSecret: required("MEDUSA_JWT_SECRET"),
      cookieSecret: required("MEDUSA_COOKIE_SECRET"),
    },
  },
  modules: [
    { resolve: "@medusajs/medusa/cache-redis", options: { redisUrl: required("MEDUSA_REDIS_URL") } },
    { resolve: "@medusajs/medusa/event-bus-redis", options: { redisUrl: required("MEDUSA_REDIS_URL") } },
    { resolve: "@medusajs/medusa/workflow-engine-redis", options: { redisUrl: required("MEDUSA_REDIS_URL") } },
  ],
});
