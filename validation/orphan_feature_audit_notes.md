# SwitchOS orphaned and scaffolded feature audit notes

## Current platform state

The primary workspace is no longer just a broken scaffold. The first recovery pass has rebuilt a **coherent TypeScript runtime** and converted several placeholder domains into connected operator workspaces, but a larger legacy backend surface still remains outside the active compile scope.

| Area | Finding | Current impact |
|---|---|---|
| Client route surface | The app router has been narrowed to domains that now have actual page implementations | The visible product shell is coherent again for the restored domains |
| Client foundations | `main.tsx`, TRPC client wiring, constants, layout shell, and base UI primitives have been restored | The frontend now compiles against a working foundation |
| Backend entrypoint | `server/_core/index.ts`, TRPC helpers, cookies, and system router have been restored | The TypeScript API has a runnable backbone again |
| Summary-only routes | Merchant channels, phone ordering, and service recovery were previously generic placeholders | These now have dedicated connected pages and API workspaces |
| Existing workflow pages | Analytics, driver mobility, tableside commerce, and white-label apps remain present and connected through the rebuilt router | The highest-visibility restored domains are compile-stable |
| Legacy database layer | `server/db.ts` still contains partially restored and incompatible code paths tied to absent schema and helper modules | This remains the largest disconnected subsystem |
| Lakehouse helper | `server/lib/lakehouse.ts` still depends on missing schema modules from the older structure | Analytics integration still needs a reintegration pass |
| Services tree | Go, Rust, and Python services exist with richer logic than before | The main TypeScript platform still needs deeper contract wiring to them |

## Highest-priority scaffold conversions completed

| Domain | Previous pattern | Current state |
|---|---|---|
| Merchant channels | Inline generic workspace placeholder in the app router | Replaced with a dedicated connected page and API workspace |
| Service recovery | Inline generic workspace placeholder in the app router | Replaced with a dedicated connected page and API workspace |
| Phone ordering | Inline generic workspace placeholder in the app router | Replaced with a dedicated connected page and API workspace |
| Core TypeScript runtime | Missing TRPC, constants, router, and shell modules | Rebuilt into a compile-stable client and server foundation |

## Remaining structural risks

| Area | Risk |
|---|---|
| Legacy `server/db.ts` | Still contains a large amount of incompatible, partially restored logic outside the active rebuilt runtime |
| Lakehouse integration | Previous analytics-lakehouse helper is still outside the active compile scope and needs reattachment to the new server foundation |
| Multi-language services | Rust, Go, and Python services need a new contract pass so restored frontend flows consume service-backed domain logic rather than static workspace payloads |
| Missing domains | Several platform ambitions are correctly absent rather than falsely scaffolded; they should be added only with backend coverage and verification |

## Immediate next implementation direction

The next implementation step should move from static workspace restoration to **operational behavior restoration**. That means enriching the rebuilt TypeScript workspaces with action-oriented state, then reconnecting those flows to the existing Go, Rust, and Python services before expanding platform breadth further.

## Verification evidence from the current recovery pass

The rebuilt connected TypeScript runtime now passes `pnpm check` and `pnpm build`. After adding the missing `index.html` and `vite.config.ts`, the production build completed successfully and emitted both the browser bundle and the bundled Node server. The rebuilt server also starts successfully in production mode when provided the required `JWT_SECRET`, `OAUTH_SERVER_URL`, and `DATABASE_URL` variables, and `/api/health` returns a healthy response.

The current runtime verification confirms that the recovered platform foundation is no longer merely a disconnected scaffold. The main remaining gap is deeper service and legacy-backend reintegration, not basic application boot failure.
