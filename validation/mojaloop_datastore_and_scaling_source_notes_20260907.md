# Mojaloop Datastore and Scaling Source Notes

**Date:** 2026-09-07

The maintained Mojaloop `database-lib` README explicitly states that the shared central-services database library supports both MySQL and PostgreSQL, configuring Knex with `client: 'mysql'` or `client: 'pg'`.

Source: [mojaloop/database-lib README](https://github.com/mojaloop/database-lib)

The maintained Mojaloop Helm repository lists component deployment dependencies. Its current chart table specifically names MySQL for Account Lookup Service, Quoting Service, Central Ledger (alongside Kafka and MongoDB), Central Settlements, and several third-party components. The same README states that MySQL, Kafka, MongoDB and comparable external backends should be deployed as separate, operationally isolated dependencies. It includes provisioning and golden-path Helm test collections, plus an explicit warning that the bundled example backend is for proof-of-concept/testing convenience rather than a production deployment.

Source: [mojaloop/helm README](https://github.com/mojaloop/helm)

**Architecture implication:** PostgreSQL support in the shared library is not proof that every currently maintained Mojaloop component/chart is production-supported on PostgreSQL. DeliveryPlatform should retain its own PostgreSQL authority model. A real Mojaloop installation must follow the selected official component version’s datastore/configuration matrix and run its provider-approved test toolkit in a non-production environment. Do not substitute or tune a database engine merely to claim support; use each component’s documented database and separately tune supported MySQL deployments (for example, InnoDB, transaction isolation, redo/undo/log storage, replicas, connection pools, backup/recovery) only after workload-specific testing.
