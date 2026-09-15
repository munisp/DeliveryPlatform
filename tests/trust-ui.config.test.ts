import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("wave A3 trust UI surfaces (R1 rider verification, R4 appeals, R5 council)", () => {
  it("routes the worker council and deactivation appeals workspaces", () => {
    const app = source("client/src/App.tsx");
    expect(app).toContain('import WorkerCouncil from "@/pages/WorkerCouncil"');
    expect(app).toContain(
      'import DeactivationAppeals from "@/pages/DeactivationAppeals"',
    );
    expect(app).toContain('path="/council" component={WorkerCouncil}');
    expect(app).toContain('path="/appeals" component={DeactivationAppeals}');
  });

  it("exposes both workspaces in operator navigation", () => {
    const layout = source("client/src/components/DashboardLayout.tsx");
    expect(layout).toContain('label: "Worker Council"');
    expect(layout).toContain('path: "/council"');
    expect(layout).toContain('label: "Deactivation Appeals"');
    expect(layout).toContain('path: "/appeals"');
  });

  it("bridges every trust router procedure through typed wrappers with no any leakage into pages", () => {
    const bridge = source("client/src/lib/trpcTrust.ts");
    for (const procedure of [
      "council.listConsultations.useQuery",
      "council.getConsultation.useQuery",
      "council.respondToConsultation.useMutation",
      "deactivation.getMyCase.useQuery",
      "deactivation.fileAppeal.useMutation",
      "deactivation.listCases.useQuery",
      "deactivation.reviewAppeal.useMutation",
      "riderVerification.getOfferRiderBadge.useQuery",
      "riderVerification.getMyVerificationStatus.useQuery",
      "riderVerification.submitVerification.useMutation",
    ]) {
      expect(bridge).toContain(procedure);
    }
    for (const type of [
      "ConsultationObject",
      "DeactivationCase",
      "RiderBadge",
      "VerificationStatus",
    ]) {
      expect(bridge).toContain(`export interface ${type}`);
    }
    for (const page of [
      "client/src/pages/WorkerCouncil.tsx",
      "client/src/pages/DeactivationAppeals.tsx",
      "client/src/components/VerifiedRiderBadge.tsx",
    ]) {
      const pageSource = source(page);
      expect(pageSource).toContain("@/lib/trpcTrust");
      expect(pageSource).not.toContain("@/lib/trpc\"");
      expect(pageSource).not.toMatch(/\bas any\b/);
    }
  });

  it("council console renders SLA, tally, and response composer affordances", () => {
    const council = source("client/src/pages/WorkerCouncil.tsx");
    expect(council).toContain("useConsultations");
    expect(council).toContain("useRespondToConsultation");
    expect(council).toContain("Response SLA");
    expect(council).toContain("Activated");
    expect(council).toContain('"support"');
    expect(council).toContain('"object"');
    expect(council).toContain('"comment"');
  });

  it("appeals page supports the 14-day timeline, self-serve appeal, and backpay decision", () => {
    const appeals = source("client/src/pages/DeactivationAppeals.tsx");
    expect(appeals).toContain("useMyDeactivationCase");
    expect(appeals).toContain("useFileAppeal");
    expect(appeals).toContain("useDeactivationCases");
    expect(appeals).toContain("useReviewAppeal");
    expect(appeals).toContain("14-day notice");
    expect(appeals).toContain('"reinstated_with_backpay"');
    expect(appeals).toContain("useSessionProfile");
  });

  it("verified rider badge renders verified and unverified states on offer cards", () => {
    const badge = source("client/src/components/VerifiedRiderBadge.tsx");
    expect(badge).toContain("useOfferRiderBadge");
    expect(badge).toContain("Verified rider");
    expect(badge).toContain("Unverified rider");
    const offers = source("client/src/pages/DriverOfferFairness.tsx");
    expect(offers).toContain(
      'import VerifiedRiderBadge from "@/components/VerifiedRiderBadge"',
    );
    expect(offers).toContain("<VerifiedRiderBadge offerId={offer.offerId} />");
  });
});
