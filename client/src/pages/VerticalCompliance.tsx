import { useMemo, useState } from "react";
import {
  FileCheck,
  PackagePlus,
  ShieldCheck,
  Thermometer,
  X,
} from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { QueryErrorState } from "@/components/QueryState";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

/**
 * VerticalCompliance (P4-C, WS-COMPLIANCE): existing summary view preserved;
 * adds a per-pack detail view (descriptors, requirements, jurisdiction) and a
 * gap-closure panel that surfaces uncovered_verticals with an operator
 * "seed defaults" action calling compliancePacks.seedDefaultCompliancePacks.
 */

// Idempotency keys must match IDEMPOTENCY_KEY_REGEX
// (/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/) — merchantSelfServe.ts:68.
function generateSeedKey(): string {
  const suffix =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}`;
  return `seed-defaults-${suffix}`;
}

type SummaryData = ReturnType<typeof useSummaryData>["data"];

function useSummaryData() {
  return trpc.compliancePacks.summary.useQuery();
}

type PackRow = NonNullable<SummaryData>["packs"][number];

function PackDetailView({
  pack,
  onClose,
}: {
  pack: PackRow;
  onClose: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="capitalize">
              {pack.vertical_name ?? pack.vertical_slug} — pack detail
            </CardTitle>
            <CardDescription>{pack.jurisdiction}</CardDescription>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-800 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-600 hover:text-white"
          >
            <X className="h-3.5 w-3.5" />
            Close
          </button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <dl className="grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
            <dt className="text-xs text-slate-400">Vertical slug</dt>
            <dd className="mt-1 font-medium text-white">{pack.vertical_slug}</dd>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
            <dt className="text-xs text-slate-400">Status</dt>
            <dd className="mt-1 font-medium text-white">
              {pack.active ? "Active" : "Inactive"}
            </dd>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
            <dt className="text-xs text-slate-400">Linked vertical id</dt>
            <dd className="mt-1 font-medium text-white">
              {pack.vertical_id ?? "unlinked"}
            </dd>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
            <dt className="text-xs text-slate-400">Last updated</dt>
            <dd className="mt-1 font-medium text-white">
              {new Date(pack.updated_at).toLocaleString()}
            </dd>
          </div>
        </dl>

        {pack.age_restriction ? (
          <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
            <p className="text-sm font-medium text-white">
              Age restriction: {pack.age_restriction.minimum_age}+ (
              {pack.age_restriction.scope})
            </p>
            <p className="mt-1 text-xs leading-5 text-slate-400">
              Verification: {pack.age_restriction.verification} —{" "}
              {pack.age_restriction.jurisdictional_basis}
            </p>
          </div>
        ) : (
          <p className="text-sm text-slate-400">
            No age restriction on this pack.
          </p>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-white">
            <FileCheck className="h-4 w-4 text-slate-400" />
            Required documents ({pack.required_documents.length})
          </div>
          <ul className="space-y-2 text-sm leading-6 text-slate-300">
            {pack.required_documents.map((doc) => (
              <li
                key={doc.code}
                className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3"
              >
                <p className="font-medium text-white">{doc.label}</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  Code: {doc.code} · Issuer: {doc.issuer} · Verification:{" "}
                  {doc.verification} · Renewal: {doc.renewal} · Retention:{" "}
                  {doc.retention_days} days
                </p>
              </li>
            ))}
            {pack.required_documents.length === 0 ? (
              <li className="text-sm text-slate-400">
                No required-document descriptors.
              </li>
            ) : null}
          </ul>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-white">
            <Thermometer className="h-4 w-4 text-slate-400" />
            Handling requirements ({pack.handling_requirements.length})
          </div>
          <ul className="space-y-2 text-sm leading-6 text-slate-300">
            {pack.handling_requirements.map((rule) => (
              <li
                key={rule.code}
                className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3"
              >
                <p className="font-medium text-white">{rule.label}</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  Code: {rule.code} · Enforcement: {rule.enforcement} ·
                  Parameters:{" "}
                  {Object.entries(rule.parameters)
                    .map(([key, value]) => `${key}=${String(value)}`)
                    .join(", ") || "none"}
                </p>
              </li>
            ))}
            {pack.handling_requirements.length === 0 ? (
              <li className="text-sm text-slate-400">
                No handling-requirement descriptors.
              </li>
            ) : null}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

export default function VerticalCompliance() {
  const query = useSummaryData();
  const data = query.data;
  const utils = trpc.useUtils();
  const [selectedPackId, setSelectedPackId] = useState<number | null>(null);
  const [seedMessage, setSeedMessage] = useState<string | null>(null);

  const seedDefaults = trpc.compliancePacks.seedDefaultCompliancePacks.useMutation({
    onSuccess: async (result) => {
      setSeedMessage(
        result.replayed
          ? "Seed request replayed from the idempotency ledger; no packs changed."
          : `Seeded ${result.packsTouched} default packs (${result.inserted} new, ${result.updated} refreshed) for ${result.verticals.join(", ")}.`,
      );
      await utils.compliancePacks.summary.invalidate();
    },
    onError: (error) => {
      setSeedMessage(null);
      void error;
    },
  });

  const selectedPack = useMemo(
    () => data?.packs.find((pack) => pack.id === selectedPackId) ?? null,
    [data, selectedPackId],
  );

  if (query.isError) {
    return (
      <DashboardLayout>
        <div className="space-y-6">
          <QueryErrorState
            resource="compliance pack data"
            message={query.error.message}
            onRetry={() => void query.refetch()}
            retrying={query.isRefetching}
          />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="space-y-3">
          <Badge variant="secondary">Vertical compliance</Badge>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">
              Vertical Compliance Packs
            </h1>
            <p className="mt-2 max-w-3xl text-slate-400">
              Machine-readable regulatory requirement packs per service vertical
              and jurisdiction. Onboarding, dispatch, and delivery flows enforce
              these descriptors programmatically.
            </p>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          <Card>
            <CardHeader>
              <CardDescription>Active Packs</CardDescription>
              <CardTitle className="text-3xl">
                {data?.summary.active_packs ?? 0}
              </CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Covered Verticals</CardDescription>
              <CardTitle className="text-3xl">
                {data?.summary.covered_verticals ?? 0}
              </CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Age-Restricted</CardDescription>
              <CardTitle className="text-3xl">
                {data?.summary.age_restricted_packs ?? 0}
              </CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Document Rules</CardDescription>
              <CardTitle className="text-3xl">
                {data?.summary.required_document_rules ?? 0}
              </CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Handling Rules</CardDescription>
              <CardTitle className="text-3xl">
                {data?.summary.handling_rules ?? 0}
              </CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader>
              <CardDescription>Uncovered Verticals</CardDescription>
              <CardTitle className="text-3xl">
                {data?.uncovered_verticals.length ?? 0}
              </CardTitle>
            </CardHeader>
          </Card>
        </div>

        {!query.isLoading && (data?.packs.length ?? 0) === 0 ? (
          <Card>
            <CardContent className="py-6">
              <p className="font-medium text-white">
                No compliance packs are configured yet.
              </p>
              <p className="mt-1 text-sm text-slate-400">
                Apply migration 0076_vertical_compliance_packs.sql to provision
                the baseline packs for pharmacy, alcohol, healthcare, and
                grocery, then add jurisdiction-specific packs as new regions go
                live.
              </p>
            </CardContent>
          </Card>
        ) : null}

        {selectedPack ? (
          <PackDetailView
            pack={selectedPack}
            onClose={() => setSelectedPackId(null)}
          />
        ) : null}

        <div className="grid gap-4 xl:grid-cols-2">
          {(data?.packs ?? []).map((pack) => (
            <Card key={pack.id}>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle className="capitalize">
                    {pack.vertical_name ?? pack.vertical_slug}
                  </CardTitle>
                  <Badge variant={pack.active ? "secondary" : "outline"}>
                    {pack.active ? "Active" : "Inactive"}
                  </Badge>
                </div>
                <CardDescription>{pack.jurisdiction}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {pack.age_restriction ? (
                  <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3">
                    <p className="text-sm font-medium text-white">
                      Age restriction: {pack.age_restriction.minimum_age}+ (
                      {pack.age_restriction.scope})
                    </p>
                    <p className="mt-1 text-xs leading-5 text-slate-400">
                      Verification: {pack.age_restriction.verification} —{" "}
                      {pack.age_restriction.jurisdictional_basis}
                    </p>
                  </div>
                ) : null}

                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-white">
                    <FileCheck className="h-4 w-4 text-slate-400" />
                    Required documents ({pack.required_documents.length})
                  </div>
                  <ul className="space-y-2 text-sm leading-6 text-slate-300">
                    {pack.required_documents.map((doc) => (
                      <li
                        key={doc.code}
                        className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3"
                      >
                        <p className="font-medium text-white">{doc.label}</p>
                        <p className="mt-1 text-xs leading-5 text-slate-400">
                          Issuer: {doc.issuer} · Verification:{" "}
                          {doc.verification} · Renewal: {doc.renewal} ·
                          Retention: {doc.retention_days} days
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm font-medium text-white">
                    <Thermometer className="h-4 w-4 text-slate-400" />
                    Handling requirements ({pack.handling_requirements.length})
                  </div>
                  <ul className="space-y-2 text-sm leading-6 text-slate-300">
                    {pack.handling_requirements.map((rule) => (
                      <li
                        key={rule.code}
                        className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3"
                      >
                        <p className="font-medium text-white">{rule.label}</p>
                        <p className="mt-1 text-xs leading-5 text-slate-400">
                          Enforcement: {rule.enforcement} · Parameters:{" "}
                          {Object.entries(rule.parameters)
                            .map(([key, value]) => `${key}=${String(value)}`)
                            .join(", ")}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>

                <div>
                  <button
                    type="button"
                    onClick={() =>
                      setSelectedPackId((current) =>
                        current === pack.id ? null : pack.id,
                      )
                    }
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-800 px-3 py-1.5 text-xs text-slate-300 transition hover:border-slate-600 hover:text-white"
                  >
                    {selectedPackId === pack.id
                      ? "Hide pack detail"
                      : "View pack detail"}
                  </button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {(data?.uncovered_verticals.length ?? 0) > 0 ? (
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-slate-400" />
                <CardTitle>Verticals without a compliance pack</CardTitle>
              </div>
              <CardDescription>
                Active service verticals that have no active compliance pack.
                Onboarding for these verticals currently runs without codified
                regulatory requirements.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-2 text-sm leading-6 text-slate-300">
                {data?.uncovered_verticals.map((vertical) => (
                  <li
                    key={vertical.id}
                    className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-3"
                  >
                    {vertical.name}{" "}
                    <span className="text-slate-500">({vertical.slug})</span>
                  </li>
                ))}
              </ul>

              <div className="rounded-xl border border-slate-800 bg-slate-950/70 px-4 py-4">
                <div className="flex items-center gap-2">
                  <PackagePlus className="h-4 w-4 text-slate-400" />
                  <p className="text-sm font-medium text-white">
                    Close the default coverage gap
                  </p>
                </div>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  Seed the default freight, business-travel, and courier packs
                  (Nigeria-first: NG federal baseline + Lagos State NG-LA
                  overlay per vertical). The operation is idempotent — running
                  it again refreshes the same packs without creating
                  duplicates.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <button
                    type="button"
                    disabled={seedDefaults.isPending}
                    onClick={() =>
                      seedDefaults.mutate({ idempotencyKey: generateSeedKey() })
                    }
                    className="inline-flex items-center gap-2 rounded-lg bg-emerald-500/90 px-4 py-2 text-xs font-medium text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <PackagePlus className="h-3.5 w-3.5" />
                    {seedDefaults.isPending
                      ? "Seeding default packs…"
                      : "Seed default packs"}
                  </button>
                  {seedMessage ? (
                    <p className="text-xs text-emerald-300">{seedMessage}</p>
                  ) : null}
                  {seedDefaults.isError ? (
                    <p className="text-xs text-rose-300">
                      {seedDefaults.error.message}
                    </p>
                  ) : null}
                </div>
              </div>
            </CardContent>
          </Card>
        ) : null}
      </div>
    </DashboardLayout>
  );
}
