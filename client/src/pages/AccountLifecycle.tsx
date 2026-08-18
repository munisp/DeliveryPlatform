import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import DashboardLayout from "@/components/DashboardLayout";
import "./account-lifecycle.css";

type ApiError = { error?: string };

async function request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({})) as T & ApiError;
  if (!response.ok) throw new Error(payload.error ?? "request_failed");
  return payload;
}

function queryToken() {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

function readableError(error: unknown) {
  const code = error instanceof Error ? error.message : "request_failed";
  const messages: Record<string, string> = {
    self_service_signup_disabled: "Self-service signup is not available in this environment.",
    email_delivery_unavailable: "Email delivery is temporarily unavailable. Please try again later.",
    invalid_or_expired_verification_token: "This verification link is invalid or has expired.",
    invalid_or_expired_password_reset_token: "This password-reset link is invalid or has expired.",
    invalid_or_expired_invitation_token: "This invitation link is invalid or has expired.",
    password_must_have_12_characters_letters_and_numbers: "Use at least 12 characters with letters and numbers.",
  };
  return messages[code] ?? "We could not complete that request. Please review the information and try again.";
}

function PublicShell({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: React.ReactNode }) {
  return (
    <main className="lifecycle-page">
      <div className="lifecycle-grid">
        <section className="lifecycle-copy">
          <p className="lifecycle-eyebrow">{eyebrow}</p>
          <h1 className="lifecycle-title">{title}</h1>
          <p className="lifecycle-description">{description}</p>
          <div className="lifecycle-security-note">
            <p><strong>Secure by design</strong></p>
            <p className="mt-1">Verification, invitations, and password recovery links are single-use and expire automatically.</p>
          </div>
        </section>
        <section className="lifecycle-panel">{children}</section>
      </div>
    </main>
  );
}

function Field({ id, label, type = "text", value, onChange, autoComplete, placeholder }: {
  id: string; label: string; type?: string; value: string; onChange(value: string): void; autoComplete?: string; placeholder?: string;
}) {
  return (
    <label className="lifecycle-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
      />
    </label>
  );
}

function ActionButton({ pending, children, onClick }: { pending?: boolean; children: React.ReactNode; onClick?: () => void }) {
  return <button type={onClick ? "button" : "submit"} onClick={onClick} disabled={pending} className="lifecycle-button">{children}</button>;
}

type TenantBranding = { logoDataUrl: string | null; primaryColor: string; accentColor: string; updatedAt: string | null };
type InvitationStatus = { id: string; email: string; role: string | null; createdAt: string; expiresAt: string; acceptedAt: string | null; status: "pending" | "accepted" | "expired" };

function TenantBrandingPanel({ onSaved }: { onSaved?: () => void }) {
  const branding = useQuery({ queryKey: ["tenant-branding"], queryFn: () => request<TenantBranding>("/api/auth/tenant-branding") });
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [primaryColor, setPrimaryColor] = useState("");
  const [accentColor, setAccentColor] = useState("");
  const currentLogo = logoDataUrl ?? branding.data?.logoDataUrl ?? null;
  const currentPrimary = primaryColor || branding.data?.primaryColor || "#0ea5e9";
  const currentAccent = accentColor || branding.data?.accentColor || "#0f172a";
  const save = useMutation({
    mutationFn: () => request<TenantBranding>("/api/auth/tenant-branding", { logoDataUrl: currentLogo, primaryColor: currentPrimary, accentColor: currentAccent }),
    onSuccess: () => { branding.refetch(); onSaved?.(); },
  });
  const selectLogo = (file: File | undefined) => {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 250_000) return;
    const reader = new FileReader();
    reader.onload = () => setLogoDataUrl(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  };

  return <section className="tenant-branding" aria-labelledby="tenant-branding-title">
    <div className="tenant-branding-heading"><div><p className="lifecycle-eyebrow">Tenant branding</p><h2 id="tenant-branding-title">Make this workspace recognizable</h2><p>Upload a small logo and select colors for this tenant. Only tenant administrators can save these settings.</p></div><div className="tenant-brand-preview" style={{ background: currentAccent, borderColor: currentPrimary }} aria-label="Tenant branding preview"><span style={{ background: currentPrimary }}>{currentLogo ? <img src={currentLogo} alt="Selected tenant logo" /> : "T"}</span><strong>Tenant workspace</strong></div></div>
    <div className="tenant-brand-controls">
      <label className="tenant-logo-picker"><span>Logo (PNG, JPEG, or WebP; 250 KB max)</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => selectLogo(event.target.files?.[0])} /><small>Image data remains tenant-scoped and is validated before saving.</small></label>
      <label className="tenant-color-field"><span>Primary color</span><input aria-label="Primary brand color" type="color" value={currentPrimary} onChange={(event) => setPrimaryColor(event.target.value)} /><code>{currentPrimary}</code></label>
      <label className="tenant-color-field"><span>Accent color</span><input aria-label="Accent brand color" type="color" value={currentAccent} onChange={(event) => setAccentColor(event.target.value)} /><code>{currentAccent}</code></label>
    </div>
    {save.isError ? <p className="text-sm text-rose-300">{readableError(save.error)}</p> : null}
    {save.isSuccess ? <p className="text-sm text-emerald-300" role="status">Branding saved. Your workspace setup is complete.</p> : null}
    <ActionButton pending={save.isPending} onClick={() => save.mutate()}>{branding.isLoading ? "Loading branding…" : "Save workspace branding"}</ActionButton>
  </section>;
}

export function SignupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const signup = useMutation({ mutationFn: () => request<{ accepted: boolean }>("/api/auth/signup", { name, email, password }) });

  return <PublicShell eyebrow="Create your workspace" title="Start with a verified account" description="Create the first administrator account for your organization. We will email a verification link before any workspace is activated.">
    <Card>
      <CardHeader><CardTitle>Create account</CardTitle><CardDescription>Use a work email you can access now.</CardDescription></CardHeader>
      <CardContent>
        {signup.isSuccess ? <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-4 text-sm text-emerald-100">Check your inbox for a verification link. It expires automatically for your protection.</div> : (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (password !== confirmation) return; signup.mutate(); }}>
            <Field id="signup-name" label="Your name" value={name} onChange={setName} autoComplete="name" />
            <Field id="signup-email" label="Work email" type="email" value={email} onChange={setEmail} autoComplete="email" />
            <Field id="signup-password" label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" placeholder="12+ characters, letters and numbers" />
            <Field id="signup-confirmation" label="Confirm password" type="password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" />
            {password && confirmation && password !== confirmation ? <p className="text-sm text-rose-300">Passwords do not match.</p> : null}
            {signup.isError ? <p className="text-sm text-rose-300">{readableError(signup.error)}</p> : null}
            <ActionButton pending={signup.isPending}>Create account and send verification</ActionButton>
          </form>
        )}
        <p className="mt-5 text-sm text-slate-400">Already have an account? <Link href="/portal" className="font-medium text-cyan-300 hover:text-cyan-200">Sign in</Link></p>
      </CardContent>
    </Card>
  </PublicShell>;
}

export function VerifyEmailPage() {
  const token = queryToken();
  const confirm = useMutation({ mutationFn: () => request<{ redirect: string }>("/api/auth/email-verification/confirm", { token }), onSuccess: (result) => { window.location.href = result.redirect; } });
  return <PublicShell eyebrow="Verify email" title="Confirm your work email" description="Email verification activates your account and starts the organization setup process.">
    <Card><CardHeader><CardTitle>Ready to verify</CardTitle><CardDescription>Confirm only if you requested this account.</CardDescription></CardHeader><CardContent className="space-y-4">
      {!token ? <p className="rounded-xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-100">This verification link is missing its secure token.</p> : <ActionButton pending={confirm.isPending} onClick={() => confirm.mutate()}>Verify email and continue</ActionButton>}
      {confirm.isError ? <p className="text-sm text-rose-300">{readableError(confirm.error)}</p> : null}
      <Link href="/portal" className="block text-center text-sm font-medium text-cyan-300 hover:text-cyan-200">Return to sign in</Link>
    </CardContent></Card>
  </PublicShell>;
}

export function PasswordResetPage() {
  const token = queryToken();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const requestReset = useMutation({ mutationFn: () => request<{ accepted: boolean }>("/api/auth/password-reset/request", { email }) });
  const confirmReset = useMutation({ mutationFn: () => request<{ redirect: string }>("/api/auth/password-reset/confirm", { token, password }), onSuccess: (result) => { window.location.href = result.redirect; } });
  const isConfirming = Boolean(token);
  return <PublicShell eyebrow="Account recovery" title={isConfirming ? "Choose a new password" : "Reset your password"} description={isConfirming ? "Use a strong, unique password for your operator account." : "Enter your work email. If it matches an active verified account, we will send a recovery link."}>
    <Card><CardHeader><CardTitle>{isConfirming ? "Set new password" : "Request reset link"}</CardTitle></CardHeader><CardContent>
      {isConfirming ? <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (password === confirmation) confirmReset.mutate(); }}>
        <Field id="reset-password" label="New password" type="password" value={password} onChange={setPassword} autoComplete="new-password" />
        <Field id="reset-confirmation" label="Confirm new password" type="password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" />
        {password && confirmation && password !== confirmation ? <p className="text-sm text-rose-300">Passwords do not match.</p> : null}
        {confirmReset.isError ? <p className="text-sm text-rose-300">{readableError(confirmReset.error)}</p> : null}
        <ActionButton pending={confirmReset.isPending}>Update password</ActionButton>
      </form> : requestReset.isSuccess ? <p className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-4 text-sm text-emerald-100">If an eligible account exists, a reset link has been sent.</p> : <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); requestReset.mutate(); }}><Field id="reset-email" label="Work email" type="email" value={email} onChange={setEmail} autoComplete="email" /><ActionButton pending={requestReset.isPending}>Send recovery link</ActionButton></form>}
      <p className="mt-5 text-center text-sm"><Link href="/portal" className="font-medium text-cyan-300 hover:text-cyan-200">Return to sign in</Link></p>
    </CardContent></Card>
  </PublicShell>;
}

export function InvitationAcceptancePage() {
  const token = queryToken();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const accept = useMutation({ mutationFn: () => request<{ redirect: string }>("/api/auth/invitations/accept", { token, name, password }), onSuccess: (result) => { window.location.href = result.redirect; } });
  return <PublicShell eyebrow="Team invitation" title="Join your organization" description="Set your credentials to accept this role-specific invitation. The invitation is single-use and cannot move an account between organizations.">
    <Card><CardHeader><CardTitle>Accept invitation</CardTitle><CardDescription>Use your own strong password.</CardDescription></CardHeader><CardContent>
      {!token ? <p className="rounded-xl border border-rose-400/30 bg-rose-400/10 p-4 text-sm text-rose-100">This invitation link is missing its secure token.</p> : <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (password === confirmation) accept.mutate(); }}>
        <Field id="invite-name" label="Your name" value={name} onChange={setName} autoComplete="name" />
        <Field id="invite-password" label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" />
        <Field id="invite-confirmation" label="Confirm password" type="password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" />
        {password && confirmation && password !== confirmation ? <p className="text-sm text-rose-300">Passwords do not match.</p> : null}
        {accept.isError ? <p className="text-sm text-rose-300">{readableError(accept.error)}</p> : null}
        <ActionButton pending={accept.isPending}>Accept invitation and continue</ActionButton>
      </form>}
    </CardContent></Card>
  </PublicShell>;
}

type OnboardingState = { operator: { name: string; email: string; tenantId: string | null; emailVerified: boolean; onboardingCompleted: boolean }; needsEmailVerification: boolean; needsOrganization: boolean; needsCompletion: boolean };

function OnboardingProgress({ state }: { state: OnboardingState }) {
  const completedSteps = Number(!state.needsEmailVerification) + Number(!state.needsOrganization) + Number(state.operator.onboardingCompleted);
  const activeStep = state.needsEmailVerification ? 1 : state.needsOrganization ? 2 : 3;
  const progress = Math.round((completedSteps / 3) * 100);
  const steps = ["Verify account", "Create workspace", "Invite team"];

  return <section className="onboarding-progress" aria-labelledby="onboarding-progress-title">
    <div className="onboarding-progress-heading"><p id="onboarding-progress-title">Setup progress</p><span>{completedSteps} of 3 complete</span></div>
    <div className="onboarding-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={3} aria-valuenow={completedSteps} aria-valuetext={`${completedSteps} of 3 onboarding steps complete`}><span style={{ width: `${progress}%` }} /></div>
    <ol className="onboarding-steps">
      {steps.map((step, index) => {
        const number = index + 1;
        const stateClass = number < activeStep || (number === 3 && state.operator.onboardingCompleted) ? "is-complete" : number === activeStep ? "is-current" : "";
        return <li key={step} className={stateClass} aria-current={number === activeStep ? "step" : undefined}><span>{number < activeStep || (number === 3 && state.operator.onboardingCompleted) ? "✓" : number}</span>{step}</li>;
      })}
    </ol>
  </section>;
}

export function OnboardingPage() {
  const [organizationName, setOrganizationName] = useState("");
  const [organizationSlug, setOrganizationSlug] = useState("");
  const [tenantName, setTenantName] = useState("");
  const state = useQuery({ queryKey: ["account-onboarding"], queryFn: () => request<OnboardingState>("/api/auth/onboarding") });
  const createOrganization = useMutation({ mutationFn: () => request<{ redirect: string }>("/api/auth/onboarding/organization", { organizationName, organizationSlug, tenantName }), onSuccess: (result) => { window.location.href = result.redirect; } });
  return <PublicShell eyebrow="Workspace setup" title="Set up your organization" description="Create the first organization and tenant workspace. You will become its initial administrator and can invite your team next.">
    <Card><CardHeader><CardTitle>{state.data?.needsOrganization ? `Welcome, ${state.data.operator.name}` : "Onboarding"}</CardTitle><CardDescription>Complete the remaining setup steps before operating the platform.</CardDescription></CardHeader><CardContent>
      {state.isLoading ? <p className="text-sm text-slate-400">Checking your setup status…</p> : state.isError ? <div className="space-y-3"><p className="text-sm text-rose-300">Your session could not be verified.</p><Link href="/portal" className="text-sm font-medium text-cyan-300">Sign in</Link></div> : state.data ? <>
        <OnboardingProgress state={state.data} />
        {!state.data.needsEmailVerification && state.data.needsOrganization ? <div className="onboarding-welcome" role="status"><p>Welcome, {state.data.operator.name}.</p><span>Your verified account is ready for its first workspace.</span></div> : null}
        {state.data.needsEmailVerification ? <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-4 text-sm text-amber-100">Verify your email from the message we sent before creating a workspace.</p> : state.data.needsOrganization ? <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); createOrganization.mutate(); }}>
        <Field id="organization-name" label="Organization name" value={organizationName} onChange={setOrganizationName} autoComplete="organization" />
        <Field id="organization-slug" label="Workspace URL name" value={organizationSlug} onChange={setOrganizationSlug} placeholder="example-logistics" />
        <Field id="tenant-name" label="Primary tenant name" value={tenantName} onChange={setTenantName} placeholder="Operations" />
        {createOrganization.isError ? <p className="text-sm text-rose-300">{readableError(createOrganization.error)}</p> : null}
        <ActionButton pending={createOrganization.isPending}>Create organization and workspace</ActionButton>
        </form> : state.data.needsCompletion ? <TenantBrandingPanel onSaved={() => state.refetch()} /> : <div className="space-y-4"><p className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-4 text-sm text-emerald-100">Your workspace is ready. Invite teammates from the dashboard whenever you are ready.</p><Link href="/dashboard" className="inline-flex rounded-xl bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950">Open dashboard</Link></div>}
      </> : null}
    </CardContent></Card>
  </PublicShell>;
}

export function InviteTeamPage() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("operator");
  const invitations = useQuery({ queryKey: ["invitation-status"], queryFn: () => request<{ invitations: InvitationStatus[] }>("/api/auth/invitations/status") });
  const invite = useMutation({ mutationFn: () => request<{ invited: boolean }>("/api/auth/invitations", { email, role }), onSuccess: () => { invitations.refetch(); setEmail(""); } });
  return <DashboardLayout><div className="mx-auto max-w-3xl space-y-6"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Team access</p><h1 className="mt-2 text-3xl font-semibold text-white">Invite and monitor your team</h1><p className="mt-2 text-slate-400">Tenant administrators can issue role-specific invitations and see whether each link is still pending, accepted, or expired.</p></div><Card><CardHeader><CardTitle>New invitation</CardTitle><CardDescription>Only invite colleagues who should have access to this tenant.</CardDescription></CardHeader><CardContent><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); invite.mutate(); }}><Field id="invite-email" label="Work email" type="email" value={email} onChange={setEmail} autoComplete="email" /><label className="block space-y-2"><span className="text-sm font-medium text-slate-200">Role</span><select value={role} onChange={(event) => setRole(event.target.value)} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none focus:border-cyan-400"><option value="operator">Operator</option><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label>{invite.isError ? <p className="text-sm text-rose-300">{readableError(invite.error)}</p> : null}{invite.isSuccess ? <p className="text-sm text-emerald-300" role="status">Invitation sent. The recipient will receive a secure acceptance link.</p> : null}<ActionButton pending={invite.isPending}>Send invitation</ActionButton></form></CardContent></Card><Card><CardHeader><CardTitle>Invitation status</CardTitle><CardDescription>Invitation tokens are never shown. Status is calculated from tenant-scoped token state.</CardDescription></CardHeader><CardContent>{invitations.isLoading ? <p className="text-sm text-slate-400">Loading invitations…</p> : invitations.isError ? <p className="text-sm text-rose-300">Invitation status is unavailable.</p> : invitations.data?.invitations.length ? <ul className="invitation-status-list">{invitations.data.invitations.map((entry) => <li key={entry.id}><div><strong>{entry.email}</strong><span>{entry.role ?? "operator"} · sent {new Date(entry.createdAt).toLocaleDateString()}</span></div><span className={`invitation-status invitation-status-${entry.status}`}>{entry.status}</span></li>)}</ul> : <p className="text-sm text-slate-400">No invitations have been sent from this tenant yet.</p>}</CardContent></Card></div></DashboardLayout>;
}
