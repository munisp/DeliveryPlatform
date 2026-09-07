import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type EvidenceResult = { evidence_id: string; state: string; outcome?: string; affected_driver_count?: number };
type Eligibility = { driver_user_id: number; eligible: boolean; eligible_until: string | null; exclusion_code: string | null; presence_state: string; version: number };
type EvidenceSubmission = { subject_kind: "driver" | "vehicle" | "operator"; subject_key: string; evidence_type: string; external_reference: string; verifier: string; document_object_key?: string; issued_at?: string; expires_at?: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", cache: "no-store", headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init });
  const body = await response.json().catch(() => ({ error: "compliance_request_failed" }));
  if (!response.ok) throw new Error(body.error ?? body.detail ?? "compliance_request_failed");
  return body as T;
}

export default function ComplianceReview() {
  const [message, setMessage] = useState<string | null>(null);
  const [evidenceId, setEvidenceId] = useState("");
  const [driverId, setDriverId] = useState("");
  const [reason, setReason] = useState("Evidence reviewed against Lagos private-beta control policy.");
  const [subjectKind, setSubjectKind] = useState<EvidenceSubmission["subject_kind"]>("driver");
  const [subjectKey, setSubjectKey] = useState("");
  const [evidenceType, setEvidenceType] = useState("national_driver_license");
  const [externalReference, setExternalReference] = useState("");
  const [verifier, setVerifier] = useState("approved-lagos-verifier");
  const [documentObjectKey, setDocumentObjectKey] = useState("");
  const [issuedAt, setIssuedAt] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const submit = useMutation({
    mutationFn: () => {
      if (!subjectKey.trim() || !evidenceType.trim() || !externalReference.trim() || !verifier.trim()) throw new Error("subject, evidence, provider reference, and verifier are required");
      return api<EvidenceResult>("/api/compliance/evidence", { method: "POST", body: JSON.stringify({ subject_kind: subjectKind, subject_key: subjectKey.trim(), evidence_type: evidenceType.trim(), external_reference: externalReference.trim(), verifier: verifier.trim(), document_object_key: documentObjectKey.trim() || undefined, issued_at: issuedAt || undefined, expires_at: expiresAt || undefined } satisfies EvidenceSubmission) });
    },
    onSuccess: (result) => { setEvidenceId(result.evidence_id); setMessage(`Evidence intake recorded as ${result.state}. Review the provider result, then record the required human decision.`); },
    onError: (error) => setMessage(error instanceof Error ? error.message : "evidence_submission_failed"),
  });
  const verify = useMutation({
    mutationFn: () => api<EvidenceResult>(`/api/compliance/evidence/${encodeURIComponent(evidenceId.trim())}/verify`, { method: "POST" }),
    onSuccess: (result) => setMessage(`Verification completed: ${result.state}${result.outcome ? ` (${result.outcome})` : ""}.`),
    onError: (error) => setMessage(error instanceof Error ? error.message : "verification_failed"),
  });
  const decide = useMutation({
    mutationFn: (approved: boolean) => api<EvidenceResult>(`/api/compliance/evidence/${encodeURIComponent(evidenceId.trim())}/approve`, { method: "POST", body: JSON.stringify({ approved, reason }) }),
    onSuccess: (result) => setMessage(`Human decision recorded: ${result.state}; affected drivers: ${result.affected_driver_count ?? 0}.`),
    onError: (error) => setMessage(error instanceof Error ? error.message : "approval_failed"),
  });
  const loadEligibility = useMutation({
    mutationFn: async () => {
      const id = Number(driverId);
      if (!Number.isInteger(id) || id < 1) throw new Error("driver_id_must_be_positive");
      const response = await fetch(`/api/compliance/drivers/${id}/eligibility`, { credentials: "include", cache: "no-store" });
      const body = await response.json().catch(() => ({ error: "eligibility_request_failed" }));
      if (!response.ok) throw new Error(body.error ?? body.detail ?? "eligibility_request_failed");
      return body as Eligibility;
    },
    onSuccess: (result) => { setEligibility(result); setMessage("Current durable driver eligibility loaded."); },
    onError: (error) => setMessage(error instanceof Error ? error.message : "eligibility_load_failed"),
  });
  const reconcile = useMutation({
    mutationFn: () => api<{ expired_evidence: number; reconciled_drivers: number }>("/api/compliance/reconcile-expiry", { method: "POST" }),
    onSuccess: (result) => setMessage(`Expiry reconciliation completed: ${result.expired_evidence} evidence records expired; ${result.reconciled_drivers} drivers reconciled.`),
    onError: (error) => setMessage(error instanceof Error ? error.message : "expiry_reconciliation_failed"),
  });

  const pending = submit.isPending || verify.isPending || decide.isPending || loadEligibility.isPending || reconcile.isPending;
  return <DashboardLayout><div className="space-y-6">
    <div><div className="text-xs font-medium uppercase tracking-[0.22em] text-amber-300">Lagos private beta control room</div><h1 className="mt-2 text-3xl font-semibold text-white">Driver and vehicle compliance review</h1><p className="mt-2 max-w-3xl text-slate-400">Review provider-verified evidence, apply documented human decisions where the control policy requires them, and inspect the durable dispatch-eligibility projection. This interface never stores raw identity documents or provider credentials in the browser.</p></div>
    {message ? <div className="rounded-xl border border-amber-400/30 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">{message}</div> : null}
    <Card><CardHeader><CardTitle>Evidence intake</CardTitle><CardDescription>Record a restricted object-store reference and provider reference, never raw documents or credentials. Evidence remains pending until server-side verification and any mandatory human decision complete.</CardDescription></CardHeader><CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"><select value={subjectKind} onChange={(event) => setSubjectKind(event.target.value as EvidenceSubmission["subject_kind"])} aria-label="Evidence subject kind" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"><option value="driver">Driver</option><option value="vehicle">Vehicle</option><option value="operator">Operator</option></select><input value={subjectKey} onChange={(event) => setSubjectKey(event.target.value)} placeholder="Subject key: driver ID, vehicle UUID, or operator key" aria-label="Evidence subject key" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><input value={evidenceType} onChange={(event) => setEvidenceType(event.target.value)} placeholder="Evidence type" aria-label="Evidence type" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><input value={externalReference} onChange={(event) => setExternalReference(event.target.value)} placeholder="Provider reference" aria-label="Provider reference" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><input value={verifier} onChange={(event) => setVerifier(event.target.value)} placeholder="Approved verifier" aria-label="Verifier name" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><input value={documentObjectKey} onChange={(event) => setDocumentObjectKey(event.target.value)} placeholder="Restricted object-store key (optional)" aria-label="Document object key" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><input value={issuedAt} onChange={(event) => setIssuedAt(event.target.value)} placeholder="Issued timestamp ISO-8601 (optional)" aria-label="Issued timestamp" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><input value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} placeholder="Expiry timestamp ISO-8601 (optional)" aria-label="Expiry timestamp" className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><div className="flex items-center"><button type="button" disabled={pending} onClick={() => submit.mutate()} className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-50">Record evidence</button></div></CardContent></Card>
    <div className="grid gap-4 xl:grid-cols-2"><Card><CardHeader><CardTitle>Evidence decision</CardTitle><CardDescription>Verification calls the configured server-side verifier. Human approval remains mandatory for high-impact evidence such as screening, inspection, insurance, and operator permit controls.</CardDescription></CardHeader><CardContent className="space-y-3"><input value={evidenceId} onChange={(event) => setEvidenceId(event.target.value)} placeholder="Evidence UUID" aria-label="Evidence UUID" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><textarea value={reason} onChange={(event) => setReason(event.target.value)} aria-label="Review decision reason" className="min-h-24 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><div className="flex flex-wrap gap-2"><button type="button" disabled={pending || !evidenceId.trim()} onClick={() => verify.mutate()} className="rounded-lg border border-cyan-400/30 px-4 py-2 text-sm text-cyan-100 disabled:opacity-50">Verify with provider</button><button type="button" disabled={pending || !evidenceId.trim() || !reason.trim()} onClick={() => decide.mutate(true)} className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-50">Approve</button><button type="button" disabled={pending || !evidenceId.trim() || !reason.trim()} onClick={() => decide.mutate(false)} className="rounded-lg bg-rose-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Reject</button></div></CardContent></Card><Card><CardHeader><CardTitle>Dispatch eligibility</CardTitle><CardDescription>Eligibility derives from valid, verified evidence and is recalculated after decisions and expiry. Approval does not itself grant regulatory or insurance authorization.</CardDescription></CardHeader><CardContent className="space-y-3"><input value={driverId} onChange={(event) => setDriverId(event.target.value)} inputMode="numeric" placeholder="Driver user ID" aria-label="Driver user ID" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><div className="flex flex-wrap gap-2"><button type="button" disabled={pending || !driverId.trim()} onClick={() => loadEligibility.mutate()} className="rounded-lg border border-cyan-400/30 px-4 py-2 text-sm text-cyan-100 disabled:opacity-50">Load eligibility</button><button type="button" disabled={pending} onClick={() => reconcile.mutate()} className="rounded-lg border border-amber-400/30 px-4 py-2 text-sm text-amber-100 disabled:opacity-50">Run expiry reconciliation</button></div>{eligibility ? <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300"><div className="font-medium text-white">Driver {eligibility.driver_user_id}: {eligibility.eligible ? "eligible" : "not eligible"}</div><div className="mt-2 grid gap-1 text-xs text-slate-400"><span>Presence state: {eligibility.presence_state}</span><span>Eligible until: {eligibility.eligible_until ? new Date(eligibility.eligible_until).toLocaleString() : "not set"}</span><span>Exclusion: {eligibility.exclusion_code ?? "none"}</span><span>Projection version: {eligibility.version}</span></div></div> : null}</CardContent></Card></div>
  </div></DashboardLayout>;
}
