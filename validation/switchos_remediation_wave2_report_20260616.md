# SwitchOS Remediation Wave 2 Report

**Author:** Manus AI  
**Date:** 2026-06-16

## Summary

This second remediation wave addressed several of the largest remaining code-level production gaps that were still open after the first hardening pass. The platform now includes a managed operator login path backed by persistent credentials and signed sessions, durable PostgreSQL-backed persistence for Mojaloop quote and transfer records, a PostgreSQL-backed ledger shim for the TigerBeetle stand-in, and live operator data wiring for merchant channels, service recovery, and phone-ordering workspaces.

## Implemented Changes

| Area | Implemented remediation |
|---|---|
| Operator authentication | Added `server/_core/operatorAuthStore.ts` with a persistent `operator_credentials` store, seeded bootstrap operator provisioning, and password verification based on Node’s built-in `scrypt` derivation. |
| Edge login lifecycle | Reworked `server/_core/index.ts` so `/api/auth/login` issues signed sessions from managed credentials, while the non-production fallback session path remains isolated for local validation only. |
| Frontend portal | Replaced the portal’s bootstrap-only behavior with a real credential form in `client/src/App.tsx`, preserving the non-production fallback while moving the primary operator path to credential-backed login. |
| Mojaloop durability | Rewrote `services/go/mojaloop/main.go` so transfer and quote records persist in PostgreSQL tables instead of only in process memory. |
| Ledger durability | Rewrote `services/go/mojaloop/tigerbeetle_client.go` so the ledger shim stores accounts and transfer entries in PostgreSQL with transactional debit-credit updates. |
| Go module readiness | Added the required PostgreSQL dependency to `services/go/mojaloop/go.mod` and refreshed module metadata through `go mod tidy`. |
| Live operator data flow | Reworked `server/lib/platformWorkspaces.ts` so merchant channels, service recovery, and phone-ordering now attempt live PostgreSQL-derived workspace summaries before falling back to the previous static content. |

## Verification Results

| Verification step | Result |
|---|---|
| `pnpm build` | Passed |
| Node server bundle (`esbuild`) | Passed |
| Mojaloop `go mod tidy` | Passed |
| Mojaloop `go build ./...` | Passed |
| Go notification dispatcher build | Passed |
| Go vertical provisioning build | Passed |
| Rust pricing engine `cargo check` | Passed with one dead-code warning |
| Rust dispatch optimizer `cargo check` | Passed with one dead-code warning |
| Python syntax checks | Passed |

## Remaining Limits

The codebase is more credible than the original audited state, but it is still not fully production-ready. Several gaps remain outside the scope of direct local code-only repair. The platform still lacks a true external identity provider integration such as Keycloak-backed production SSO, real policy enforcement through Permify or equivalent authorization policy evaluation, actual gateway deployment and route governance through Apisix or Open AppSec, fully real middleware connectivity across Kafka, Dapr, Temporal, and Fluvio, and complete end-to-end live backend implementations for every domain surfaced in the operator shell. The current work materially reduces risk and removes some of the most serious code-level weaknesses, but it does not yet transform every claimed platform capability into a fully deployed production system.
