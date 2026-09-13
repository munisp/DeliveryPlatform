import { CircleAlert, FileCheck, ShieldCheck, Thermometer } from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

export default function VerticalCompliance() {
  const query = trpc.compliancePacks.summary.useQuery();
  const data = query.data;

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

        {query.error ? (
          <Card>
            <CardContent className="flex items-start gap-3 py-6">
              <CircleAlert className="mt-0.5 h-5 w-5 text-amber-400" />
              <div>
                <p className="font-medium text-white">
                  Compliance pack data is unavailable
                </p>
                <p className="mt-1 text-sm text-slate-400">
                  {query.error.message}
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

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

        {!query.isLoading && !query.error && (data?.packs.length ?? 0) === 0 ? (
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
            <CardContent>
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
            </CardContent>
          </Card>
        ) : null}
      </div>
    </DashboardLayout>
  );
}
