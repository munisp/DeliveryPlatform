# Consented Stakeholder Verification Engine: Implementation and Validation Review

**Date:** 2026-09-07
**Scope:** Isolated `feature/commerce-field-developer` worktree only
**Status:** Source implementation and local synthetic-contract validation complete; not deployed to a target environment.

## Existing onboarding and document-integrity controls

The existing account lifecycle uses the HTTP authentication/onboarding handlers registered in `server/_core/index.ts` and the account lifecycle store. Those flows govern account creation, email verification, invitations, organization setup, password resets, session issuance, and operator session controls. The new evidence workflow does not bypass those controls: it receives the authenticated `ctx.user.id` through tRPC, and PostgreSQL verifies that actor against either the case subject or a database-verified operator.

Existing vehicle-access onboarding persists only metadata and a SHA-256 hex digest for inspection, ownership authority, roadworthiness, registration, and commercial-cover evidence. The function requires a 64-character lower-case hexadecimal digest and has no direct mutable table grant for the normal runtime role.

> A SHA-256 digest demonstrates integrity of the bytes presented to the system. It does not itself prove document authenticity, licence validity, insurance status, or the identity of a physical person.

## New stakeholder-verification APIs

The TypeScript API router introduces `stakeholderVerification` under the existing authenticated context. Subject-scoped paths use `authenticatedProcedure` and always inject the session identity as `actorUserId`; the client cannot submit an arbitrary actor identifier. Provider-check recording and final human decisions use `protectedProcedure`, and PostgreSQL independently verifies the operator role.

| tRPC procedure | Authorization boundary | Authoritative database function |
|---|---|---|
| `startCase` | Authenticated actor creates a subject-bound case. | `verification.start_case` |
| `recordConsent` | Case subject or operator. | `verification.record_consent` |
| `withdrawConsent` | Case subject or operator. | `verification.withdraw_consent` |
| `recordEvidence` | Case subject or operator; payload supplies object key, content type, digest, and bounded metadata. | `verification.record_evidence` |
| `enqueueProcessing` | Case subject or operator. | `verification.enqueue_processing` |
| `recordProviderCheck` | Protected procedure; database independently requires operator. | `verification.record_provider_check` |
| `decideCase` | Protected procedure; database independently requires operator and all required checks. | `verification.decide_case` |
| `listCases` | Authenticated actor sees only their subject case(s), except operators. | `verification.list_cases` |

## Document hash verification

The `verification.evidence` table requires `sha256_hex ~ '^[a-f0-9]{64}$'`, a bounded nonempty object key, content type, and JSON capture metadata. `record_evidence` locks the verification case, checks case access, requires an unexpired/non-withdrawn consent receipt, rejects duplicate idempotency keys, and writes an append-only event/outbox record. The evidence table has an append-only trigger; normal runtime roles receive only narrowly scoped function execution grants.

The Python verification-intelligence service accepts an object body only in the explicitly configured synthetic mode. It recomputes SHA-256 from the bytes and rejects a mismatch before selecting PaddleOCR, Docling, or optional VLM processing. Its output is always `manual_review`; the model layer cannot set a verified/rejected/suspended case state.

## Cross-language execution boundary

| Component | Role | Authority limitation |
|---|---|---|
| **TypeScript** | tRPC routes, typed database wrappers, authenticated operations workspace at `/verification`. | Cannot mutate verification tables directly. |
| **Go** | Durable job claimant/orchestrator, synthetic-object guard, signed provider callback endpoint. | Completes jobs only with the PostgreSQL-issued claim token. It cannot make a final case decision. |
| **Python** | PaddleOCR/Docling optional processors, optional VLM contract, liveness-artifact completeness assessment. | Returns manual-review evidence only; synthetic input is explicitly gated. |
| **Rust** | Deterministic required-check completeness evaluation. | Returns manual-review-required only; it does not approve or reject a stakeholder. |
| **PostgreSQL** | Consent, hashed evidence, idempotency, claim lease/fencing, provider checks, decisions, append-only events/outbox. | Sole authority for state transitions and final human decision prerequisites. |

The Go provider callback accepts at most 1 MiB, requires the provider name and a configured 32–4096 byte secret, calculates HMAC-SHA-256 over the exact received body, compares with `hmac.Equal`, and calls `verification.record_provider_check` under the configured service actor. Invalid authentication receives `401`; database persistence errors receive `503` so a correctly authenticated provider can retry without interpreting a temporary database failure as an authorization problem.

## Local validation evidence

The disposable PostgreSQL/PostGIS validator applied the migration, confirmed consent-before-evidence, digest shape constraints, job claim fencing, stale-token rejection, provider check idempotency, human decision prerequisites, append-only evidence, direct-table denial, and consent withdrawal. It ended in `suspended` after the subject withdrew consent from a previously verified synthetic case.

The cross-language simulation started the actual Python, Rust, and Go services locally. It processed a SHA-256-verified synthetic document, received `manual_review` from Python/Rust, sent five HMAC-signed synthetic provider callbacks, and only then allowed the explicit human operator decision to set the case to `verified`. The simulation output is retained in `validation/cross_language_stakeholder_verification_20260907.txt`.

Focused and complete quality gates passed: 47 test files / 227 tests passed with 30 intentional skips; three Python unit tests; two Rust unit tests; Go race tests; TypeScript check; production build; formatting; Bash syntax; and diff integrity. A temporary production-preview route smoke check confirmed the `/verification` workspace renders; no authenticated backend mutation was attempted from that static preview.

## Target-environment prerequisites and non-claims

This implementation is a **provider-agnostic verification workflow**, not a real screening provider, legal opinion, biometric identity decision, or production certification. Before an approved non-production target test, the operator must select providers for identity/licence, criminal-record, sanctions, vehicle registry, insurance, technical credential, beneficial-ownership, and operator-recency checks; establish lawful basis, explicit consent text, data-processing terms, retention/deletion schedules, jurisdiction support, human-review and appeal procedures, test tenants, callback signing material, egress allowlists, and monitoring.

Production rollout also needs encrypted object storage with malware scanning, managed key custody, access/audit logging, event retention, redaction, backup/restore tests, DPA/privacy review, false-positive/negative governance, incident procedures, and each provider's sandbox certification. Do not place real documents, selfies, liveness captures, criminal data, sanctions data, or any production credential in the local synthetic simulator.
