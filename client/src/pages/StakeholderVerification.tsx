import { useState, type FormEvent } from "react";
import { Link } from "wouter";
import {
  FileCheck2,
  Fingerprint,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

function key(prefix: string) {
  return `${prefix}-${Date.now()}-verification`;
}

export default function StakeholderVerification() {
  const [form, setForm] = useState({
    subjectType: "driver" as const,
    subjectKey: "",
    jurisdiction: "NG-LA",
    purpose: "gig_worker_onboarding",
  });
  const cases = trpc.stakeholderVerification.listCases.useQuery();
  const start = trpc.stakeholderVerification.startCase.useMutation({
    onSuccess: () => cases.refetch(),
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    start.mutate({ ...form, idempotencyKey: key("verification-case") });
  };
  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="flex flex-col justify-between gap-4 border-b border-slate-800 pb-6 lg:flex-row lg:items-end">
          <div className="space-y-2">
            <p className="text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
              Consented verification operations
            </p>
            <h1 className="text-3xl font-semibold tracking-tight text-slate-50">
              Evidence, screening, and accountable review
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-slate-400">
              Document processors and liveness checks create review evidence
              only. An authorized human decision is required after all
              jurisdiction-appropriate checks are recorded.
            </p>
          </div>
          <Link
            href="/dashboard"
            className="text-sm font-medium text-cyan-300 underline-offset-4 hover:underline"
          >
            Return to dashboard
          </Link>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader>
              <Fingerprint className="h-5 w-5 text-cyan-300" />
              <CardTitle>Consent first</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-slate-400">
              Evidence is rejected until a current purpose-bound consent receipt
              is stored.
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <FileCheck2 className="h-5 w-5 text-cyan-300" />
              <CardTitle>Hash-bound evidence</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-slate-400">
              The client submits object metadata and SHA-256; the processor
              independently confirms the supplied bytes match.
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <ShieldAlert className="h-5 w-5 text-amber-300" />
              <CardTitle>Manual review required</CardTitle>
            </CardHeader>
            <CardContent className="text-sm text-slate-400">
              OCR, document models, and liveness artifacts cannot alone approve
              or reject a stakeholder.
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Start a verification case</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="grid gap-3 md:grid-cols-2">
              <select
                value={form.subjectType}
                onChange={(event) =>
                  setForm({
                    ...form,
                    subjectType: event.target.value as typeof form.subjectType,
                  })
                }
                className="rounded border border-slate-700 bg-slate-900 p-2"
              >
                <option value="driver">Driver</option>
                <option value="field_technician">Field technician</option>
                <option value="merchant">Merchant</option>
                <option value="fleet_provider">Fleet provider</option>
                <option value="operator">Operator</option>
              </select>
              <input
                required
                value={form.subjectKey}
                onChange={(event) =>
                  setForm({ ...form, subjectKey: event.target.value })
                }
                placeholder="Subject reference"
                className="rounded border border-slate-700 bg-slate-900 p-2"
              />
              <input
                required
                value={form.jurisdiction}
                onChange={(event) =>
                  setForm({
                    ...form,
                    jurisdiction: event.target.value.toUpperCase(),
                  })
                }
                className="rounded border border-slate-700 bg-slate-900 p-2"
              />
              <input
                required
                value={form.purpose}
                onChange={(event) =>
                  setForm({ ...form, purpose: event.target.value })
                }
                className="rounded border border-slate-700 bg-slate-900 p-2"
              />
              <button
                className="rounded bg-cyan-400 px-4 py-2 font-medium text-slate-950 disabled:opacity-50"
                disabled={start.isPending}
              >
                Create consented case
              </button>
            </form>
            {start.error && (
              <p className="pt-3 text-sm text-red-300">{start.error.message}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>My verification cases</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {(cases.data ?? []).map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between border-b border-slate-800 py-3 text-sm"
                >
                  <div>
                    <p className="font-medium text-slate-100">
                      {item.subjectType} · {item.subjectKey}
                    </p>
                    <p className="text-slate-400">
                      {item.jurisdiction} · {item.purpose}
                    </p>
                  </div>
                  <span className="inline-flex items-center gap-1 text-cyan-200">
                    <ShieldCheck className="h-4 w-4" />
                    {item.state}
                  </span>
                </div>
              ))}
              {!cases.isLoading && !cases.data?.length && (
                <p className="text-sm text-slate-400">
                  No verification cases are visible to this account.
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
