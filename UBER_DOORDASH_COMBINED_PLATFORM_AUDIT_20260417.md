# SwitchOS Audit Against Combined Uber and DoorDash Scope

## Executive conclusion

**No — the current SwitchOS platform should not be described as a complete combination of Uber and DoorDash.** It is a **substantial multi-vertical delivery commerce and operations platform** with meaningful DoorDash-style commerce coverage and selected Uber-like logistics, dispatch, identity, and business-infrastructure elements. However, the evidence in the current codebase does **not** support claiming full end-to-end parity with the combined functional surface area of both companies.

The strongest accurate description is that SwitchOS is now a **broad, operator-centric, multi-vertical delivery commerce platform** with emerging parity across merchant operations, consumer ordering, courier workflows, payments and orchestration, but with major gaps in **rideshare mobility, mature customer self-serve apps, business travel, freight, transit, healthcare transportation, advanced merchant channel products, and fully productized ecosystem depth**.

## Benchmark basis

This audit used three evidence sources:

| Source type | Evidence used | Relevance |
| --- | --- | --- |
| Current platform documentation | `DOORDASH_PARITY_WAVE_REPORT_20260417.md`, `MULTI_VERTICAL_COMMERCE_COMPLETION_REPORT_20260417.md` | Establishes what was explicitly implemented and what the project already admits remains incomplete |
| Current codebase | `client/src/App.tsx`, `client/src/pages/MerchantHub.tsx`, `client/src/pages/ServiceProviders.tsx`, `server/routers.ts`, `server/db.ts` | Establishes what routes, modules, vertical models, and workflows actually exist |
| Public benchmark references | Uber offerings page and DoorDash Commerce Platform announcement | Establishes a current public baseline of what the two comparison platforms include [1][2] |

## What Uber and DoorDash publicly encompass

| Platform | Publicly evidenced scope | Source |
| --- | --- | --- |
| **Uber** | Ride-hailing, multiple ride classes, delivery, Eats marketplace, business accounts, freight, healthcare ride scheduling, transit-related offerings, scooters, airports, driver and courier earning flows | [1] |
| **DoorDash** | Merchant commerce platform including Drive On-Demand, Online Ordering, Phone Ordering, Tableside Order & Pay, Customer Support Solutions, branded mobile apps, and Business Manager mobile operations | [2] |

## What SwitchOS clearly covers today

### 1. Strong marketplace-operations foundation

The server router exposes a broad operations surface, including orders, drivers, providers, finance, analytics, merchant, courier, consumer, trust, experiments, checkout, merchant ads, courier radar, geospatial, verticals, vertical templates, service catalog, onboarding, commerce platform, loyalty, campaigns, payouts, referral, growth analytics, job monitoring, and audit domains. This demonstrates that the platform is no longer a narrow admin console; it is a fairly broad commerce-and-operations control plane.

### 2. DoorDash-style commerce coverage is meaningful but incomplete

The current project has explicit work for:

| Capability area | Evidence in project | Status |
| --- | --- | --- |
| Consumer checkout intelligence | `ConsumerCheckout.tsx`, `checkout.summary` | Present |
| Merchant ads / sponsored listings | `MerchantAdsStudio.tsx`, `merchantAds.summary` | Present |
| Courier trip radar | `CourierTripRadar.tsx`, `courierRadar.summary` | Present |
| Merchant operations and settlements | `MerchantHub.tsx`, finance/support/campaign coupling | Present |
| Generic provider onboarding | `ProviderOnboarding.tsx`, `provider_onboarding_requests` | Present |
| Cross-vertical catalog provisioning | `ServiceCatalog.tsx`, `provider_catalog_items` | Present |
| Vertical templates and intake templates | `VerticalTemplates.tsx`, `vertical_service_templates`, `customer_service_intake_templates` | Present |
| Public website and stakeholder portal | public site plus `/portal` | Present |

### 3. Multi-vertical architecture is real

The database layer includes multi-vertical tables and seeded logic for categories such as **laundry/dry cleaning**, **pharmacy**, **retail**, and generic pickup/drop-off. The seeded template logic explicitly varies fulfillment mode, pricing model, intake fields, and SLA behavior by vertical. That means the platform is architected for far more than restaurant delivery.

### 4. Polyglot service layer exists

The platform includes TypeScript application surfaces plus supporting **Go**, **Rust**, and **Python** services for provisioning, pricing, dispatch, personalization, merchant ads, intake orchestration, and middleware integrations. This is material platform infrastructure, not a single monolith.

## Why the platform is not yet a complete Uber + DoorDash combination

### A. Uber-side gaps are still major

Uber is not only food delivery. Its public offering spans rides, transit-related mobility, healthcare transportation, freight, business travel, airport flows, and multimodal transport [1]. The current SwitchOS codebase does **not** demonstrate complete productized support for those domains.

| Uber functional area | Current SwitchOS status | Audit conclusion |
| --- | --- | --- |
| Consumer ride-hailing app | No clear rider booking, trip request, driver ETA ride map, fare quote, rider payment lifecycle comparable to Uber Rides | **Missing** |
| Driver app for passenger mobility | Courier and dispatch surfaces exist, but not a full passenger mobility driver product | **Partial / mostly missing** |
| Business travel / Uber for Business | Some enterprise/operator infrastructure exists, but no mature employee travel, policy, or expensing product | **Missing** |
| Freight | No evidence of a shipper-carrier freight marketplace with load booking and carrier workflows | **Missing** |
| Health / healthcare ride coordination | No complete patient scheduling or care-organization ride management workflow | **Missing** |
| Transit / scooters / multimodal mobility | No complete consumer multimodal transport product | **Missing** |
| Airport-specific mobility flows | Not a demonstrated product surface | **Missing** |

### B. DoorDash-side gaps remain in merchant-channel depth

DoorDash publicly positions a merchant commerce stack that includes Drive On-Demand, Online Ordering, Phone Ordering, Tableside Order & Pay, Customer Support Solutions, branded mobile apps, and Business Manager mobile operations [2]. SwitchOS now covers parts of this space, but not all of it.

| DoorDash functional area | Current SwitchOS status | Audit conclusion |
| --- | --- | --- |
| Merchant delivery on owned channels | Architecture supports provider onboarding, catalogs, and checkout; direct merchant web/app ordering flows are only partially represented | **Partial** |
| Online ordering / first-party web commerce | Core building blocks exist, but not a clearly finished merchant self-serve first-party storefront builder | **Partial** |
| Branded mobile apps | No complete white-label native app generation or branded merchant app delivery system found | **Missing** |
| Phone ordering | No clear AI or human-assisted phone ordering workflow found | **Missing** |
| Tableside order and pay | No complete QR tableside ordering flow found | **Missing** |
| Customer support solutions | Trust/support surfaces exist, but not a fully productized customer support suite for merchant-owned channels | **Partial** |
| Business Manager mobile operations | Operator web dashboards exist, but not a dedicated mobile business-manager product | **Missing / partial** |

### C. Customer-grade product completeness is not yet at market-leader level

Much of the current implementation is **operator-facing**. That is valuable, but it is not the same as delivering polished, high-scale, end-customer and end-merchant experiences comparable to Uber and DoorDash.

| Capability | Current status |
| --- | --- |
| Fully polished consumer mobile journeys across discovery, basket, promotions, order tracking, support, refunds, memberships, and reorder | Partial |
| Merchant self-serve onboarding from signup to go-live with compliance, menu/catalog import, channel setup, payouts, and support | Partial |
| Courier self-serve lifecycle from onboarding to earnings to schedules to compliance and support | Partial |
| Real-time operational resilience under live infrastructure load | Not established by current audit evidence |
| Mature notifications, CRM, lifecycle marketing, retention science, and experimentation loops | Partial |

## Strengths of the current platform

| Strength | Why it matters |
| --- | --- |
| **Cross-vertical model** | The platform is not trapped in restaurant delivery and can support dry cleaning, pharmacy, retail, and other service categories |
| **Operational breadth** | Merchant, courier, consumer, trust, experiments, finance, onboarding, catalog, and templates are all represented |
| **Polyglot service architecture** | Go, Rust, Python, and TypeScript are used in ways that can scale into specialized services |
| **Strong operator control plane** | This is one of the platform's best-developed dimensions |
| **Good foundation for white-label commerce** | Templates, catalog items, onboarding, and public portal create a solid basis for vertical delivery platforms |

## Most important shortcomings

### Priority 1 — Missing Uber mobility stack

If the goal is to claim a combined Uber + DoorDash platform, the largest deficiency is the absence of a truly complete **mobility/rideshare product line**. Without rider booking, live trip management, mobility pricing, business travel, and driver mobility workflows, the platform cannot honestly be called a full Uber equivalent.

### Priority 2 — Missing merchant-owned channel depth comparable to DoorDash Commerce Platform

SwitchOS has provisioning and control-plane support, but it does not yet fully implement the mature merchant channel suite DoorDash markets publicly: branded merchant apps, direct online ordering stack, phone ordering, tableside flows, and customer-support tooling for those channels.

### Priority 3 — Missing customer-grade and merchant-grade lifecycle polish

The system is strongest as an operator and infrastructure platform. It is weaker as a **consumer-grade** and **merchant-grade** product ecosystem with refined self-serve onboarding, retention, account management, support, edge-case handling, and deep analytics loops.

### Priority 4 — Missing domain packs for regulated and specialized verticals

The platform includes vertical-aware templates, but the report itself correctly notes that deeper **compliance packs**, richer **vertical-specific automation**, and stronger **live infrastructure integration** still remain.

## Recommended roadmap to become more defensibly "Uber + DoorDash combined"

| Priority | Recommendation | Why it matters |
| --- | --- | --- |
| 1 | Build a full **mobility product line**: rider app, driver mobility app, fare quoting, trip lifecycle, live location, vehicle classes, airport flows | This is the largest current gap versus Uber |
| 2 | Build **merchant-owned channels**: branded storefronts, white-label apps, direct ordering widgets, merchant CRM, support workflows | This closes DoorDash Commerce Platform gaps |
| 3 | Add **phone ordering** and **tableside/QR ordering** | These are explicitly part of DoorDash's public merchant stack [2] |
| 4 | Add **business travel / enterprise transportation** workflows | Needed for Uber for Business-style parity |
| 5 | Add **freight / large-load logistics** workflows or remove Uber-comparison claims | Necessary for a credible Uber-combination claim |
| 6 | Expand **compliance and workflow packs** for pharmacy, alcohol, healthcare, and other regulated categories | Required for a complete multi-vertical platform |
| 7 | Build **native mobile stakeholder apps** or white-label mobile generation | Current web surfaces alone are not enough for full market parity |
| 8 | Add deeper **customer support, refund, dispute, incident, and service-recovery automation** | Necessary for mature operations at scale |

## Final audit statement

> **SwitchOS is a strong multi-vertical delivery commerce and operations platform, but it is not yet a complete combination of Uber and DoorDash.**
>
> It is already credible for multi-vertical delivery commerce, operator control, merchant onboarding, service provisioning, and courier operations. It is **not yet complete** on Uber's mobility ecosystem or DoorDash's full merchant-channel commerce suite.
>
> The honest current assessment is: **broad foundation with partial parity, not complete combined parity**.

## Citations

[1]: https://www.uber.com/us/en/about/uber-offerings/ "Uber Apps, Products, and Offerings | Uber"
[2]: https://ir.doordash.com/news/news-details/2024/Introducing-The-DoorDash-Commerce-Platform-for-Merchants/default.aspx "DoorDash - Introducing The DoorDash Commerce Platform for Merchants"
