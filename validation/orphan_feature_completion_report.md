# SwitchOS Orphaned and Scaffolded Feature Recovery Report

## Executive Summary

This recovery pass focused on the most visible **orphaned, scaffolded, generic, and disconnected TypeScript platform features** in the current SwitchOS workspace. The work did **not** claim full platform completion across every legacy subsystem. Instead, it rebuilt the missing application and API foundations first, then converted the highest-priority placeholder routes into connected operator workspaces that compile, build, and boot successfully.

The result is a platform that now has a **coherent runnable TypeScript shell** for the restored domains instead of a broken route graph, missing runtime modules, and non-buildable scaffolds.

## What Was Rebuilt

| Area | Recovery work completed | Outcome |
|---|---|---|
| Client foundation | Restored the missing client bootstrap dependencies, shared constants wiring, base stylesheet, and Vite entry configuration | The frontend now has a runnable build path |
| Server foundation | Recreated the missing core server entrypoint, TRPC base, cookie handling, and system wiring | The TypeScript API has a working runtime backbone |
| Router simplification | Narrowed the app and API surfaces to routes that can be supported coherently right now | The platform no longer advertises dozens of orphaned modules as finished |
| Merchant channels | Replaced a generic placeholder route with a connected page and workspace API | Merchant-channel operations now have a real routed surface |
| Service recovery | Replaced a generic placeholder route with a connected page and workspace API | Recovery operations now have a real routed surface |
| Phone ordering | Replaced a generic placeholder route with a connected page and workspace API | Phone-ordering operations now have a real routed surface |
| Existing restored domains | Preserved and aligned analytics, driver mobility, tableside commerce, and white-label apps with the rebuilt runtime | The main visible operator workspaces compile together |
| Build foundation | Added the missing `index.html` and `vite.config.ts` | Production build now completes |

## Verification Results

| Check | Result | Notes |
|---|---|---|
| `pnpm check` | Passed | Active rebuilt TypeScript runtime compiles cleanly |
| `pnpm build` | Passed | Client and bundled server build both completed |
| Production server boot | Passed with required env vars | Requires `JWT_SECRET`, `OAUTH_SERVER_URL`, and `DATABASE_URL` in production mode |
| `/api/health` | Passed | Returned healthy JSON response from the rebuilt server |

## Remaining Risks and Unfinished Areas

The platform still contains **legacy disconnected subsystems** that were intentionally kept outside the active compile scope during this recovery pass because they are not yet rehabilitated enough to serve as trustworthy runtime foundations.

| Area | Current status | Why it still matters |
|---|---|---|
| `server/db.ts` | Still partially restored and incompatible | It contains older domain logic, missing imports, and broken compatibility assumptions |
| `server/lib/lakehouse.ts` | Still outside the active rebuilt scope | Lakehouse analytics needs a clean reintegration pass |
| Go, Rust, and Python service wiring | Only partially connected to the rebuilt TypeScript surface | More direct end-to-end service invocation is still needed |
| Wider domain expansion | Intentionally not re-added yet | Additional routes should return only after backend coverage exists |

## Most Important Outcome

The most important improvement is that the platform now behaves like a **recovering product with a stable runnable shell**, not a **generic scaffold pretending to be complete**. The highest-priority operator workspaces are connected, the build works, and the server boots.

## Recommended Next Step

The next implementation pass should focus on **deep reintegration** rather than breadth. Specifically, it should rehabilitate the legacy database layer, reconnect the lakehouse analytics path, and wire the restored TypeScript workspaces to the richer Go, Rust, and Python service contracts so that the connected surfaces become fully operational rather than only structurally complete.
