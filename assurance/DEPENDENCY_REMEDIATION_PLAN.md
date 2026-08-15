# High-Severity Dependency Remediation Plan

## Evidence captured

The production audit captured on 2026-08-14 reports **16 High** findings. The audit’s direct update recommendations group them into the following package paths:

| Group | High advisory count | Current audited path | Audit target / status |
|---|---:|---|---|
| `brace-expansion` | 4 | Expo CLI → `glob` → `minimatch` → `brace-expansion` | `>=5.0.9`; path update available for the v5 branch. |
| `js-yaml` | 2 | Expo CLI → Expo xcpretty → `js-yaml` | `>=4.3.1`; path update available. |
| `fast-uri` | 3 | Expo build properties → `ajv` → `fast-uri` | `>=3.1.5`; path update available. |
| `mermaid` | 5 | Root dashboard → `streamdown` → `mermaid` | `>=11.16.1`; update the `streamdown` parent after compatibility review. |
| `nanoid` | 2 | React Navigation → `nanoid` | `>=3.3.18`; path update available. |

The audit additionally reports no patched version for two `image-size` High findings and notes that some `postcss`, `dompurify`, and legacy `js-yaml` findings require parent-package review rather than an automatically safe override.

## `image-size` residual-advisory assessment

The clean production audit resolves `image-size@1.2.1` only through `mobile/switchos-native → expo → @expo/metro → metro → image-size`. It reports two High findings with no patched version: CVE-2025-71330 / GHSA-w3rx-r6r6-pgpr for a zero-length ICNS-entry loop and CVE-2025-71329 / GHSA-5p2g-fcmc-qvqq for zero-sized JXL/HEIF boxes. The installed `1.2.1` `findBox` helper already advances past zero-size JXL/HEIF boxes, but the ICNS parser still increments its offset by an unchecked entry length and can therefore stall on a zero-length entry.

The selected mitigation is a narrow, version-exact `pnpm` patch for `image-size@1.2.1`. It rejects invalid ICNS container lengths and entry lengths below the eight-byte header, as well as entries extending beyond the declared container. The patch neither changes Metro’s public API nor changes its dependency graph. It must be applied through `patchedDependencies`, verified by a clean frozen install, and tested with a zero-length ICNS regression payload before the dependency gate can be re-evaluated.

## Registry observations

The current registry version of `streamdown` is `2.5.0`, with React 18/19 peer compatibility and `mermaid` declared as `^11.12.2`. This is a major upgrade from the repository’s `^1.4.0` declaration and must receive source-usage and build validation before adoption. The latest Expo SDK 54 patch available is `54.0.36`; the lockfile already resolves that patch line, so Expo 54 patch updates alone do not close every audited High finding.

## Safe remediation order

First, verify whether dashboard source imports `streamdown`; if so, update it as a controlled major dependency change and repair any API breaks. Second, apply only lockfile-level compatible parent updates or scoped overrides that preserve the consuming package’s supported semver line. Third, rerun production audit, TypeScript checking, build, root tests, and mobile workspace checks. A High finding without a patched version remains a release blocker and must be removed by upgrading/replacing its parent dependency rather than suppressed.

## Sources

- npm registry metadata queried through the package manager on 2026-08-14: `streamdown@2.5.0`, `expo@54.0.36`.
- Local audit capture: `/tmp/deliveryplatform-prod-audit.json`.
- Local clean production audit: `/tmp/deliveryplatform-clean-production-audit-pnpm1034.json`.
- [GitHub Advisory GHSA-w3rx-r6r6-pgpr](https://github.com/advisories/GHSA-w3rx-r6r6-pgpr) and [GHSA-5p2g-fcmc-qvqq](https://github.com/advisories/GHSA-5p2g-fcmc-qvqq), accessed 2026-08-15.
- [pnpm patch documentation](https://pnpm.io/cli/patch), accessed 2026-08-15.
