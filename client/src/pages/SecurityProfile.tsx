import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
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
  recentLoginActivity: Array<SecuritySession & { revoked_at: string | null }>;
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
  const [showMfaWizard, setShowMfaWizard] = useState(false);
  const [confirmRevokeOthers, setConfirmRevokeOthers] = useState(false);
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
  const revokeOtherSessions = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/auth/security/sessions/revoke-others", { method: "POST", credentials: "include" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw securityFeedback(response.status, String(payload?.error ?? "security_other_sessions_revoke_failed"));
      return payload as { revokedSessions: number };
    },
    onSuccess: () => {
      setConfirmRevokeOthers(false);
      queryClient.invalidateQueries({ queryKey: ["security-profile"] });
    },
  });

  const error = profile.error ?? revokeSession.error ?? revokeOtherSessions.error;
  const feedback = isFeedback(error) ? error : null;
  const security = profile.data;

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-5xl space-y-6">
        <div>
          <p className="text-sm uppercase tracking-[0.24em] text-cyan-300">Profile</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold text-white">Security settings</h1>
            <span aria-live="polite" className={`rounded-full border px-3 py-1 text-xs font-semibold ${security?.mfa.authenticatedForCurrentSession ? "border-emerald-400/40 bg-emerald-500/15 text-emerald-100" : "border-amber-400/40 bg-amber-500/15 text-amber-100"}`}>
              MFA {security?.mfa.authenticatedForCurrentSession ? "Enabled" : security?.mfa.requiredForPrivilegedActions ? "Required" : "Not enabled"}
            </span>
          </div>
          <p className="mt-2 max-w-3xl text-slate-400">Review the assurance level of this session, manage authenticators through your identity provider, and remove active sessions you no longer recognize.</p>
        </div>

        {feedback ? <div role="alert" className={`rounded-xl border p-4 text-sm ${feedback.tone === "success" ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-100" : feedback.tone === "warning" ? "border-amber-400/30 bg-amber-500/10 text-amber-100" : "border-rose-400/30 bg-rose-500/10 text-rose-100"}`}><strong>{feedback.title}.</strong> {feedback.message}</div> : null}
        {revokeSession.isSuccess ? <div role="status" className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">Session removed successfully.</div> : null}
        {revokeOtherSessions.isSuccess ? <div role="status" className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">Other sessions removed successfully.</div> : null}

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
            <div className="flex flex-wrap gap-3">
              <button type="button" onClick={() => setShowMfaWizard((visible) => !visible)} className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950">{showMfaWizard ? "Hide enrollment steps" : "Set up MFA"}</button>
              {security?.mfa.setupUrl ? <a href={security.mfa.setupUrl} className="rounded-full border border-cyan-400/40 px-4 py-2 text-sm text-cyan-100" target="_blank" rel="noreferrer">Open identity-provider security</a> : null}
            </div>
            {showMfaWizard ? <ol className="space-y-3 rounded-xl border border-cyan-400/20 bg-cyan-500/5 p-4 text-sm text-slate-200">
              <li><strong>1. Choose an authenticator.</strong> Install or open a standards-based authenticator app on a separate device.</li>
              <li><strong>2. Open the identity-provider security page.</strong> Select “Set up authenticator” and scan the one-time QR code shown there; never share the QR code or its setup key.</li>
              <li><strong>3. Verify the time-based code.</strong> Enter the current code from your app to complete enrollment and refresh this page to confirm session assurance.</li>
              <li><strong>4. Generate recovery codes in the identity provider.</strong> Download or write each one-time code offline. Recovery codes are generated and stored by the identity provider, not by this application, so this page never receives or retains them.</li>
            </ol> : null}
            {!security?.mfa.setupUrl ? <p className="text-sm text-slate-400">MFA authenticators and recovery codes are managed by your configured identity provider. Ask an administrator to enable external identity management in this environment.</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Active sessions</CardTitle><CardDescription>Sessions are recorded server-side; remove any browser or device you do not recognize.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            {security && security.sessions.length > 1 ? <button type="button" onClick={() => setConfirmRevokeOthers(true)} className="rounded-full border border-rose-400/40 px-4 py-2 text-sm text-rose-200">Revoke All Other Sessions</button> : null}
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

        <Card>
          <CardHeader><CardTitle>Recent login activity</CardTitle><CardDescription>Recent authenticated session creation is retained for visibility. Network addresses and session secrets are not displayed.</CardDescription></CardHeader>
          <CardContent className="space-y-3">
            {security?.recentLoginActivity.map((activity) => <div key={`${activity.id}-${activity.created_at}`} className="rounded-xl border border-slate-800 bg-slate-950/60 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><p className="font-medium text-white">{activity.auth_source} sign-in</p><span className={`rounded-full px-2 py-1 text-xs ${activity.revoked_at ? "bg-slate-800 text-slate-300" : "bg-emerald-500/15 text-emerald-200"}`}>{activity.revoked_at ? "Revoked" : "Active"}</span></div><p className="mt-1 text-xs text-slate-400">{new Date(activity.created_at).toLocaleString()} · MFA {activity.mfa_authenticated ? "verified" : "not verified"}</p><p className="mt-1 truncate text-xs text-slate-500">{activity.user_agent || "Browser details unavailable"}</p></div>)}
            {security?.recentLoginActivity.length === 0 ? <p className="text-sm text-slate-400">No recent login activity is available.</p> : null}
          </CardContent>
        </Card>
      </div>
      {confirmRevokeOthers ? <div role="dialog" aria-modal="true" aria-labelledby="revoke-others-title" className="fixed inset-0 z-50 grid place-items-center bg-slate-950/80 p-4"><Card className="w-full max-w-md"><CardHeader><CardTitle id="revoke-others-title">Revoke all other sessions?</CardTitle><CardDescription>Every other active browser or device will be signed out. Your current session will remain active.</CardDescription></CardHeader><CardContent className="flex justify-end gap-3"><button type="button" onClick={() => setConfirmRevokeOthers(false)} className="rounded-full border border-slate-700 px-4 py-2 text-sm text-slate-100">Cancel</button><button type="button" disabled={revokeOtherSessions.isPending} onClick={() => revokeOtherSessions.mutate()} className="rounded-full bg-rose-500 px-4 py-2 text-sm font-medium text-white disabled:opacity-60">{revokeOtherSessions.isPending ? "Revoking…" : "Revoke other sessions"}</button></CardContent></Card></div> : null}
    </DashboardLayout>
  );
}
