# Silent-Mockware Remediation Report

## Outcome

The audited high-risk silent-mockware paths were removed or hardened. The platform no longer substitutes fabricated workspace metrics when Lakehouse analytics, PostgreSQL-backed workspaces, or manual jobs are unavailable. Instead, it now returns a visible `SERVICE_UNAVAILABLE` error or disables the unverified workspace until a real source schema and service integration exists.

| Risk area | Prior behavior | Remediation |
|---|---|---|
| Lakehouse analytics | Failed Lakehouse sync silently returned plausible workspace analytics. | Analytics routes now return `LAKEHOUSE_ANALYTICS_UNAVAILABLE` with tRPC `SERVICE_UNAVAILABLE`; no workspace substitution occurs. |
| Driver, tableside, and white-label workspaces | Static drivers, venues, brands, and derived metrics were represented as live operations. | Driver Mobility now queries PostgreSQL. Tableside and White Label now explicitly report data unavailability until real registries are wired. |
| Merchant, recovery, and phone workspaces | Database errors were caught and replaced with hard-coded operational counts, queues, or call volumes. | Hard-coded fallback payloads were removed; queries now either return real PostgreSQL results or raise a workspace-unavailable error. |
| Manual jobs | A manual trigger returned success without executing the job. | Manual triggers now execute the named job, log the real result and elapsed time, and throw on failure. |
| Campaigns, rewards, catalog, and onboarding | Database loss or failed writes returned zeros, empty lists, or `null` values that appeared valid. | These paths now raise `DatabaseUnavailableError` or explicit write failures. |
| Unverified multimodal summaries | Several summary builders derived business metrics from record IDs, fixed arrays, and minimum counts. | Mobility, rider, driver, business-travel, freight, healthcare, merchant-channel, phone, tableside, and white-label summaries now fail explicitly with `VERIFIED_DATA_UNAVAILABLE:<workspace>`. |
| Operator UI | Empty fallback data was rendered as zero metrics and blank lists. | `PlatformSummaryPage` now has a central explicit data-unavailable state; affected pages pass query errors through instead of rendering an apparently healthy zero-state dashboard. |

## Validation

The following validation completed successfully in `/home/ubuntu/DeliveryPlatform_silent_mockware`.

| Check | Result |
|---|---|
| `pnpm exec vitest run tests/silent-mockware.regression.test.ts tests/platform.scenarios.test.ts` | Passed: 2 files, 16 tests. |
| `pnpm check` | Passed with no TypeScript errors. |
| Diff hygiene | `git diff --check` passed. |
| Post-remediation source scan | Confirmed removal of the audited static workspace fixtures, Lakehouse fallback helper, manual-trigger acknowledgement, and zeroed campaign/reward failure responses. |

## Regression Protections

`tests/silent-mockware.regression.test.ts` now rejects reintroduction of the confirmed patterns. It checks for static stakeholder fixtures, Lakehouse-to-workspace analytics substitution, non-executing manual job acknowledgements, and disabled unverified multimodal summaries.

## Remaining Requirement

The disabled workspace routes are intentionally not production-functional until the platform receives real data contracts and schemas for tableside operations, white-label application registry, and the other domain-specific multimodal surfaces. This is a deliberate safety choice: **unavailable is now explicit rather than being hidden behind plausible-looking mock results**.
