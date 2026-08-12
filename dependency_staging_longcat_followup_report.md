# Dependency Remediation, Staging Verification, and LongCat Role

## Outcome

The remediation removed **all 3 critical production dependency findings** and reduced high-severity findings from **55 to 16**. The remaining 16 high findings are confined to the embedded **Expo SDK 54 / React Native build toolchain** and include one package with no upstream patched version (`image-size`). I did not claim these are fixed, because forcing incompatible transitive upgrades into Expo’s SDK-managed graph would be unsafe without a supported Expo SDK migration and native-device validation.

| Measure | Initial audit | Current audit | Result |
|---|---:|---:|---|
| Critical findings | 3 | 0 | Resolved in the active production graph. |
| High findings | 55 | 16 | Reduced by 39; remaining findings are Expo SDK 54 toolchain transitive dependencies. |
| Full test suite | Not run after all upgrades | 62 passed, 1 skipped, 28 intentionally skipped | Passed. |
| Root TypeScript check | Not run after all upgrades | Passed | Passed. |
| Embedded mobile TypeScript check | Not run after all upgrades | Passed | Passed. |
| Live Docker staging verification | Requested | Not executable in this sandbox | Docker and Caddy binaries are unavailable. |

## Dependency Work Completed

The remediation first removed obsolete production packages with no tracked runtime imports, rather than retaining vulnerable tooling simply because it remained in `package.json`. The removed packages were `@mojaloop/api-snippets`, `@mojaloop/sdk-standard-components`, `@grpc/grpc-js`, `@grpc/proto-loader`, `firebase-admin`, `socket.io`, and `socket.io-client`.

The active direct dependencies were then updated to supported versions: Express 5.2.1, tRPC 11.18.0, Axios 1.19.0, Drizzle ORM 0.45.2, Nanoid 5.1.16, and PostCSS 8.5.26. The lockfile and installed graph were regenerated with `pnpm install --ignore-scripts`.

> The attempted broad pnpm override policy was removed after verification showed that the active pnpm resolver did not apply it to the relevant nested Expo dependencies. Keeping a policy that does not affect the lockfile would create a false security signal. pnpm documents workspace-level dependency overrides as a root-level setting, but this repository’s current resolver behavior did not apply the proposed policy to the audited Expo subtree. [1]

## Remaining High Findings

The remaining audit paths originate from Expo SDK 54’s tooling graph, including `@expo/cli`, Metro, Babel/Jest, Expo config plugins, and related packages. The vulnerable package families are `brace-expansion`, `fast-uri`, `image-size`, `js-yaml`, `nanoid`, and `postcss`.

| Remaining family | Representative path | Why it remains | Required remediation |
|---|---|---|---|
| `brace-expansion`, `fast-uri`, `js-yaml`, `nanoid`, `postcss` | Expo SDK 54 → Expo CLI / Metro / config plugins | These packages are resolved by the SDK-managed Expo toolchain, not by an independently used platform service. | Upgrade to an Expo SDK release that publishes patched compatible transitive versions, then validate iOS, Android, web, Metro, and native modules. |
| `image-size` | Expo SDK 54 → Metro | The advisory reports no patched version. | Obtain an upstream Metro/Expo replacement or mitigation; do not override blindly. |

The remaining findings are a **release blocker** for a strict zero-high-vulnerability production policy. The safe next step is a dedicated Expo SDK upgrade branch, not a lockfile-only forced override.

## Staging Verification Status

The sandbox has neither `docker` nor `caddy` installed, so it cannot boot the Caddy/APISIX/Keycloak/Open AppSec stack. I added `scripts/verify-staging-edge.sh`, which fails closed and can be run immediately in a Docker-capable staging environment. It proves the following live conditions:

| Check | Expected proof |
|---|---|
| Caddy TLS ingress | `https://<public-host>/healthz` returns HTTP 200. |
| Redirect behavior | `http://<public-host>/healthz` returns a redirect response. |
| Keycloak OIDC | `https://<auth-host>/realms/switchos/.well-known/openid-configuration` returns HTTP 200 through Caddy. |
| Open AppSec enforcement | A suspicious SQL-style query with a scanner user agent returns 403, 406, or 429 at the public edge. |

Run the verifier only after the container stack and Open AppSec enforcement point are deployed:

```bash
SWITCHOS_PUBLIC_HOST=switchos.example.com \
SWITCHOS_AUTH_HOST=auth.example.com \
./scripts/verify-staging-edge.sh
```

## LongCat’s Intended Platform Role

LongCat is the platform’s **LLM-centric operational intelligence layer**, not a generic label for static heuristics. It uses a configured local Ollama model to generate structured, data-grounded assistance for three operational domains.

| LongCat capability | LLM-centric role | Inputs used | Output |
|---|---|---|---|
| Consumer concierge | Turns verified caller context, memory, channel availability, and current order friction into operator-ready assistance. | Assisted-ordering signals, customer memory, voice and messaging availability. | Personalized recommendations, operator script, accessible next actions. |
| Merchant consultant | Converts verified channel, benchmark, and forecasting evidence into commercial guidance. | Channel mix, owned vs. partner surfaces, benchmarks, and forecast inputs. | Market brief, demand forecast, menu and channel actions, financial watchouts. |
| Dispatch intelligence | Interprets supply telemetry and optimization candidates to generate operational dispatch guidance. | Online supply, trip-radar evidence, airport readiness, telemetry, and ranked candidates. | Dispatch brief, batching strategy, risk flags, rider guidance, and reallocations. |

LongCat now returns explicit provenance on every response:

```ts
source.execution_mode: "llm" | "heuristic_fallback"
```

`execution_mode: "llm"` means the Ollama provider returned parseable structured output. `execution_mode: "heuristic_fallback"` means the model was unavailable or malformed and the response is deterministic guidance, clearly labeled as such. This distinction prevents offline rules from being misrepresented as AI inference and preserves operational continuity without silent mockware.

The LongCat tests cover provider success, provider outage, malformed JSON, partial output normalization, explicit unavailable dispatch evidence, callback-consent controls, and terminal voice-session handling. It is robust for **provider availability and output-shape failure**, but still needs staging validation for load, latency, prompt injection, PII redaction, model monitoring, and human override audits.

## References

[1]: https://pnpm.io/10.x/settings "pnpm 10.x Settings: workspace overrides"
