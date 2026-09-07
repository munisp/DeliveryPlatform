import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

type PartnerCredential = {
  id: string;
  display_name: string;
  client_state: string;
  allowed_scopes: string[];
  created_at: string;
  credential_id: string | null;
  credential_prefix: string | null;
  scopes: string[] | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
};

type CreatedClient = { client: { id: string; display_name: string }; credential: { id: string; credential_prefix: string; expires_at: string | null }; apiKey: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", cache: "no-store", headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "request_failed" }));
    throw new Error(body.error ?? "request_failed");
  }
  return response.json() as Promise<T>;
}

const availableScopes = ["operations.jobs.read", "operations.jobs.write", "operations.tracking.write", "operations.events.write"];

export default function PartnerIntegrations() {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<string[]>(["operations.jobs.read"]);
  const [expiresAt, setExpiresAt] = useState("");
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const clients = useQuery({ queryKey: ["partner-clients"], queryFn: () => api<PartnerCredential[]>("/api/integrations/clients") });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["partner-clients"] });
  const issue = useMutation({
    mutationFn: () => api<CreatedClient>("/api/integrations/clients", { method: "POST", body: JSON.stringify({ displayName, scopes: selectedScopes, ...(expiresAt ? { expiresAt } : {}) }) }),
    onSuccess: (result) => { setIssuedKey(result.apiKey); setDisplayName(""); setExpiresAt(""); setMessage(`Credential ${result.credential.credential_prefix} was issued for ${result.client.display_name}.`); refresh(); },
    onError: (error) => setMessage(error instanceof Error ? error.message : "credential_issue_failed"),
  });
  const revoke = useMutation({
    mutationFn: (credentialId: string) => api<{ id: string }>(`/api/integrations/credentials/${credentialId}/revoke`, { method: "POST" }),
    onSuccess: () => { setMessage("Credential revoked."); refresh(); },
    onError: (error) => setMessage(error instanceof Error ? error.message : "credential_revoke_failed"),
  });
  const toggleScope = (scope: string) => setSelectedScopes((current) => current.includes(scope) ? current.filter((entry) => entry !== scope) : [...current, scope]);

  return <DashboardLayout><div className="space-y-6">
    <div><div className="text-xs font-medium uppercase tracking-[0.22em] text-cyan-300">Partner API control plane</div><h1 className="mt-2 text-3xl font-semibold text-white">Scoped credentials and signed inbound events</h1><p className="mt-2 max-w-3xl text-slate-400">Issue narrowly scoped tenant credentials, rotate or revoke them, and accept only raw-body HMAC-signed, replay-protected partner events. Secrets are stored as salted derivations and never displayed again after issuance.</p></div>
    {message ? <div className="rounded-xl border border-cyan-400/30 bg-cyan-950/30 px-4 py-3 text-sm text-cyan-100">{message}</div> : null}
    {issuedKey ? <Card className="border-amber-400/50 bg-amber-950/20"><CardHeader><CardTitle className="text-amber-100">Copy the credential now</CardTitle><CardDescription className="text-amber-100/80">This is the only display of this value. Store it in the partner’s approved secret manager, then dismiss this notice; the server retains only a salted digest.</CardDescription></CardHeader><CardContent className="space-y-3"><code className="block break-all rounded-lg border border-amber-300/20 bg-slate-950 p-3 text-xs text-amber-100">{issuedKey}</code><button type="button" onClick={() => setIssuedKey(null)} className="rounded-lg border border-amber-300/30 px-4 py-2 text-sm text-amber-100">I stored the credential</button></CardContent></Card> : null}
    <div className="grid gap-4 xl:grid-cols-2">
      <Card><CardHeader><CardTitle>Register a partner client</CardTitle><CardDescription>Only platform integration administrators can create credentials. Every client is tenant-scoped and each request is later checked against its individual scopes.</CardDescription></CardHeader><CardContent className="space-y-3"><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Partner display name" aria-label="Partner display name" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} aria-label="Credential expiry" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><div className="space-y-2">{availableScopes.map((scope) => <label key={scope} className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={selectedScopes.includes(scope)} onChange={() => toggleScope(scope)} />{scope}</label>)}</div><button type="button" disabled={issue.isPending || !displayName.trim() || !selectedScopes.length} onClick={() => issue.mutate()} className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-50">Issue credential</button></CardContent></Card>
      <Card><CardHeader><CardTitle>Inbound event contract</CardTitle><CardDescription>Send `POST /api/partner/events` with the credential and immutable event metadata in HTTP headers. The handler verifies the exact raw JSON bytes before storing an idempotent event.</CardDescription></CardHeader><CardContent className="space-y-2 text-sm text-slate-300"><code className="block rounded bg-slate-950 p-2 text-xs text-cyan-100">x-operations-api-key: ops_…</code><code className="block rounded bg-slate-950 p-2 text-xs text-cyan-100">x-operations-event-type: operations.tracking.position</code><code className="block rounded bg-slate-950 p-2 text-xs text-cyan-100">x-operations-event-id: partner-immutable-id</code><code className="block rounded bg-slate-950 p-2 text-xs text-cyan-100">x-operations-signature: hmac-sha256=…</code><p className="pt-2 text-xs text-slate-400">Accepted events are deduplicated per partner client and external event identifier. A request cannot gain authority from a Redis cache or UI state.</p></CardContent></Card>
    </div>
    <Card><CardHeader><CardTitle>Active and historical credentials</CardTitle><CardDescription>Revocation takes effect immediately. The full API secret is not retained in this workspace or response history.</CardDescription></CardHeader><CardContent><div className="space-y-3">{clients.isLoading ? <p className="text-sm text-slate-400">Loading durable partner client data…</p> : clients.data?.length ? clients.data.map((client) => <div key={`${client.id}:${client.credential_id ?? "none"}`} className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4 lg:flex-row lg:items-center lg:justify-between"><div><div className="font-medium text-white">{client.display_name}</div><div className="mt-1 text-xs text-slate-400">{client.credential_prefix ?? "No credential"} · {client.client_state} · scopes: {(client.scopes ?? client.allowed_scopes).join(", ")}</div><div className="mt-1 text-xs text-slate-500">{client.revoked_at ? `Revoked ${new Date(client.revoked_at).toLocaleString()}` : client.expires_at ? `Expires ${new Date(client.expires_at).toLocaleString()}` : "No expiry configured"}</div></div>{client.credential_id && !client.revoked_at ? <button type="button" disabled={revoke.isPending} onClick={() => revoke.mutate(client.credential_id!)} className="rounded-lg border border-rose-400/30 px-3 py-2 text-xs text-rose-100 disabled:opacity-50">Revoke</button> : null}</div>) : <p className="text-sm text-slate-400">No durable partner credentials exist for this tenant.</p>}</div></CardContent></Card>
  </div></DashboardLayout>;
}
