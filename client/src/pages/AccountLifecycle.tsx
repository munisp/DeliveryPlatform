import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { useMemo, useState } from "react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import DashboardLayout from "@/components/DashboardLayout";
import "./account-lifecycle.css";

type ApiError = { error?: string };

async function request<T>(path: string, body?: Record<string, unknown>, method: "GET" | "POST" | "DELETE" = body ? "POST" : "GET"): Promise<T> {
  const response = await fetch(path, {
    method,
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

function localDateValue(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function recentDateRange(days: number) {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (days - 1));
  return { startDate: localDateValue(start), endDate: localDateValue(end) };
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

function Field({ id, label, type = "text", value, onChange, autoComplete, placeholder, hint, tooltip, error }: {
  id: string; label: string; type?: string; value: string; onChange(value: string): void; autoComplete?: string; placeholder?: string; hint?: string; tooltip?: string; error?: string;
}) {
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <label className="lifecycle-field" htmlFor={id}>
      <span className="lifecycle-field-label">{label}{tooltip ? <span className="lifecycle-tooltip" tabIndex={0} aria-label={`${label}: ${tooltip}`}><span aria-hidden="true">?</span><span className="lifecycle-tooltip-content" role="tooltip">{tooltip}</span></span> : null}</span>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
      />
      {hint ? <small id={`${id}-hint`} className="lifecycle-field-hint">{hint}</small> : null}
      {error ? <small id={`${id}-error`} className="lifecycle-field-error" role="alert">{error}</small> : null}
    </label>
  );
}

function ActionButton({ pending, children, onClick, disabled }: { pending?: boolean; children: React.ReactNode; onClick?: () => void; disabled?: boolean }) {
  return <button type={onClick ? "button" : "submit"} onClick={onClick} disabled={pending || disabled} className="lifecycle-button">{children}</button>;
}

type TenantBranding = { logoDataUrl: string | null; primaryColor: string; accentColor: string; updatedAt: string | null };
type TenantBrandingPreset = TenantBranding & { id: string; name: string; createdAt: string; updatedAt: string; organizationShared: boolean; sourceTenantName?: string };
type TenantBrandingPresetOwnershipAudit = { id: string; presetId: string; presetName: string; fromOperatorEmail: string | null; toOperatorEmail: string | null; transferredByOperatorEmail: string | null; transferredAt: string };
type InvitationStatus = { id: string; email: string; role: string | null; createdAt: string; expiresAt: string; acceptedAt: string | null; revokedAt: string | null; status: "pending" | "accepted" | "expired" | "revoked" };
type TenantMember = { id: number; email: string; name: string; role: "admin" | "operator" | "viewer"; updatedAt: string };

async function downloadInvitationActivityCsv() {
  const response = await fetch("/api/auth/invitations/activity.csv", { credentials: "include" });
  if (!response.ok) throw new Error("invitation_activity_export_failed");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = "invitation-activity.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function TenantBrandingPanel({ onSaved }: { onSaved?: () => void }) {
  const branding = useQuery({ queryKey: ["tenant-branding"], queryFn: () => request<TenantBranding>("/api/auth/tenant-branding") });
  const presets = useQuery({ queryKey: ["tenant-branding-presets"], queryFn: () => request<{ presets: TenantBrandingPreset[] }>("/api/auth/tenant-branding/presets") });
  const sharedPresets = useQuery({ queryKey: ["organization-shared-branding-presets"], queryFn: () => request<{ presets: TenantBrandingPreset[] }>("/api/auth/tenant-branding/presets/shared") });
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [primaryColor, setPrimaryColor] = useState("");
  const [accentColor, setAccentColor] = useState("");
  const [previewMode, setPreviewMode] = useState<"light" | "dark">("light");
  const [presetName, setPresetName] = useState("");
  const [transferRecipientEmail, setTransferRecipientEmail] = useState("");
  const [ownershipStartDate, setOwnershipStartDate] = useState("");
  const [ownershipEndDate, setOwnershipEndDate] = useState("");
  const ownershipRangePreset = useMemo(() => {
    const lastSevenDays = recentDateRange(7);
    const lastThirtyDays = recentDateRange(30);
    if (!ownershipStartDate && !ownershipEndDate) return "all";
    if (ownershipStartDate === lastSevenDays.startDate && ownershipEndDate === lastSevenDays.endDate) return "last-seven-days";
    if (ownershipStartDate === lastThirtyDays.startDate && ownershipEndDate === lastThirtyDays.endDate) return "last-thirty-days";
    return "custom";
  }, [ownershipEndDate, ownershipStartDate]);
  const ownershipHistory = useQuery({ queryKey: ["tenant-branding-preset-ownership-history", ownershipStartDate, ownershipEndDate], queryFn: () => { const query = new URLSearchParams(); if (ownershipStartDate) query.set("startDate", ownershipStartDate); if (ownershipEndDate) query.set("endDate", ownershipEndDate); return request<{ history: TenantBrandingPresetOwnershipAudit[] }>(`/api/auth/tenant-branding/presets/audit-history?${query.toString()}`); } });
  const currentLogo = logoDataUrl ?? branding.data?.logoDataUrl ?? null;
  const currentPrimary = primaryColor || branding.data?.primaryColor || "#0ea5e9";
  const currentAccent = accentColor || branding.data?.accentColor || "#0f172a";
  const save = useMutation({
    mutationFn: () => request<TenantBranding>("/api/auth/tenant-branding", { logoDataUrl: currentLogo, primaryColor: currentPrimary, accentColor: currentAccent }),
    onSuccess: () => { branding.refetch(); onSaved?.(); },
  });
  const savePreset = useMutation({
    mutationFn: () => request<TenantBrandingPreset>("/api/auth/tenant-branding/presets", { name: presetName, logoDataUrl: currentLogo, primaryColor: currentPrimary, accentColor: currentAccent }),
    onSuccess: () => { presets.refetch(); setPresetName(""); },
  });
  const applyPreset = useMutation({
    mutationFn: (presetId: string) => request<TenantBranding>(`/api/auth/tenant-branding/presets/${presetId}/apply`, {}),
    onSuccess: (saved) => { setLogoDataUrl(saved.logoDataUrl); setPrimaryColor(saved.primaryColor); setAccentColor(saved.accentColor); branding.refetch(); onSaved?.(); },
  });
  const removePreset = useMutation({
    mutationFn: (presetId: string) => request<{ deleted: boolean }>(`/api/auth/tenant-branding/presets/${presetId}`, undefined, "DELETE"),
    onSuccess: () => presets.refetch(),
  });
  const sharePreset = useMutation({
    mutationFn: ({ presetId, shared }: { presetId: string; shared: boolean }) => request<{ organizationShared: boolean }>(`/api/auth/tenant-branding/presets/${presetId}/share`, { shared }),
    onSuccess: () => { presets.refetch(); sharedPresets.refetch(); },
  });
  const applySharedPreset = useMutation({
    mutationFn: (presetId: string) => request<TenantBranding>(`/api/auth/tenant-branding/presets/${presetId}/apply-shared`, {}),
    onSuccess: (saved) => { setLogoDataUrl(saved.logoDataUrl); setPrimaryColor(saved.primaryColor); setAccentColor(saved.accentColor); branding.refetch(); onSaved?.(); },
  });
  const transferOwnership = useMutation({
    mutationFn: (presetId: string) => request<{ id: string }>(`/api/auth/tenant-branding/presets/${presetId}/transfer-ownership`, { recipientEmail: transferRecipientEmail }),
    onSuccess: () => { presets.refetch(); ownershipHistory.refetch(); setTransferRecipientEmail(""); },
  });
  const selectLogo = (file: File | undefined) => {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 250_000) return;
    const reader = new FileReader();
    reader.onload = () => setLogoDataUrl(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  };

  return <section className="tenant-branding" aria-labelledby="tenant-branding-title">
    <div className="tenant-branding-heading"><div><p className="lifecycle-eyebrow">Tenant branding</p><h2 id="tenant-branding-title">Make this workspace recognizable</h2><p>Upload a small logo and select colors for this tenant. Only tenant administrators can save these settings.</p></div><div className="tenant-brand-preview" style={{ background: currentAccent, borderColor: currentPrimary }} aria-label="Tenant branding summary"><span style={{ background: currentPrimary }}>{currentLogo ? <img src={currentLogo} alt="Selected tenant logo" /> : "T"}</span><strong>Tenant workspace</strong></div></div>
    <div className="tenant-brand-controls">
      <label className="tenant-logo-picker"><span>Logo (PNG, JPEG, or WebP; 250 KB max)</span><input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => selectLogo(event.target.files?.[0])} /><small>Image data remains tenant-scoped and is validated before saving.</small></label>
      <label className="tenant-color-field"><span>Primary color</span><input aria-label="Primary brand color" type="color" value={currentPrimary} onChange={(event) => setPrimaryColor(event.target.value)} /><code>{currentPrimary}</code></label>
      <label className="tenant-color-field"><span>Accent color</span><input aria-label="Accent brand color" type="color" value={currentAccent} onChange={(event) => setAccentColor(event.target.value)} /><code>{currentAccent}</code></label>
    </div>
    <div className="tenant-preview-mode" role="group" aria-label="Live preview theme">
      <span>Preview theme</span><button type="button" aria-pressed={previewMode === "light"} onClick={() => setPreviewMode("light")}>Light</button><button type="button" aria-pressed={previewMode === "dark"} onClick={() => setPreviewMode("dark")}>Dark</button>
    </div>
    <section className={`tenant-brand-live-preview ${previewMode === "dark" ? "is-dark" : ""}`} style={{ background: currentAccent, borderColor: currentPrimary }} aria-label={`${previewMode} mode live tenant workspace preview`}>
      <div className="tenant-brand-live-preview-bar"><span style={{ background: currentPrimary }}>{currentLogo ? <img src={currentLogo} alt="" /> : "T"}</span><strong>Tenant workspace</strong><small>{previewMode} preview</small></div>
      <div className="tenant-brand-live-preview-content"><p>Operations overview</p><h3>Today’s work, clearly yours.</h3><span>These colors and your logo update immediately as you make changes.</span><button type="button" style={{ background: currentPrimary }}>Review activity</button></div>
    </section>
    <section className="tenant-brand-presets" aria-labelledby="tenant-brand-presets-title"><div><h3 id="tenant-brand-presets-title">Branding presets</h3><p>Save this tenant’s current colors and logo for fast reuse, share a preset, or transfer its ownership to another tenant administrator.</p></div><div className="tenant-preset-save"><Field id="branding-preset-name" label="Preset name" value={presetName} onChange={setPresetName} placeholder="Night operations" /><ActionButton pending={savePreset.isPending} disabled={!presetName.trim()} onClick={() => savePreset.mutate()}>Save preset</ActionButton></div><div className="tenant-preset-save"><Field id="branding-preset-transfer-recipient" label="Transfer recipient administrator" type="email" value={transferRecipientEmail} onChange={setTransferRecipientEmail} placeholder="admin@example.com" hint="The recipient must be an active administrator in this tenant." /></div>{savePreset.isError || transferOwnership.isError ? <p className="text-sm text-rose-300">{readableError(savePreset.error ?? transferOwnership.error)}</p> : null}{presets.isLoading ? <p className="text-sm text-slate-400">Loading presets…</p> : presets.data?.presets.length ? <ul className="tenant-preset-list">{presets.data.presets.map((preset) => <li key={preset.id}><span className="tenant-preset-swatch" style={{ background: preset.primaryColor }} aria-hidden="true" /><div><strong>{preset.name}</strong><small>{preset.primaryColor} · {preset.accentColor}{preset.organizationShared ? " · shared with organization" : ""}</small></div><button type="button" onClick={() => applyPreset.mutate(preset.id)} disabled={applyPreset.isPending}>Apply</button><button type="button" className="tenant-preset-share" onClick={() => sharePreset.mutate({ presetId: preset.id, shared: !preset.organizationShared })} disabled={sharePreset.isPending}>{preset.organizationShared ? "Stop sharing" : "Share"}</button><button type="button" onClick={() => transferOwnership.mutate(preset.id)} disabled={!transferRecipientEmail || transferOwnership.isPending}>Transfer ownership</button><button type="button" className="tenant-preset-delete" onClick={() => removePreset.mutate(preset.id)} disabled={removePreset.isPending}>Delete</button></li>)}</ul> : <p className="text-sm text-slate-400">No saved presets yet.</p>}</section>
    <section className="tenant-brand-shared-presets" aria-labelledby="organization-branding-library-title"><div><h3 id="organization-branding-library-title">Organization branding library</h3><p>Shared presets from other tenant administrators. Applying one copies its branding into this tenant.</p></div>{sharedPresets.isLoading ? <p className="text-sm text-slate-400">Loading shared presets…</p> : sharedPresets.data?.presets.length ? <ul className="tenant-preset-list">{sharedPresets.data.presets.map((preset) => <li key={preset.id}><span className="tenant-preset-swatch" style={{ background: preset.primaryColor }} aria-hidden="true" /><div><strong>{preset.name}</strong><small>{preset.sourceTenantName ?? "Organization"} · {preset.primaryColor} · {preset.accentColor}</small></div><button type="button" onClick={() => applySharedPreset.mutate(preset.id)} disabled={applySharedPreset.isPending}>Apply to this tenant</button></li>)}</ul> : <p className="text-sm text-slate-400">No organization-shared presets are available yet.</p>}</section>
    <section className="tenant-brand-shared-presets" aria-labelledby="preset-ownership-history-title"><div><h3 id="preset-ownership-history-title">Preset ownership history</h3><p>Transfers are retained for tenant administrators as an ownership audit trail.</p></div><div className="flex flex-wrap gap-3 py-3"><label className="grid gap-1 text-sm text-slate-300"><span>From</span><input type="date" value={ownershipStartDate} onChange={(event) => setOwnershipStartDate(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1" /></label><label className="grid gap-1 text-sm text-slate-300"><span>To</span><input type="date" value={ownershipEndDate} onChange={(event) => setOwnershipEndDate(event.target.value)} className="rounded-lg border border-slate-700 bg-slate-950 px-2 py-1" /></label></div>{ownershipStartDate && ownershipEndDate && ownershipStartDate > ownershipEndDate ? <p role="alert" className="text-sm text-rose-300">The start date must be before the end date.</p> : ownershipHistory.isLoading ? <p className="text-sm text-slate-400">Loading ownership history…</p> : ownershipHistory.data?.history.length ? <ul className="tenant-preset-list">{ownershipHistory.data.history.map((entry) => <li key={entry.id}><div><strong>{entry.presetName}</strong><small>{entry.fromOperatorEmail ?? "Previous owner"} → {entry.toOperatorEmail ?? "Current owner"} · {new Date(entry.transferredAt).toLocaleString()}</small></div></li>)}</ul> : <p className="text-sm text-slate-400">No preset ownership transfers match this date range.</p>}</section>
    <div className="tenant-audit-range-presets" role="group" aria-label="Quick ownership audit date ranges"><span>Quick range</span><button type="button" aria-pressed={ownershipRangePreset === "all"} onClick={() => { setOwnershipStartDate(""); setOwnershipEndDate(""); }}>All time</button><button type="button" aria-pressed={ownershipRangePreset === "last-seven-days"} onClick={() => { const range = recentDateRange(7); setOwnershipStartDate(range.startDate); setOwnershipEndDate(range.endDate); }}>Last 7 days</button><button type="button" aria-pressed={ownershipRangePreset === "last-thirty-days"} onClick={() => { const range = recentDateRange(30); setOwnershipStartDate(range.startDate); setOwnershipEndDate(range.endDate); }}>Last 30 days</button></div>
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
  const emailError = email && !/^\S+@\S+\.\S+$/.test(email) ? "Enter a valid work email address." : "";
  const passwordError = password && !/^(?=.*[A-Za-z])(?=.*\d).{12,}$/.test(password) ? "Use at least 12 characters, including letters and numbers." : "";
  const confirmationError = confirmation && password !== confirmation ? "Passwords do not match." : "";
  const canSubmit = Boolean(name.trim() && email && password && confirmation) && !emailError && !passwordError && !confirmationError;

  return <PublicShell eyebrow="Create your workspace" title="Start with a verified account" description="Create the first administrator account for your organization. We will email a verification link before any workspace is activated.">
    <Card>
      <CardHeader><CardTitle>Create account</CardTitle><CardDescription>Use a work email you can access now.</CardDescription></CardHeader>
      <CardContent>
        {signup.isSuccess ? <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-4 text-sm text-emerald-100">Check your inbox for a verification link. It expires automatically for your protection.</div> : (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (!canSubmit) return; signup.mutate(); }}>
            <Field id="signup-name" label="Your name" value={name} onChange={setName} autoComplete="name" hint="Use the name colleagues will recognize in workspace activity." />
            <Field id="signup-email" label="Work email" type="email" value={email} onChange={setEmail} autoComplete="email" tooltip="We use this only for account verification and security notices." error={emailError} />
            <Field id="signup-password" label="Password" type="password" value={password} onChange={setPassword} autoComplete="new-password" placeholder="12+ characters, letters and numbers" tooltip="Long, unique passwords protect your workspace." hint="At least 12 characters, with letters and numbers." error={passwordError} />
            <Field id="signup-confirmation" label="Confirm password" type="password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" error={confirmationError} />
            {signup.isError ? <p className="text-sm text-rose-300">{readableError(signup.error)}</p> : null}
            <ActionButton pending={signup.isPending} disabled={!canSubmit}>Create account and send verification</ActionButton>
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
  const emailError = email && !/^\S+@\S+\.\S+$/.test(email) ? "Enter a valid work email address." : "";
  const passwordError = password && !/^(?=.*[A-Za-z])(?=.*\d).{12,}$/.test(password) ? "Use at least 12 characters, including letters and numbers." : "";
  const confirmationError = confirmation && password !== confirmation ? "Passwords do not match." : "";
  const canConfirm = Boolean(password && confirmation) && !passwordError && !confirmationError;
  return <PublicShell eyebrow="Account recovery" title={isConfirming ? "Choose a new password" : "Reset your password"} description={isConfirming ? "Use a strong, unique password for your operator account." : "Enter your work email. If it matches an active verified account, we will send a recovery link."}>
    <Card><CardHeader><CardTitle>{isConfirming ? "Set new password" : "Request reset link"}</CardTitle></CardHeader><CardContent>
      {isConfirming ? <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (!canConfirm) return; confirmReset.mutate(); }}>
        <Field id="reset-password" label="New password" type="password" value={password} onChange={setPassword} autoComplete="new-password" tooltip="Choose a password you have not used for this account." hint="At least 12 characters, with letters and numbers." error={passwordError} />
        <Field id="reset-confirmation" label="Confirm new password" type="password" value={confirmation} onChange={setConfirmation} autoComplete="new-password" error={confirmationError} />
        {confirmReset.isError ? <p className="text-sm text-rose-300">{readableError(confirmReset.error)}</p> : null}
        <ActionButton pending={confirmReset.isPending} disabled={!canConfirm}>Update password</ActionButton>
      </form> : requestReset.isSuccess ? <p className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 p-4 text-sm text-emerald-100">If an eligible account exists, a reset link has been sent.</p> : <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (!emailError && email) requestReset.mutate(); }}><Field id="reset-email" label="Work email" type="email" value={email} onChange={setEmail} autoComplete="email" tooltip="For privacy, we show the same response whether or not this address has an account." error={emailError} /><ActionButton pending={requestReset.isPending} disabled={!email || Boolean(emailError)}>Send recovery link</ActionButton></form>}
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
  const [statusFilter, setStatusFilter] = useState<"all" | InvitationStatus["status"]>("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("newest");
  const [selectedInvitationIds, setSelectedInvitationIds] = useState<string[]>([]);
  const [revokeConfirmationIds, setRevokeConfirmationIds] = useState<string[] | null>(null);
  const invitations = useQuery({ queryKey: ["invitation-status"], queryFn: () => request<{ invitations: InvitationStatus[] }>("/api/auth/invitations/status") });
  const invite = useMutation({ mutationFn: () => request<{ invited: boolean }>("/api/auth/invitations", { email, role }), onSuccess: () => { invitations.refetch(); setEmail(""); } });
  const resend = useMutation({ mutationFn: (id: string) => request<{ resent: boolean }>(`/api/auth/invitations/${id}/resend`, {}), onSuccess: () => invitations.refetch() });
  const revoke = useMutation({ mutationFn: (id: string) => request<{ revoked: boolean }>(`/api/auth/invitations/${id}/revoke`, {}), onSuccess: () => invitations.refetch() });
  const bulkResend = useMutation({ mutationFn: (invitationIds: string[]) => request<{ succeeded: string[]; failed: string[] }>("/api/auth/invitations/actions/bulk/resend", { invitationIds }), onSuccess: () => { setSelectedInvitationIds([]); invitations.refetch(); } });
  const bulkRevoke = useMutation({ mutationFn: (invitationIds: string[]) => request<{ succeeded: string[]; failed: string[] }>("/api/auth/invitations/actions/bulk/revoke", { invitationIds }), onSuccess: () => { setSelectedInvitationIds([]); setRevokeConfirmationIds(null); invitations.refetch(); } });
  const visibleInvitations = useMemo(() => (invitations.data?.invitations ?? []).filter((entry) => (statusFilter === "all" || entry.status === statusFilter) && (roleFilter === "all" || (entry.role ?? "operator") === roleFilter) && entry.email.toLowerCase().includes(search.trim().toLowerCase())).sort((left, right) => sortBy === "recipient" ? left.email.localeCompare(right.email) : sortBy === "expiry" ? new Date(left.expiresAt).getTime() - new Date(right.expiresAt).getTime() : sortBy === "oldest" ? new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() : new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()), [invitations.data?.invitations, roleFilter, search, sortBy, statusFilter]);
  const pendingVisibleIds = visibleInvitations.filter((entry) => entry.status === "pending").map((entry) => entry.id);
  const toggleInvitation = (id: string) => setSelectedInvitationIds((ids) => ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id]);
  const selectionCount = selectedInvitationIds.length;
  return <DashboardLayout><div className="mx-auto max-w-3xl space-y-6"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Team access</p><h1 className="mt-2 text-3xl font-semibold text-white">Invite and monitor your team</h1><p className="mt-2 text-slate-400">Tenant administrators can issue role-specific invitations and see whether each link is still pending, accepted, expired, or revoked.</p></div><Card><CardHeader><CardTitle>New invitation</CardTitle><CardDescription>Only invite colleagues who should have access to this tenant.</CardDescription></CardHeader><CardContent><form className="space-y-4" onSubmit={(event) => { event.preventDefault(); invite.mutate(); }}><Field id="invite-email" label="Work email" type="email" value={email} onChange={setEmail} autoComplete="email" tooltip="Use a colleague’s work address; invitation links are single-use." /><label className="block space-y-2"><span className="text-sm font-medium text-slate-200">Role</span><select value={role} onChange={(event) => setRole(event.target.value)} className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none focus:border-cyan-400"><option value="operator">Operator</option><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label>{invite.isError ? <p className="text-sm text-rose-300">{readableError(invite.error)}</p> : null}{invite.isSuccess ? <p className="text-sm text-emerald-300" role="status">Invitation sent. The recipient will receive a secure acceptance link.</p> : null}<ActionButton pending={invite.isPending}>Send invitation</ActionButton></form></CardContent></Card><Card><CardHeader><CardTitle>Invitation status</CardTitle><CardDescription>Invitation tokens are never shown. Only active pending invitations can be resent or revoked.</CardDescription></CardHeader><CardContent>{invitations.isLoading ? <p className="text-sm text-slate-400">Loading invitations…</p> : invitations.isError ? <p className="text-sm text-rose-300">Invitation status is unavailable.</p> : invitations.data?.invitations.length ? <><div className="invitation-toolbar" aria-label="Invitation filters and sorting"><Field id="invitation-search" label="Find invite" value={search} onChange={setSearch} placeholder="Search email" /><label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}><option value="all">All statuses</option><option value="pending">Pending</option><option value="accepted">Accepted</option><option value="expired">Expired</option><option value="revoked">Revoked</option></select></label><label><span>Role</span><select value={roleFilter} onChange={(event) => setRoleFilter(event.target.value)}><option value="all">All roles</option><option value="operator">Operator</option><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label><label><span>Sort by</span><select value={sortBy} onChange={(event) => setSortBy(event.target.value)}><option value="newest">Newest sent</option><option value="oldest">Oldest sent</option><option value="expiry">Expiring soon</option><option value="recipient">Recipient A–Z</option></select></label></div><div className="invitation-bulk-toolbar" aria-label="Bulk invitation actions"><label><input type="checkbox" checked={Boolean(pendingVisibleIds.length) && pendingVisibleIds.every((id) => selectedInvitationIds.includes(id))} onChange={(event) => setSelectedInvitationIds(event.target.checked ? pendingVisibleIds : [])} /> Select visible pending</label><span>{selectionCount} selected</span><button type="button" disabled={!selectionCount || bulkResend.isPending || bulkRevoke.isPending} onClick={() => bulkResend.mutate(selectedInvitationIds)}>Resend selected</button><button type="button" className="invitation-revoke" disabled={!selectionCount || bulkResend.isPending || bulkRevoke.isPending} onClick={() => setRevokeConfirmationIds(selectedInvitationIds)}>Revoke selected</button></div>{resend.isError || revoke.isError || bulkResend.isError || bulkRevoke.isError ? <p className="text-sm text-rose-300" role="alert">{readableError(resend.error ?? revoke.error ?? bulkResend.error ?? bulkRevoke.error)}</p> : null}{resend.isSuccess || bulkResend.isSuccess ? <p className="text-sm text-emerald-300" role="status">Refreshed invitation links were sent and prior links are no longer valid.</p> : null}{revoke.isSuccess || bulkRevoke.isSuccess ? <p className="text-sm text-emerald-300" role="status">Invitation links were revoked and can no longer be accepted.</p> : null}<p className="invitation-result-count" role="status">{visibleInvitations.length} of {invitations.data.invitations.length} invitations shown</p>{visibleInvitations.length ? <ul className="invitation-status-list">{visibleInvitations.map((entry) => <li key={entry.id}><label className="invitation-select">{entry.status === "pending" ? <input type="checkbox" checked={selectedInvitationIds.includes(entry.id)} onChange={() => toggleInvitation(entry.id)} aria-label={`Select ${entry.email}`} /> : null}</label><div><strong>{entry.email}</strong><span>{entry.role ?? "operator"} · sent {new Date(entry.createdAt).toLocaleDateString()} · expires {new Date(entry.expiresAt).toLocaleDateString()}</span></div><div className="invitation-row-actions"><span className={`invitation-status invitation-status-${entry.status}`}>{entry.status}</span>{entry.status === "pending" ? <><button type="button" onClick={() => resend.mutate(entry.id)} disabled={resend.isPending || revoke.isPending}>Resend</button><button type="button" className="invitation-revoke" onClick={() => setRevokeConfirmationIds([entry.id])} disabled={resend.isPending || revoke.isPending}>Revoke</button></> : null}</div></li>)}</ul> : <p className="text-sm text-slate-400">No invitations match these filters.</p>}</> : <p className="text-sm text-slate-400">No invitations have been sent from this tenant yet.</p>}</CardContent></Card>{revokeConfirmationIds ? <div className="lifecycle-modal-backdrop" role="presentation"><section className="lifecycle-modal" role="dialog" aria-modal="true" aria-labelledby="revoke-confirmation-title"><h2 id="revoke-confirmation-title">Revoke {revokeConfirmationIds.length === 1 ? "invitation" : `${revokeConfirmationIds.length} invitations`}?</h2><p>Recipients will no longer be able to use these acceptance links. This action cannot be undone; send a new invitation if access is still needed.</p><div><button type="button" onClick={() => setRevokeConfirmationIds(null)}>Cancel</button><button type="button" className="invitation-revoke" onClick={() => revokeConfirmationIds.length === 1 ? revoke.mutate(revokeConfirmationIds[0]) : bulkRevoke.mutate(revokeConfirmationIds)}>Revoke invitation{revokeConfirmationIds.length === 1 ? "" : "s"}</button></div></section></div> : null}</div></DashboardLayout>;
}
