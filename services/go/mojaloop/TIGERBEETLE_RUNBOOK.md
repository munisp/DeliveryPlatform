# TigerBeetle Funds-Ledger Configuration Runbook

The Mojaloop service is intentionally **fail-closed**. It does not substitute PostgreSQL for TigerBeetle and it does not manufacture account balances. A funds-capable deployment must provide all variables below through the deployment secret/configuration manager before the service starts.

| Variable | Required value | Control objective |
|---|---|---|
| `TIGERBEETLE_ADDRESSES` | Comma-separated replica addresses, for example `tb-0.internal:3000,tb-1.internal:3000,tb-2.internal:3000` | Connect only to the configured replicated ledger cluster. |
| `TIGERBEETLE_CLUSTER_ID` | Nonzero 128-bit hexadecimal cluster ID | Prevent cross-cluster client attachment. |
| `TIGERBEETLE_LEDGER` | Nonzero unsigned 32-bit ledger number | Segregate the platform ledger namespace. |
| `TIGERBEETLE_ACCOUNT_MAP_JSON` | JSON object mapping each permitted FSP alias to a pre-provisioned nonzero 128-bit account ID | Prevent implicit account creation and ensure stable debit/credit account targeting. |
| `INTERNAL_SERVICE_TOKEN` | Unique non-placeholder secret managed outside source control | Protect the transition-period internal endpoint contract. |

The `TIGERBEETLE_ACCOUNT_MAP_JSON` value is deployment metadata, not an instruction to create or fund accounts. Treasury-controlled account provisioning must create the mapped accounts with the appropriate debit/credit constraints and separately record the approval, funding source, and reconciliation owner. The client never credits a new payer account automatically.

Before enabling funds traffic, operators must demonstrate the following against an isolated real cluster: account lookup/provisioning, a funded transfer, duplicate transfer replay, insufficient-funds rejection, full and partial refund, reconciliation, client restart, and ledger-network interruption recovery. Each scenario must retain both the TigerBeetle result and the correlated Mojaloop record.

The provided `deploy/platform/docker-compose.stack.yml` is not a production funds-stack manifest: it does not create a TigerBeetle cluster or a Mojaloop service. It therefore cannot be used as evidence for funds-flow release readiness without a separate reviewed deployment manifest and the above verification.
