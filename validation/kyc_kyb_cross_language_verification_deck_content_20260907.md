## Cover

**Next-Generation Stakeholder Verification**

Consented KYC/KYB architecture, provider callbacks, document intelligence, and accountable human review.

## Slide 1

**Verification is an evidence workflow—not an automated identity verdict**

- Covers drivers, technicians, merchants, fleet providers, vehicles, and operators.
- Requires purpose-bound consent before evidence collection or processing.
- OCR, document intelligence, liveness artifacts, and provider outputs create review evidence only.
- PostgreSQL is the sole authority for lifecycle state and final decision prerequisites.

## Slide 2

**A single accountable case connects each stakeholder check**

- `verification_case` binds subject, jurisdiction, purpose, lifecycle, decision, and expiry.
- `consent_receipt`, `evidence`, `processing_job`, and `provider_check` are idempotent, bounded records.
- Append-only evidence and decision events produce a defensible chronology.
- Withdrawing consent moves a verified case to `suspended`.

## Slide 3

**The cross-language system separates speed from authority**

- TypeScript provides authenticated operations APIs and the `/verification` workspace.
- Go claims processor jobs and verifies signed provider callbacks.
- Python handles byte-integrity, optional PaddleOCR/Docling/VLM extraction, and liveness artifacts.
- Rust assesses required-check completeness; every automated result requires human review.

## Slide 4

**Provider callbacks are authenticated before persistence**

- Provider key maps to a configured 32–4096 byte secret.
- Go computes HMAC-SHA-256 over the exact raw body and compares with `hmac.Equal`.
- Invalid signature yields 401; malformed body yields 400; temporary persistence failure yields 503 for safe retry.
- PostgreSQL repeats operator, case, enum, digest, expiry, and idempotency checks.

## Slide 5

**PaddleOCR pipeline protects integrity before extraction**

- Internal token, Base64 decode, nonempty body, and 10 MiB maximum are enforced first.
- Python recomputes SHA-256 and rejects altered bytes with 422.
- PaddleOCR and Docling operate on short-lived temporary files; output is digest-bound.
- Missing/degraded processor path becomes manual review, never automatic approval.

## Slide 6

**Liveness is a bounded artifact gate today**

- Nonce digest, frame digest format, distinct frames, capture window, and attestation reference are checked.
- The service returns `manual_review` whether artifact indicators are complete or incomplete.
- No face match, demographic inference, or automated pass/fail eligibility decision is implemented.
- A compliant PAD/liveness provider remains a separate, consented integration prerequisite.

## Slide 7

**Processor jobs are lease-fenced and retry safely**

- PostgreSQL claims due jobs with `FOR UPDATE SKIP LOCKED`.
- Claim emits a fresh UUID token and 60-second lease.
- Completion must match the live claim token or raises SQLSTATE 55000.
- Failed processor work retries exponentially through attempt 7; attempt 8 moves to manual review.

## Slide 8

**Final verification requires all controls, not a model score**

- Operator-only decision function locks the case and is idempotent.
- Verify requires current consent and a future decision expiry.
- Required check types must be `passed` and unexpired for the case subject type.
- Reject, suspend, and expire remain explicit human decision paths with append-only evidence.

## Slide 9

**Local evidence validates the full control chain**

- Python verified synthetic document bytes and returned manual review.
- Rust returned manual-review-required for completeness assessment.
- Go sent one token-fenced processing completion and five HMAC-signed simulated provider callbacks.
- Final `verified` decision became possible only after the checks; consent withdrawal test suspended a verified case.

## Slide 10

**Production integration is provider-specific and approval-gated**

- Select jurisdiction-supported KYC/KYB, licence, sanctions, records, registry, insurance, credential, and ownership providers.
- Establish consent language, lawful basis, retention/deletion, human appeal, and data-processing agreements.
- Use encrypted malware-scanned object storage, callback secret custody, egress allowlists, and separate runtime/DDL identities.
- Validate with provider sandbox tenants before production enablement; local synthetic tests are not certification.

## Slide 11

**Decision: keep humans accountable, keep systems verifiable**

- Preserve the manual-review default as providers and models are introduced.
- Promote only after provider contracts, privacy/compliance approval, security review, target-environment tests, and measurable accuracy/appeal controls.
- Never use OCR/VLM/liveness score alone as an eligibility or adverse-action decision.
