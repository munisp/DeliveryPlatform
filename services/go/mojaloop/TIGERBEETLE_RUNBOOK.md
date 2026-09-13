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

## ILP interop boundary

The service now implements **real Interledger crypto and encoding** (see `ilp.go`): the fulfilment is 32 cryptographically random bytes, the condition is `SHA-256(fulfilment)` base64url-encoded, and the ILP packet is an OER-encoded ILPv4 `IlpPrepare` (type byte `0x0C`, 8-byte big-endian UInt64 amount, ILP destination address, 32-byte condition, 17-byte `YYYYMMDDHHMMSS.fffZ` expiry) per ILP RFC 0027 / the Mojaloop FSPIOP API. Committed/settled transfer callbacks are rejected unless the presented fulfilment satisfies the stored condition.

What remains out of scope — the boundary that must still be closed before Mojaloop switch connectivity can be claimed:

1. **Switch connectivity**: no live Mojaloop switch (ALS/quoting/transfers services) is attached; `MOJALOOP_SWITCH_URL` is a stub endpoint and no FSPIOP handshake, party lookup, or quote/transfer dance is performed.
2. **Fulfilment origination**: because there is no real payee DFSP, this service originates the fulfilment preimage itself at transfer initiation and persists it in `mojaloop_transfers.fulfilment_value`. In a real FSPIOP topology the payee DFSP generates the fulfilment and only discloses the condition in the quote response; the payer side must never store the preimage.
3. **JWS/mTLS**: FSPIOP message signing and bilateral TLS are not implemented here.

Until those are delivered, the ILP fields are cryptographically real and round-trip verifiable, but transfer execution is a closed loop inside this platform, not settlement across an external switch.
