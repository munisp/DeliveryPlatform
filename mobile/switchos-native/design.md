# SwitchOS Native Mobile Design

## Product Direction

SwitchOS Native Mobile is an **offline-first operator and field-operations application** for a multi-vertical delivery and local-commerce platform. The app is designed for dispatch leads, fleet operators, merchant operators, and logistics coordinators who often work on unstable mobile networks. The mobile experience should feel like a **first-party iOS application** while remaining practical on Android, with strong one-handed usage, large tap targets, high-contrast status signaling, and quick access to high-value workflows even when connectivity is weak.

The design assumes **portrait-first 9:16 mobile use** and emphasizes fast situational awareness. Core screens should prioritize operational clarity over decorative density, with the most urgent metrics, actions, and sync states visible in the upper half of the screen.

## Screen List

| Screen | Purpose | Primary Layout |
| --- | --- | --- |
| Launch and Sync Gate | Fast app entry, session restore, offline database warm-up, queued sync status | Full-screen status stack with logo, sync card, retry and continue actions |
| Sign-In | Operator identity, environment selection, fallback local access when the network is unstable | Single-column credential form with environment chip and recovery actions |
| Home Command Center | Daily summary for logistics, merchant growth, loyalty, dispatch pressure, and sync health | Scrollable dashboard with stacked cards and top priority banner |
| Logistics Control Tower | Supply resilience, warehouse alerts, replenishment backlog, middleware health | KPI strip, risk cards, zone list, and action dock |
| Dispatch Resilience | Driver supply, pressure zones, rebalancing recommendations, assignment exceptions | Map-placeholder header, zone cards, action list, and escalation panel |
| Inventory Truth | Stock risk by node, inventory drift, restock urgency, and truth confidence | Filter chips, inventory cards, and node detail sheets |
| Procurement Planner | Purchase and transfer proposals driven by forecast and inventory inputs | Proposal queue, urgency bands, line-item preview, and confirm actions |
| Merchant Growth Console | Campaign execution, audience sends, merchant channel health, and benchmarking | Merchant picker, campaign cards, benchmark trends, and quick launch actions |
| Loyalty Intervention | Customer retention actions, point issuance, redemptions, recovery offers | Customer summary card, reward actions, and recent intervention feed |
| Driver Mobility | Driver operations, field routing context, and logistics-control shortcuts | Dispatch cards, risk indicators, and mobile-first action buttons |
| Task Queue and Offline Outbox | Pending actions, queued mutations, conflict resolution, and retry status | Segmented tabs for pending, syncing, failed, and resolved actions |
| Alerts and Notifications | High-priority operational alerts, replenishment events, and dispatch exceptions | Time-grouped notification list with severity markers |
| Settings and Connectivity | API environment, offline storage, sync policy, notification preferences | Form sections with toggles, connection diagnostics, and cache controls |
| Record Detail Sheet | Deep detail for order, warehouse, merchant, driver, or campaign records | Bottom sheet with summary header and action stack |

## Primary Content and Functionality

### Launch and Sync Gate

This screen should restore the last operator session, initialize local persistence, and display whether the app is **online**, **degraded**, or **offline but usable**. It needs a compact progress indicator, a last-sync timestamp, and a clear call to continue into the app when cached data is available.

### Sign-In

The sign-in screen should support operator authentication and environment-aware entry. In unstable conditions, it should clearly separate **network-required sign-in** from **cached local session resume**. The form should use large fields, a single primary action, and a fallback note explaining limited offline access.

### Home Command Center

The home screen should provide a concise but information-rich overview. The top area should contain a **priority banner** that rotates between supply risk, dispatch pressure, replenishment backlog, or merchant growth alerts. Beneath that, stacked cards should summarize logistics, dispatch, merchants, loyalty interventions, and offline queue state. Each card should show one primary metric, one supporting metric, and one high-confidence action.

### Logistics Control Tower

This is the core supply-chain screen. It should display warehouse health, stock-risk bands, pending replenishment tasks, middleware readiness, and recent planning events. The screen should support quick actions such as **queue replenishment**, **open inventory truth**, **view supply shock recommendations**, and **retry failed workflow publication**.

### Dispatch Resilience

This screen should focus on zone-level dispatch operations. It should show supply-demand pressure, rebalancing recommendations from the Rust optimizer, live exceptions, and priority actions for dispatch supervisors. The first viewport should show pressure zones, not low-priority history.

### Inventory Truth

This screen should provide an operational stock view across micro-warehouses or merchant nodes. Operators should be able to filter by risk level, node, and category. Each inventory card should include current quantity, projected exhaustion window, confidence level, and suggested follow-up action.

### Procurement Planner

This screen should convert forecast and inventory signals into actionable procurement or transfer proposals. Operators should see urgency, recommended source, quantity, and expected service-level impact. The screen should make it easy to approve or queue a replenishment action with minimal typing.

### Merchant Growth Console

This screen should expose merchant benchmarking, campaign readiness, audience sends, and performance summaries. It should be useful in the field for merchant success operators and should not depend on long tables. Instead, it should use compact cards, trend badges, and action buttons.

### Loyalty Intervention

This screen should show loyalty accounts, retention flags, recent interventions, and available reward actions. It should allow rapid issuance of service recovery points or targeted reward nudges without forcing operators into desktop-style forms.

### Driver Mobility

This screen should present driver supply context, field status, and a direct link to logistics control. Because drivers and dispatch coordinators may glance at the screen quickly, the layout should prioritize large status bands and fast actions over dense analytics.

### Task Queue and Offline Outbox

This screen is critical for low-connectivity environments. It should display locally queued actions, sync attempts, failures, retries, and conflicts. The user must always understand whether an action has been committed remotely, stored locally, or needs intervention.

### Alerts and Notifications

This screen should show prioritized alerts for supply-chain issues, dispatch breakdowns, replenishment deadlines, and merchant campaign events. Alerts should be grouped by severity and time, with the top section reserved for operationally urgent items.

### Settings and Connectivity

This screen should expose environment selection, API health, notification preferences, offline storage size, sync interval behavior, and manual retry actions. It should also make it easy to clear local cache without endangering queued work.

## Key User Flows

| Flow | Steps |
| --- | --- |
| Resume work with poor connectivity | Launch app → Sync Gate checks connectivity and cached session → User continues in offline-capable mode → Home shows stale-data banner and offline queue state |
| Queue replenishment from stock risk | Home or Logistics Control Tower → Tap critical supply card → Open Inventory Truth or Procurement Planner → Review proposal → Queue replenishment action → Action enters offline outbox if network is weak |
| Resolve dispatch pressure | Home priority banner → Open Dispatch Resilience → Review pressure zone and rebalance recommendation → Approve action or escalate → Result shows as sent or queued |
| Run merchant growth action | Merchant Growth Console → Select merchant → Review benchmark and campaign readiness → Trigger audience send or campaign action → Confirmation with local audit entry |
| Apply loyalty intervention | Alerts or Loyalty Intervention → Open customer profile → Issue recovery reward or targeted incentive → Store action locally if offline → Sync when connectivity returns |
| Review failed work | Home sync card or notifications → Open Task Queue and Offline Outbox → Filter failed actions → Retry or inspect conflict → Confirm updated sync state |

## Offline-First Behavior

The app should treat local persistence as a first-class runtime layer. High-value read models such as logistics summaries, inventory snapshots, dispatch pressure zones, merchant benchmark summaries, and loyalty intervention queues should be cached locally. Write actions such as replenishment requests, campaign executions, and loyalty interventions should be stored in a local outbox when network calls fail or when the device is offline.

The UI must show three explicit states: **live**, **stale but usable**, and **action queued locally**. These states should appear consistently in banners, record sheets, and action confirmations.

## Navigation Model

The mobile app should use a **tab-based shell** for high-frequency workflows and stack navigation for detail views.

| Tab | Role |
| --- | --- |
| Home | Command Center and global summary |
| Logistics | Logistics Control Tower and Inventory Truth entry |
| Dispatch | Dispatch Resilience and Driver Mobility entry |
| Growth | Merchant Growth Console and Loyalty Intervention |
| Queue | Offline Outbox, alerts, and settings entry |

Deep detail should open as push screens or bottom sheets to preserve one-handed continuity.

## Color Choices

The visual system should communicate trust, urgency, and network state while fitting a logistics product.

| Token | Color | Use |
| --- | --- | --- |
| Primary | `#0F62FE` | Main actions, active tab state, links |
| Background | `#08111F` | App background for operator mode |
| Surface | `#122033` | Cards and raised surfaces |
| Foreground | `#F8FAFC` | Primary text |
| Muted | `#94A3B8` | Secondary text and metadata |
| Border | `#22324A` | Dividers and subtle card boundaries |
| Success | `#16A34A` | Healthy network, successful sync, safe supply |
| Warning | `#F59E0B` | Risk, low inventory, delayed sync |
| Error | `#DC2626` | Failed actions, critical supply gaps, dispatch incidents |
| Accent 2 | `#14B8A6` | Middleware and systems-health highlights |

## iOS-Like Interaction Guidance

The app should feel deliberate and calm, using soft radius values, restrained shadows, and clear spacing. Primary cards should feel tappable but not crowded. Haptics should reinforce key actions such as successful queueing, retry confirmation, and error acknowledgement. Motion should be subtle: quick fade and scale transitions are preferable to dramatic springs.

## Initial Feature Scope for Implementation

The first implementation wave should focus on the screens and flows that most directly map to the current SwitchOS backend and PWA capabilities: Home Command Center, Logistics Control Tower, Dispatch Resilience, Inventory Truth, Procurement Planner, Merchant Growth Console, Loyalty Intervention, Task Queue, Alerts, and Settings. These provide the strongest functional bridge from the existing system into a true native mobile experience.
