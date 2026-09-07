# Medusa Dependency-Audit Remediation Guide

**Scope:** `services/medusa/commerce-core` on branch `feature/commerce-field-developer`
**Observed runtime package:** `@medusajs/medusa@2.20.1`
**Observed production audit:** 67 High, 9 Moderate, 0 Critical, 76 total
**Date:** 2026-09-06

## Decision

Do **not** run `npm audit fix --force` for this service. The local audit’s proposed “fix” is a downgrade from Medusa v2.20.1 to `@medusajs/medusa@1.20.11`, which is a SemVer-major regression and incompatible with the v2 configuration, subscriber, and module model used by this service. The npm CLI documents that `--force` permits changes outside declared ranges, including major-version changes, and explicitly warns against using it without a clear plan.[1]

The non-forced lockfile-only experiment was performed in a temporary copy with lifecycle scripts disabled. It left the audit unchanged at **67 High and 9 Moderate**, so there is no safe automatic remediation available from the current lockfile.

## What the audit represents

The 76 entries are **meta-vulnerabilities**, not 76 independent top-level dependencies. The direct root is one package, `@medusajs/medusa@2.20.1`; its fixed-version family pulls in many aligned `@medusajs/*` modules. npm creates meta-vulnerabilities when a package can only install a vulnerable dependency tree; this explains the high count.[1]

| Advisory root | Observed installed route | Audit severity | Automated path | Safe action |
|---|---|---:|---|---|
| `lodash <=4.17.23` | `@graphql-codegen/*` → Medusa CLI/framework family | High | Only `--force`, which proposes Medusa v1.20.11 | Wait for or test an official compatible Medusa v2 release; do not force-downgrade. |
| `uuid <11.1.1` | `bullmq@5.13.0` → `@medusajs/event-bus-redis` | Moderate | Only `--force` through framework tree | Treat as framework-owned; do not replace `uuid` under BullMQ without full vendor-compatible integration tests. |
| `ajv <=8.17.1` | `@hookform/resolvers` in the Medusa draft-order path; RushStack CLI path | Moderate | `npm audit fix` advertised, but the complete non-forced tree remained unchanged | Candidate for a controlled override experiment only after a fresh test matrix; it does not clear the framework family finding. |
| `qs <=6.15.3` | nested under `express@4.22.2` / `body-parser@1.20.6` | Moderate | `npm audit fix` advertised, but did not change the production tree in the experiment | Candidate for a controlled override experiment only after HTTP contract and upload tests; it does not clear the framework family finding. |

The installed service is already on Medusa v2.20.1, which is the current release shown in the official release feed. That release contains security fixes, including store-field filtering; v2.20.0 also includes payment-provider region validation, MFA challenge enforcement, and store relation limits.[2] [3] The audit’s proposed v1.20.11 downgrade is therefore not a valid remediation route.

> Medusa’s maintainers have previously distinguished framework dependency findings that are CLI/developer-tool scoped from those that affect production request processing. That scoping can inform risk review, but it does **not** remove the local deployment gate: this project should continue to block Medusa deployment until its approved production audit policy is satisfied.[4]

## Required P0 containment

Keep the Medusa container **non-deployable** until a reviewed clean audit is obtained. The DeliveryPlatform server can continue to compile and test the signed event boundary, but no `services/medusa/commerce-core` image may be promoted to staging or production while the High findings remain.

Run the service only in an isolated disposable environment if an integration demonstration is necessary. The disposable deployment must use a dedicated PostgreSQL database, Redis namespace, store-specific HMAC secret, no live payment provider, no production customer data, network egress allow-listing, and a network policy that permits only the DeliveryPlatform signed ingress endpoint.

The current Dockerfile must use a patched Node runtime. Medusa’s January 2026 security notice recommends Node **20.20.0**, **22.22.0**, **24.13.0**, or **25.3.0**; the base image must be advanced to a matching maintained digest before a future integration deployment.[5]

## Supported release-upgrade procedure

Use this procedure only when the Medusa release feed documents a newer v2 release and its release/security notes cover the affected dependency family. It does not execute a downgrade.

```bash
cd /home/ubuntu/DeliveryPlatform-commerce-field

git switch feature/commerce-field-developer
git pull --ff-only  # only after the branch has an approved remote

git switch -c chore/medusa-v2-security-upgrade

cd services/medusa/commerce-core
cp package.json package.json.pre-medusa-security-upgrade
cp package-lock.json package-lock.json.pre-medusa-security-upgrade

current="$(npm view @medusajs/medusa version)"
printf 'candidate Medusa v2 release: %s\n' "$current"
case "$current" in
  2.*) ;;
  *) echo 'Refusing non-v2 candidate'; exit 1 ;;
esac

# Keep the complete Medusa family on one vendor-supported v2 release.
npm install --package-lock-only --ignore-scripts \
  "@medusajs/medusa@${current}" \
  "@medusajs/admin-bundler@${current}"

npm ci --ignore-scripts
npm run build
npm audit --omit=dev --audit-level=high --json > ../../validation/medusa-production-audit-after-upgrade.json || audit_status=$?
node -e 'const a=require("../../validation/medusa-production-audit-after-upgrade.json"); console.log(a.metadata.vulnerabilities)'

# Verify downloaded registry signatures/provenance where supported.
npm audit signatures --include-attestations --json \
  > ../../validation/medusa-package-attestations-after-upgrade.json

git diff --check
git diff -- package.json package-lock.json
```

Do not commit unless the package-lock is reproducible, Medusa build succeeds, the disposable signed-event integration test succeeds, and the production audit complies with the security policy.

## Controlled override experiment for the residual advisory roots

A temporary branch can determine whether the independent nested roots can be resolved without changing Medusa APIs. This experiment is **not** a production patch by itself. Do not override individual `@medusajs/*` packages, the Medusa framework, BullMQ, or UUID before vendor compatibility validation.

```bash
cd /home/ubuntu/DeliveryPlatform-commerce-field/services/medusa/commerce-core

git switch -c experiment/medusa-nested-advisory-overrides
cp package.json package.json.before-overrides
cp package-lock.json package-lock.json.before-overrides

npm pkg set 'overrides.ajv=8.20.0'
npm pkg set 'overrides.qs=6.16.0'
# `lodash` and `uuid` are intentionally omitted. Their dependency paths traverse
# Medusa/GraphQL and BullMQ and require a vendor-supported release or a complete
# compatibility test before considering an override.

npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
npm run build
npm audit --omit=dev --audit-level=high --json > audit-after-nested-overrides.json || true
npm test -- --run tests/medusa-commerce-signature.test.ts
```

If this experiment changes any Medusa module version, breaks build output, changes lockfile integrity unexpectedly, or leaves High findings, revert it:

```bash
mv package.json.before-overrides package.json
mv package-lock.json.before-overrides package-lock.json
rm -rf node_modules
npm ci --ignore-scripts
```

Even if the `ajv` and `qs` experiment succeeds, it does **not** clear the High framework/meta-vulnerability family and is not a release approval.

## Mandatory validation gate for any candidate patch

Run all of the following from a clean worktree before proposing a security-upgrade pull request.

```bash
cd /home/ubuntu/DeliveryPlatform-commerce-field

pnpm run check
pnpm run build
pnpm vitest run tests/medusa-commerce-signature.test.ts
./scripts/testing/validate-medusa-commerce-db.sh
./scripts/testing/validate-field-service-db.sh
./scripts/testing/validate-developer-api-db.sh

cd services/medusa/commerce-core
npm ci --ignore-scripts
npm run build
npm audit --omit=dev --audit-level=high --json > ../../validation/medusa-production-audit-candidate.json
npm audit signatures --include-attestations --json \
  > ../../validation/medusa-package-attestations-candidate.json
```

Then run the new `commerce-field-developer-controls.yml` workflow on a real disposable, label-matched runner. Preserve the workflow run URL, runner assignment, package-lock diff, audit JSON, signature/provenance output, build logs, and database-harness output with the reviewed commit SHA.

## If no vendor-supported clean release exists

Do not suppress or ignore the findings in a production gate. Maintain a time-bounded exception only for a **non-production**, isolated evaluation environment, with the following compensating controls: no real payment, no public Store/Admin exposure, no public upload route, no production secrets, dedicated database and Redis, restricted egress, image digest pinning, immutable deployment, runtime telemetry, and a documented expiry/owner. Reassess on every Medusa release and remove the exception once an approved upgrade passes the candidate gate.

The practical production decision is straightforward: deploy the DeliveryPlatform field-service/developer API modules without launching the Medusa service, or defer retail/food commerce activation until a vendor-supported Medusa v2 remediation produces a clean audit.

## References

[1] [npm CLI: `npm audit`](https://docs.npmjs.com/cli/v11/commands/npm-audit/)
[2] [Medusa v2.20.1 release notes](https://github.com/medusajs/medusa/releases/tag/v2.20.1)
[3] [Medusa v2.20.0 security fixes](https://github.com/medusajs/medusa/releases/tag/v2.20.0)
[4] [Medusa issue #14993: maintainer scope analysis and follow-up](https://github.com/medusajs/medusa/issues/14993)
[5] [Medusa: Security Update—Upgrade Node runtime](https://medusajs.com/blog/upgrade-node-runtime)
