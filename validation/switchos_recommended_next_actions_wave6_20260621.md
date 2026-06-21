# SwitchOS Recommended Next Actions — Wave 6 Hardening Report

**Author:** Manus AI  
**Date:** 2026-06-21

## Executive Summary

This remediation wave continued the platform hardening track after the staged-proof work by extending **durable PostgreSQL-backed idempotency and transactional integrity** into the next highest-value **non-Mojaloop write-heavy service paths**. The selected targets were the retry-sensitive flows most likely to be re-executed by operators, schedulers, or middleware and therefore most likely to create duplicate side effects if left unprotected.

The key outcome is that SwitchOS now applies the shared persisted idempotency contract not only to settlement mutations, but also to **loyalty redemption**, **referral application**, **referral completion**, and **campaign delivery** workflows. In addition, the campaign audience sender now derives a stable per-recipient idempotency key so that scheduler or middleware retries do not resend the same campaign to the same user for the same run.

The platform’s production posture improved materially because these flows previously combined database mutations with customer-impacting side effects such as point balance changes, referral rewards, redemption issuance, and outbound campaign sends. They now have stronger protections against duplicate processing, mismatched retries, and partially repeated execution.

## What Was Hardened in This Wave

| Area | Change | Integrity impact |
| --- | --- | --- |
| Shared persistence contract | Generalized the existing idempotency primitives into reusable platform-level helpers while preserving the finance-specific wrappers already used by settlement operations | This made the durable PostgreSQL-backed idempotency table usable across additional domains without regressing the existing settlement logic. |
| Loyalty redemption | Converted `redeemPoints` into an idempotent transactional flow with row locking, conditional balance updates, single redemption creation, and replay support | Duplicate retries can no longer double-deduct points or create multiple reward redemptions under the same idempotency key. |
| Referral code application | Converted `applyReferralCode` into an idempotent transactional flow with normalized code handling, replay-safe existing-row behavior, and transactional welcome-bonus awarding | Repeated referral application for the same request no longer risks duplicate referral rows or duplicated welcome bonus points. |
| Referral completion | Converted `completeReferral` into an idempotent transactional flow that only awards the referrer once and safely returns the already-completed referral on replay | Duplicate completion attempts no longer risk double-awarding referral bonuses. |
| Campaign delivery | Added durable idempotency to `sendCampaign` and stable per-user delivery keys in `sendCampaignToAudience` | Scheduler or middleware retries for the same audience delivery no longer resend the same campaign to the same user for the same run. |

## Implementation Details

The implementation focused on **durable persisted protection**, not ephemeral in-memory deduplication. The central mechanism remains the existing `platform_idempotency_keys` table, which stores a request hash, in-progress state, completion state, and response payload. This wave generalized the helper layer so non-finance service mutations can claim and finalize idempotent operations against that same table.

For the **loyalty redemption** path, the hardening added a transaction boundary and row-level account lock before balance deduction. The code now validates the reward and account state under transaction control, conditionally updates the balance only when enough points remain, inserts a single redemption transaction log, and creates the redemption record once. If the same idempotency key is replayed, the original redemption payload is returned instead of reissuing a voucher or deducting points again.

For the **referral application** path, the implementation now normalizes the referral code, rejects self-referral, locks the referred-user referral row space, and treats a matching existing referral as a safe replay result rather than an error. The welcome-bonus award was moved into the same transactional client path so a duplicate application cannot mint the referred-user bonus twice under the same request.

For the **referral completion** path, the code now locks the referral row, only awards the referrer when the referral is not already rewarded, and treats later replays as successful retrieval of the already-completed referral state. That eliminates the prior duplicate-award risk under retried completion calls.

For the **campaign delivery** path, the implementation now supports durable idempotency directly in `sendCampaign` and makes `sendCampaignToAudience` derive a stable recipient-specific key of the form `campaign.audience.{campaignId}:user:{userId}:channel:email` when no external key is supplied. That means the audience sender is now retry-safe at the per-user level even when schedulers or middleware rerun the same audience dispatch operation.

## Validation Evidence

After the code changes, the targeted validation and production build were re-run successfully.

| Validation command | Result | Notes |
| --- | --- | --- |
| `npm test -- --run tests/non_mojaloop_idempotency.test.ts tests/funds-integrity.test.ts tests/integration-probes.test.ts` | Passed | `6` tests passed and `3` infrastructure-aware DB tests were skipped because the sandbox’s local PostgreSQL stage database does not contain the full application schema required for end-to-end growth-domain DB execution. |
| `npm run build` | Passed | The production client build and bundled Node server build both completed successfully after the new hardening changes. |

## Honest Limitations and Residual Blockers

This wave strengthened the code significantly, but it did not eliminate every remaining hardening gap.

| Remaining item | Current state | Why it still matters |
| --- | --- | --- |
| Broader non-Mojaloop mutation coverage | Still partial | The highest-value retry-sensitive paths are now covered, but other write-heavy growth, incentive, and operational mutations may still benefit from the same durable idempotency contract. |
| Live end-to-end proof for these new growth-domain paths | Not exercised | The local sandbox PostgreSQL instance used for staged proof remains only partially bootstrapped for the broader application schema, so the new DB-backed replay tests were made infrastructure-aware and skipped when the required schema is absent. |
| Full middleware-backed staged environment | Still blocked | No reachable APISIX, Keycloak, Permify, broker, or Docker-capable persistent host is currently available to run the broader environment-backed proof. |
| Natural uniqueness constraints for some growth-domain side effects | Still an optional future hardening layer | This wave focused on durable idempotency and transactional correctness. Additional persisted unique indexes or delivery uniqueness constraints could provide a second layer of protection on top of the idempotency contract. |

## Readiness Impact

This wave meaningfully improved operational safety because it hardened customer-impacting and operator-retry-sensitive workflows that previously could have created duplicate effects under repeat execution. In practical terms, the platform is now better protected against duplicate reward issuance, duplicate referral benefits, duplicate redemption creation, and duplicate audience campaign delivery for the selected flows.

The production posture should therefore be assessed as **improved again**, with the remaining major gaps now concentrated in two areas. First, the hardening pattern should be extended further across other write-heavy non-Mojaloop service paths. Second, once infrastructure becomes available, the platform still needs broader environment-backed proof for the integrated stage stack and the newly hardened growth-domain flows.

## Recommended Next Actions

The next highest-value code action is to continue this same hardening pattern across the remaining retry-sensitive non-Mojaloop mutation paths, prioritizing functions that combine database writes with external effects, counters, or financial-style balances. Candidate domains include broader loyalty administration, incentives, campaign state transitions, and other scheduler-triggerable write paths.

In parallel, once a fuller application schema or a complete staged environment is available, the infrastructure-aware skipped DB tests introduced in this wave should be upgraded into true end-to-end replay tests so the newly hardened growth-domain flows are proven under real database state rather than only static build validation.
