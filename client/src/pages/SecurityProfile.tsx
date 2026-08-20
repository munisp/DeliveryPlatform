import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";

import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type SecuritySession = {
  id: string;
  auth_source: string;
  mfa_authenticated: boolean;
  assurance_level: string | null;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
};

type SecurityProfile = {
  mfa: {
    requiredForPrivilegedActions: boolean;
    authenticatedForCurrentSession: boolean;
    assuranceLevel: string | null;
    setupUrl: string | null;
  };
  currentSessionId: string | null;
  sessions: SecuritySession[];
};

type Feedback = { tone: "success" | "warning" | "danger"; title: string; message: string } | null;

function isFeedback(value: unknown): value is Exclude<Feedback, null> {
  return Boolean(value) && typeof value === "object" && "tone" in value && "title" in value && "message" in value;
}

function securityFeedback(status: number, code: string): Feedback {
  if (status === 429 || code === "rate_limit_exceeded") {
    return { tone: "warning", title: "Too many requests", message: "For your protection, this action is temporarily paused. Please wait for the stated retry window, then try again." };
  }
  if (code.includes("mfa_required")) {
    return { tone: "warning", title: "MFA verification required", message: "This action needs a fresh multi-factor verification. Complete MFA in your identity provider, then return here." };
  }
  if (status === 401 || status === 403 || code.includes("policy") || code.includes("forbidden")) {
    return { tone: "danger", title: "Action blocked by security policy", message: "Your current access or session assurance does not permit this action. Review your security settings or contact a tenant administrator." };
  }
  return { tone: "danger", title: "Security action unavailable", message: "The request could not be completed safely. Your session remains unchanged; please try again later." };
}

async function getSecurityProfile(): Promise<SecurityProfile> {
  const response = await fetch("/api/auth/security", { credentials: "include", cache: "no-store" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw securityFeedback(response.status, String(payload?.error ?? "security_profile_unavailable"));
  return payload as SecurityProfile;
}

export function SecurityBlockedPage() {
  const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const feedback = securityFeedback(Number(params.get("status") ?? "403"), params.get("code") ?? "policy_denied")!;
  return (
    <DashboardLayout>
      <Card className="mx-auto max-w-2xl border-amber-400/30 bg-amber-500/5">
        <CardHeader>
          <CardTitle>{feedback.title}</CardTitle>
          <CardDescription>{feedback.message}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Link href="/profile/security" className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950">Review security settings</Link>
          <Link href="/dashboard" className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-100">Return to dashboard</Link>
        </CardContent>
      </Card>
    </DashboardLayout>
  );
}

export default function SecurityProfilePage() {
  const queryClient = useQueryClient();
  const profile = useQuery({ queryKey: ["security-profile"], queryFn: getSecurityProfile, staleTime: 15_000 });
  const revokeSession = useMutation({
    mutationFn: async (sessionId: string) => {
      const response = await fetch(`/api/auth/security/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", credentials: "include" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw securityFeedback(response.status, String(payload?.error ?? "security_session_revoke_failed"));
      return payload as { currentSessionRevoked: boolean };
    },
    onSuccess: (result) => {
      if (result.currentSessionRevoked) window.location.assign("/portal?error=session_revoked");
      queryClient.invalidateQueries({ queryKey: ["security-profile"] });
    },
  });

  const error = profile.error ?? revokeSession.error;
  const feedback = isFeedback(error) ? error : null;
  const security = profile.data;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl space-y-6">
        <div>
          <p className="text-sm uppercase tracking-[0.24em] text-cyan-300">Profile</p>
          <h1 className="mt-2 text-3xl font-semibold text-white">Security settings</h1>
          <p className="mt-2 max-w-3xl text-slate-400">Review the assurance level of this session, manage authenticators through your identity provider, and remove active sessions you no longer recognize.</p>
        </div>

        {feedback ? <div role="alert" className={`rounded-xl border p-4 text-sm ${feedback.tone === "success" ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100" : feedback.tone === "warning" ? "border-amber-400/30 bg-amber-500/10 text-amber-100" : "border-rose-400/30 bg-rose-500/10 text-rose-100"}`}><strong>{feedback.title}.</strong> {feedback.message}</div> : null}
        {revokeSession.isSuccess ? <div role="status" className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">Session removed successfully.</div> : null}

        <Card>
          <CardHeader>
            <CardTitle>Multi-factor authentication</CardTitle>
            <CardDescription>Privileged actions require verified MFA when the tenant policy is enabled.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4"><p className="text-xs uppercase tracking-wide text-slate-500">Policy</p><p className="mt-1 font-medium text-white">{security?.mfa.requiredForPrivilegedActions ? "Required for privileged actions" : "Not required by this environment"}</p></div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4"><p className="text-xs uppercase tracking-wide text-slate-500">This session</p><p className="mt-1 font-medium text-white">{security?.mfa.authenticatedForCurrentSession ? "MFA verified" : "MFA not verified"}</p></div>
              <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4"><p className="text-xs uppercase tracking-wide text-slate-500">Assurance</p><p className="mt-1 font-medium text-white">{security?.mfa.assuranceLevel ?? "Not reported"}</p></div>
            </div>
            {security?.mfa.setupUrl ? <a href={security.mfa.setupUrl} className="inline-flex rounded-full bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950" target="_blank" rel="noreferrer">Manage MFA authenticators</a> : <p className="text-sm text-slate-400">MFA authenticators are managed by your configured identity provider. Ask your administrator to enable external identity management in this environment.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Active sessions</CardTitle><CardDescription>Sessions are recorded server-side; remove any browser or device you do not recognize.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            {profile.isLoading ? <p className="text-sm text-slate-400">Loading active sessions…</p> : null}
            {security?.sessions.length === 0 ? <p className="text-sm text-slate-400">No active server-side sessions are available.</p> : null}
            {security?.sessions.map((session) => (
              <div key={session.id} className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4 md:flex-row md:items-center md:justify-between">
                <div><p className="font-medium text-white">{session.id === security.currentSessionId ? "This session" : "Active session"} · {session.auth_source}</p><p className="mt-1 text-xs text-slate-400">Last seen {new Date(session.last_seen_at).toLocaleString()} · MFA {session.mfa_authenticated ? "verified" : "not verified"}</p><p className="mt-1 truncate text-xs text-slate-500">{session.user_agent || "Browser details unavailable"}</p></div>
                <button type="button" disabled={revokeSession.isPending} onClick={() => revokeSession.mutate(session.id)} className="rounded-full border border-rose-400/40 px-4 py-2 text-sm text-rose-200 disabled:opacity-60">{revokeSession.isPending ? "Removing…" : "Remove session"}</button>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
