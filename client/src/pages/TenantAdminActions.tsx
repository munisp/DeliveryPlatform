import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import "./account-lifecycle.css";

type Member = { id: number; email: string; name: string; role: "admin" | "operator" | "viewer"; updatedAt: string };
type NotificationPreferences = { roleUpdateEmail: boolean; presetOwnershipTransferEmail: boolean; updatedAt: string | null };
type NotificationDeliveryHistory = { id: string; recipientEmail: string | null; notificationType: "role_update" | "preset_ownership_transfer"; subject: string; deliveryStatus: "delivered" | "failed"; provider: string | null; providerMessageId: string | null; failureCode: string | null; sentAt: string };
type NotificationDeliveryRetention = { retentionDays: 30 | 90 | 180 | 365; updatedAt: string | null };
type ApiError = { error?: string };
type ExportStage = "idle" | "preparing" | "downloading" | "complete";

const ACTIVITY_COLUMNS = [
  ["invitation_id", "Invitation ID"],
  ["recipient_email", "Recipient email"],
  ["role", "Invited role"],
  ["status", "Status"],
  ["sent_at", "Sent at"],
  ["expires_at", "Expires at"],
  ["accepted_at", "Accepted at"],
  ["revoked_at", "Revoked at"],
] as const;

type ActivityColumn = typeof ACTIVITY_COLUMNS[number][0];

async function request<T>(path: string, body?: Record<string, unknown>) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({})) as T & ApiError;
  if (!response.ok) throw new Error(payload.error ?? "request_failed");
  return payload;
}

async function downloadInvitationActivity(
  filters: { status: string; startDate: string; endDate: string; columns: ActivityColumn[] },
  onDownloadReady: () => void,
) {
  const query = new URLSearchParams();
  if (filters.status !== "all") query.set("status", filters.status);
  if (filters.startDate) query.set("startDate", filters.startDate);
  if (filters.endDate) query.set("endDate", filters.endDate);
  query.set("columns", filters.columns.join(","));

  const response = await fetch(`/api/auth/invitations/activity.csv?${query.toString()}`, { credentials: "include" });
  if (!response.ok) throw new Error("invitation_activity_export_failed");
  const rowCount = Number(response.headers.get("X-Exported-Row-Count"));
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new Error("invitation_activity_export_count_unavailable");
  onDownloadReady();

  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "invitation-activity.csv";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return rowCount;
}

function deliveryHistoryQuery(filters: { status: string; startDate: string; endDate: string }) {
  const query = new URLSearchParams();
  if (filters.status !== "all") query.set("status", filters.status);
  if (filters.startDate) query.set("startDate", filters.startDate);
  if (filters.endDate) query.set("endDate", filters.endDate);
  return query.toString();
}

async function downloadDeliveryHistory(filters: { status: string; startDate: string; endDate: string }) {
  const response = await fetch(`/api/auth/tenant/notification-delivery-history.csv?${deliveryHistoryQuery(filters)}`, { credentials: "include" });
  if (!response.ok) throw new Error("notification_delivery_history_export_failed");
  const rowCount = Number(response.headers.get("X-Exported-Row-Count"));
  if (!Number.isSafeInteger(rowCount) || rowCount < 0) throw new Error("notification_delivery_history_export_count_unavailable");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "notification-delivery-history.csv";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return rowCount;
}

function EmailAlertPreview({ preferences, onClose }: { preferences: NotificationPreferences; onClose: () => void }) {
  const notices = [
    preferences.roleUpdateEmail ? {
      subject: "Member role updated in your tenant",
      body: "A tenant administrator changed a member’s role after the update was committed. Review the member directory if you need to confirm access.",
    } : null,
    preferences.presetOwnershipTransferEmail ? {
      subject: "Branding preset ownership transferred",
      body: "A tenant administrator transferred ownership of a saved branding preset. The current preset owner can now manage that preset.",
    } : null,
  ].filter(Boolean) as { subject: string; body: string }[];

  return <div className="lifecycle-modal-backdrop" role="presentation">
    <section className="lifecycle-modal notification-preview-modal" role="dialog" aria-modal="true" aria-labelledby="email-alert-preview-title">
      <p className="lifecycle-eyebrow">Sample notification</p>
      <h2 id="email-alert-preview-title">Preview email alerts</h2>
      <p>This preview reflects the selections currently shown on this page. It does not send email or save preference changes.</p>
      {notices.length ? <div className="notification-email-preview" aria-label="Sample email notifications">
        {notices.map((notice) => <article key={notice.subject}>
          <header><span>From</span><strong>DeliveryPlatform tenant administration</strong></header>
          <p className="notification-email-subject">Subject: {notice.subject}</p>
          <p>{notice.body}</p>
          <small>For security, live notifications do not include invitation tokens or branding image data.</small>
        </article>)}
      </div> : <div className="notification-preview-empty" role="status">Select at least one alert type to preview its sample notification.</div>}
      <div><button type="button" onClick={onClose}>Close preview</button></div>
    </section>
  </div>;
}

export default function TenantAdminActions() {
  const [selected, setSelected] = useState<number[]>([]);
  const [role, setRole] = useState<Member["role"]>("operator");
  const [roleConfirmationOpen, setRoleConfirmationOpen] = useState(false);
  const [activityStatus, setActivityStatus] = useState("all");
  const [activityStartDate, setActivityStartDate] = useState("");
  const [activityEndDate, setActivityEndDate] = useState("");
  const [activityColumns, setActivityColumns] = useState<ActivityColumn[]>(ACTIVITY_COLUMNS.map(([value]) => value));
  const [notificationDraft, setNotificationDraft] = useState<NotificationPreferences | null>(null);
  const [notificationPreviewOpen, setNotificationPreviewOpen] = useState(false);
  const [exportStage, setExportStage] = useState<ExportStage>("idle");
  const [exportToastVisible, setExportToastVisible] = useState(false);
  const [exportRowCount, setExportRowCount] = useState<number | null>(null);
  const [deliveryHistoryStatus, setDeliveryHistoryStatus] = useState("all");
  const [deliveryHistoryStartDate, setDeliveryHistoryStartDate] = useState("");
  const [deliveryHistoryEndDate, setDeliveryHistoryEndDate] = useState("");
  const [deliveryHistoryExportRowCount, setDeliveryHistoryExportRowCount] = useState<number | null>(null);
  const [deliveryHistoryExportToastVisible, setDeliveryHistoryExportToastVisible] = useState(false);
  const [deliveryRetentionDraft, setDeliveryRetentionDraft] = useState<NotificationDeliveryRetention["retentionDays"] | null>(null);
  const [retentionConfirmationOpen, setRetentionConfirmationOpen] = useState(false);

  const members = useQuery({ queryKey: ["tenant-members"], queryFn: () => request<{ members: Member[] }>("/api/auth/members") });
  const preferences = useQuery({ queryKey: ["tenant-admin-notification-preferences"], queryFn: () => request<NotificationPreferences>("/api/auth/tenant/notification-preferences") });
  const deliveryHistory = useQuery({ queryKey: ["tenant-admin-notification-delivery-history", deliveryHistoryStatus, deliveryHistoryStartDate, deliveryHistoryEndDate], queryFn: () => request<{ history: NotificationDeliveryHistory[] }>(`/api/auth/tenant/notification-delivery-history?${deliveryHistoryQuery({ status: deliveryHistoryStatus, startDate: deliveryHistoryStartDate, endDate: deliveryHistoryEndDate })}`) });
  const deliveryRetention = useQuery({ queryKey: ["tenant-admin-notification-delivery-retention"], queryFn: () => request<NotificationDeliveryRetention>("/api/auth/tenant/notification-delivery-retention") });
  const selectedMembers = useMemo(() => members.data?.members.filter((member) => selected.includes(member.id)) ?? [], [members.data?.members, selected]);
  const activePreferences = preferences.data ?? { roleUpdateEmail: false, presetOwnershipTransferEmail: false, updatedAt: null };
  const currentPreferences = notificationDraft ?? activePreferences;
  const notificationPreferencesChanged = currentPreferences.roleUpdateEmail !== activePreferences.roleUpdateEmail || currentPreferences.presetOwnershipTransferEmail !== activePreferences.presetOwnershipTransferEmail;
  const selectable = members.data?.members.filter((member) => member.role !== "admin") ?? [];
  const invalidDateRange = Boolean(activityStartDate && activityEndDate && activityStartDate > activityEndDate);
  const invalidDeliveryHistoryDateRange = Boolean(deliveryHistoryStartDate && deliveryHistoryEndDate && deliveryHistoryStartDate > deliveryHistoryEndDate);
  const currentDeliveryRetentionDays = deliveryRetentionDraft ?? deliveryRetention.data?.retentionDays ?? 365;
  const deliveryRetentionChanged = Boolean(deliveryRetention.data && currentDeliveryRetentionDays !== deliveryRetention.data.retentionDays);
  const exportProgressLabel = exportStage === "downloading" ? "Generating file and starting the download" : "Preparing the invitation activity export";

  const changeRoles = useMutation({
    mutationFn: () => request<{ changed: number; role: Member["role"]; notificationDelivery: string }>("/api/auth/members/actions/bulk/role", { memberIds: selected, role }),
    onSuccess: () => { setSelected([]); members.refetch(); },
  });
  const exportCsv = useMutation({
    mutationFn: async () => {
      setExportStage("preparing");
      return downloadInvitationActivity(
        { status: activityStatus, startDate: activityStartDate, endDate: activityEndDate, columns: activityColumns },
        () => setExportStage("downloading"),
      );
    },
    onSuccess: (rowCount) => {
      setExportStage("complete");
      setExportRowCount(rowCount);
      setExportToastVisible(true);
      window.setTimeout(() => setExportToastVisible(false), 6000);
    },
    onMutate: () => { setExportRowCount(null); setExportToastVisible(false); },
    onError: () => setExportStage("idle"),
  });
  const updatePreferences = useMutation({
    mutationFn: (next: NotificationPreferences) => request<NotificationPreferences>("/api/auth/tenant/notification-preferences", {
      roleUpdateEmail: next.roleUpdateEmail,
      presetOwnershipTransferEmail: next.presetOwnershipTransferEmail,
    }),
    onSuccess: () => { setNotificationDraft(null); preferences.refetch(); },
  });
  const exportDeliveryHistory = useMutation({
    mutationFn: () => downloadDeliveryHistory({ status: deliveryHistoryStatus, startDate: deliveryHistoryStartDate, endDate: deliveryHistoryEndDate }),
    onMutate: () => { setDeliveryHistoryExportRowCount(null); setDeliveryHistoryExportToastVisible(false); },
    onSuccess: (rowCount) => { setDeliveryHistoryExportRowCount(rowCount); setDeliveryHistoryExportToastVisible(true); window.setTimeout(() => setDeliveryHistoryExportToastVisible(false), 6000); },
  });
  const updateDeliveryRetention = useMutation({
    mutationFn: (retentionDays: NotificationDeliveryRetention["retentionDays"]) => request<NotificationDeliveryRetention & { pruned: number }>("/api/auth/tenant/notification-delivery-retention", { retentionDays }),
    onSuccess: () => { setDeliveryRetentionDraft(null); setRetentionConfirmationOpen(false); deliveryRetention.refetch(); deliveryHistory.refetch(); },
  });

  const toggleMember = (id: number) => setSelected((ids) => ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id]);
  const toggleColumn = (column: ActivityColumn) => setActivityColumns((columns) => columns.includes(column) ? columns.filter((value) => value !== column) : [...columns, column]);
  const updateNotificationDraft = (partial: Partial<NotificationPreferences>) => setNotificationDraft({ ...currentPreferences, ...partial });

  return <DashboardLayout>
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Tenant administration</p>
        <h1 className="mt-2 text-3xl font-semibold text-white">Manage roles and reporting</h1>
        <p className="mt-2 text-slate-400">Change up to 10 non-administrator member roles at once, configure operational alerts, and export only the invitation data required for a report.</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Bulk member role change</CardTitle><CardDescription>Select active members, choose a role, and review the impact before the bounded update.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          {members.isLoading ? <p className="text-sm text-slate-400">Loading members…</p> : members.isError ? <p className="text-sm text-rose-300">Member roles are unavailable.</p> : <>
            <div className="flex flex-wrap items-end gap-3">
              <label className="grid gap-2 text-sm text-slate-200"><span>New role</span><select value={role} onChange={(event) => setRole(event.target.value as Member["role"])} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"><option value="operator">Operator</option><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label>
              <button type="button" onClick={() => setRoleConfirmationOpen(true)} disabled={!selected.length || changeRoles.isPending} className="rounded-xl bg-cyan-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50">Review {selected.length} selected</button>
              <span className="text-sm text-slate-400">{selected.length} of 10 selected</span>
            </div>
            <ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">{members.data?.members.map((member) => <li key={member.id} className="flex items-center gap-3 px-4 py-3"><input type="checkbox" checked={selected.includes(member.id)} disabled={member.role === "admin" || !selectable.some((candidate) => candidate.id === member.id)} onChange={() => toggleMember(member.id)} aria-label={`Select ${member.email}`} /><div className="min-w-0 flex-1"><strong className="block truncate text-slate-100">{member.name}</strong><span className="text-sm text-slate-400">{member.email}</span></div><span className="rounded-full border border-slate-700 px-2 py-1 text-xs text-slate-300">{member.role}</span></li>)}</ul>
          </>}
          {changeRoles.isSuccess ? <p role="status" className="text-sm text-emerald-300">Updated {changeRoles.data.changed} member role{changeRoles.data.changed === 1 ? "" : "s"} to {changeRoles.data.role}. Email alerts: {changeRoles.data.notificationDelivery.replace("_", " ")}.</p> : null}
          {changeRoles.isError ? <p role="alert" className="text-sm text-rose-300">Role update could not be completed. Check administrator protections and try again.</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Invitation activity export</CardTitle><CardDescription>Download a bounded tenant-scoped activity window and select only the fields needed for this report. Values are safely serialized for spreadsheet tools.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3">
            <label className="grid gap-2 text-sm text-slate-200"><span>Status</span><select value={activityStatus} onChange={(event) => setActivityStatus(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"><option value="all">All statuses</option><option value="pending">Pending</option><option value="accepted">Accepted</option><option value="expired">Expired</option><option value="revoked">Revoked</option></select></label>
            <label className="grid gap-2 text-sm text-slate-200"><span>From</span><input type="date" value={activityStartDate} onChange={(event) => setActivityStartDate(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" /></label>
            <label className="grid gap-2 text-sm text-slate-200"><span>To</span><input type="date" value={activityEndDate} onChange={(event) => setActivityEndDate(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" /></label>
          </div>
          <fieldset className="rounded-xl border border-slate-800 p-3"><legend className="px-1 text-sm font-medium text-slate-200">CSV columns</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">{ACTIVITY_COLUMNS.map(([column, label]) => <label key={column} className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={activityColumns.includes(column)} onChange={() => toggleColumn(column)} />{label}</label>)}</div></fieldset>
          <button type="button" onClick={() => exportCsv.mutate()} disabled={exportCsv.isPending || invalidDateRange || !activityColumns.length} className="rounded-xl border border-cyan-400/40 bg-cyan-500/10 px-4 py-2 font-medium text-cyan-100 disabled:opacity-50">{exportCsv.isPending ? "Preparing export…" : "Download invitation activity CSV"}</button>
          {exportCsv.isPending ? <div className="rounded-xl border border-cyan-400/30 bg-cyan-500/10 p-3 text-sm text-cyan-100" role="progressbar" aria-label="Invitation activity export progress" aria-valuetext={exportProgressLabel} aria-busy="true"><div className="flex items-center justify-between gap-3"><span>{exportProgressLabel}</span><span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-cyan-200" /></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800"><span className="block h-full w-2/3 rounded-full bg-cyan-300" /></div></div> : null}
          {invalidDateRange ? <p role="alert" className="text-sm text-rose-300">The start date must be before the end date.</p> : null}
          {!activityColumns.length ? <p role="alert" className="text-sm text-rose-300">Select at least one CSV column.</p> : null}
          {exportCsv.isError ? <p role="alert" className="text-sm text-rose-300">The activity export is unavailable. Try a maximum one-year range.</p> : null}
          {exportCsv.isSuccess ? <p role="status" className="text-sm text-emerald-300">Invitation activity CSV downloaded.</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Email alert preferences</CardTitle><CardDescription>Choose tenant-admin alerts, preview their safe contents, then save. Live alerts are sent only after successful committed changes and never include invitation tokens or branding image data.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          {preferences.isLoading ? <p className="text-sm text-slate-400">Loading notification preferences…</p> : <>
            <label className="flex items-start gap-3 text-sm text-slate-200"><input type="checkbox" checked={currentPreferences.roleUpdateEmail} disabled={updatePreferences.isPending} onChange={(event) => updateNotificationDraft({ roleUpdateEmail: event.target.checked })} /><span><strong className="block">Member role updates</strong><small className="text-slate-400">Email me when another administrator updates tenant member roles.</small></span></label>
            <label className="flex items-start gap-3 text-sm text-slate-200"><input type="checkbox" checked={currentPreferences.presetOwnershipTransferEmail} disabled={updatePreferences.isPending} onChange={(event) => updateNotificationDraft({ presetOwnershipTransferEmail: event.target.checked })} /><span><strong className="block">Preset ownership transfers</strong><small className="text-slate-400">Email me when another administrator transfers a branding preset.</small></span></label>
            <div className="flex flex-wrap gap-3"><button type="button" onClick={() => setNotificationPreviewOpen(true)} className="rounded-xl border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-100">Preview sample notification</button><button type="button" onClick={() => updatePreferences.mutate(currentPreferences)} disabled={!notificationPreferencesChanged || updatePreferences.isPending} className="rounded-xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">{updatePreferences.isPending ? "Saving preferences…" : "Save notification preferences"}</button></div>
          </>}
          {updatePreferences.isSuccess ? <p role="status" className="text-sm text-emerald-300">Notification preferences saved.</p> : null}
          {updatePreferences.isError ? <p role="alert" className="text-sm text-rose-300">Preferences could not be saved.</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Email alert delivery history</CardTitle><CardDescription>Find committed tenant-scoped delivery attempts, download the filtered log, and retain only the metadata your operating policy requires. Message bodies and invitation tokens are never retained here.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-3"><label className="grid gap-2 text-sm text-slate-200"><span>Delivery status</span><select value={deliveryHistoryStatus} onChange={(event) => setDeliveryHistoryStatus(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"><option value="all">All outcomes</option><option value="delivered">Delivered</option><option value="failed">Failed</option></select></label><label className="grid gap-2 text-sm text-slate-200"><span>From</span><input type="date" value={deliveryHistoryStartDate} onChange={(event) => setDeliveryHistoryStartDate(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" /></label><label className="grid gap-2 text-sm text-slate-200"><span>To</span><input type="date" value={deliveryHistoryEndDate} onChange={(event) => setDeliveryHistoryEndDate(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" /></label></div>
          {invalidDeliveryHistoryDateRange ? <p role="alert" className="text-sm text-rose-300">The delivery-history start date must be before the end date.</p> : null}
          <div className="flex flex-wrap gap-3"><button type="button" onClick={() => exportDeliveryHistory.mutate()} disabled={exportDeliveryHistory.isPending || invalidDeliveryHistoryDateRange} className="rounded-xl border border-cyan-400/40 bg-cyan-500/10 px-4 py-2 text-sm font-semibold text-cyan-100 disabled:opacity-50">{exportDeliveryHistory.isPending ? "Preparing delivery log…" : "Download delivery history CSV"}</button><button type="button" onClick={() => deliveryHistory.refetch()} disabled={deliveryHistory.isFetching} className="rounded-xl border border-slate-600 px-3 py-2 text-sm font-semibold text-slate-100 disabled:opacity-50">{deliveryHistory.isFetching ? "Refreshing history…" : "Refresh delivery history"}</button></div>
          {exportDeliveryHistory.isError ? <p role="alert" className="text-sm text-rose-300">The delivery-history export is unavailable. Try a maximum one-year range.</p> : null}
          {deliveryHistory.isLoading ? <p className="text-sm text-slate-400">Loading delivery history…</p> : deliveryHistory.isError ? <p role="alert" className="text-sm text-rose-300">Delivery history is unavailable. Refresh and try again.</p> : deliveryHistory.data?.history.length ? <ul className="tenant-preset-list">{deliveryHistory.data.history.map((entry) => <li key={entry.id}><div><strong>{entry.subject}</strong><small>{entry.recipientEmail ?? "Former tenant administrator"} · {entry.notificationType === "role_update" ? "Role update" : "Preset ownership transfer"} · {new Date(entry.sentAt).toLocaleString()}</small>{entry.deliveryStatus === "failed" ? <small className="text-rose-300">Delivery failed: {entry.failureCode ?? "notification_dispatch_failed"}</small> : <small className="text-emerald-300">Delivered{entry.provider ? ` via ${entry.provider}` : ""}</small>}</div><span className={`invitation-status invitation-status-${entry.deliveryStatus === "delivered" ? "accepted" : "revoked"}`}>{entry.deliveryStatus}</span></li>)}</ul> : <p className="text-sm text-slate-400">No tenant-admin alerts match this filter.</p>}
          <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4"><h3 className="text-sm font-semibold text-slate-100">Delivery metadata retention</h3><p className="mt-1 text-sm text-slate-400">Changing this setting permanently prunes this tenant’s delivery metadata older than the selected window.</p>{deliveryRetention.isLoading ? <p className="mt-2 text-sm text-slate-400">Loading retention settings…</p> : deliveryRetention.isError ? <p role="alert" className="mt-2 text-sm text-rose-300">Retention settings are unavailable.</p> : <div className="mt-3 flex flex-wrap items-end gap-3"><label className="grid gap-2 text-sm text-slate-200"><span>Keep delivery metadata for</span><select value={currentDeliveryRetentionDays} disabled={updateDeliveryRetention.isPending} onChange={(event) => setDeliveryRetentionDraft(Number(event.target.value) as NotificationDeliveryRetention["retentionDays"])} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"><option value="30">30 days</option><option value="90">90 days</option><option value="180">180 days</option><option value="365">365 days</option></select></label><button type="button" onClick={() => setRetentionConfirmationOpen(true)} disabled={!deliveryRetentionChanged || updateDeliveryRetention.isPending} className="rounded-xl bg-cyan-400 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-50">Save retention setting</button>{updateDeliveryRetention.isSuccess ? <p role="status" className="text-sm text-emerald-300">Retention saved. {updateDeliveryRetention.data.pruned} historical record{updateDeliveryRetention.data.pruned === 1 ? "" : "s"} pruned.</p> : null}{updateDeliveryRetention.isError ? <p role="alert" className="text-sm text-rose-300">Retention setting could not be saved.</p> : null}</div>}</div>
        </CardContent>
      </Card>

      {roleConfirmationOpen ? <div className="lifecycle-modal-backdrop" role="presentation"><section className="lifecycle-modal" role="dialog" aria-modal="true" aria-labelledby="role-confirmation-title"><h2 id="role-confirmation-title">Update {selected.length} member role{selected.length === 1 ? "" : "s"}?</h2><p>The selected members will become <strong>{role}</strong>. This may change what they can access in the tenant. Your own role and the final tenant administrator remain protected.</p>{selectedMembers.length ? <ul className="mt-3 list-disc pl-5 text-sm text-slate-300">{selectedMembers.map((member) => <li key={member.id}>{member.email}</li>)}</ul> : null}<div><button type="button" onClick={() => setRoleConfirmationOpen(false)}>Cancel</button><button type="button" className="invitation-revoke" onClick={() => { setRoleConfirmationOpen(false); changeRoles.mutate(); }}>Confirm role change</button></div></section></div> : null}
      {retentionConfirmationOpen ? <div className="lifecycle-modal-backdrop" role="presentation"><section className="lifecycle-modal" role="dialog" aria-modal="true" aria-labelledby="retention-confirmation-title"><h2 id="retention-confirmation-title">Apply {currentDeliveryRetentionDays}-day retention?</h2><p>Delivery-history metadata older than {currentDeliveryRetentionDays} days will be permanently deleted for this tenant. Alert message bodies and invitation tokens are never stored in this history.</p><div><button type="button" onClick={() => setRetentionConfirmationOpen(false)}>Cancel</button><button type="button" className="invitation-revoke" disabled={updateDeliveryRetention.isPending} onClick={() => updateDeliveryRetention.mutate(currentDeliveryRetentionDays)}>Confirm retention change</button></div></section></div> : null}
      {notificationPreviewOpen ? <EmailAlertPreview preferences={currentPreferences} onClose={() => setNotificationPreviewOpen(false)} /> : null}
      {exportToastVisible && exportRowCount !== null ? <div className="fixed bottom-6 right-6 z-50 flex max-w-sm items-start gap-3 rounded-xl border border-emerald-400/40 bg-slate-950 px-4 py-3 text-sm text-emerald-100 shadow-2xl" role="status" aria-live="polite"><span className="font-semibold">Invitation activity CSV downloaded with {exportRowCount} {exportRowCount === 1 ? "row" : "rows"}.</span><button type="button" onClick={() => setExportToastVisible(false)} className="text-emerald-200 underline underline-offset-2">Dismiss</button></div> : null}
      {deliveryHistoryExportToastVisible && deliveryHistoryExportRowCount !== null ? <div className="fixed bottom-6 right-6 z-50 flex max-w-sm items-start gap-3 rounded-xl border border-emerald-400/40 bg-slate-950 px-4 py-3 text-sm text-emerald-100 shadow-2xl" role="status" aria-live="polite"><span className="font-semibold">Delivery-history CSV downloaded with {deliveryHistoryExportRowCount} {deliveryHistoryExportRowCount === 1 ? "row" : "rows"}.</span><button type="button" onClick={() => setDeliveryHistoryExportToastVisible(false)} className="text-emerald-200 underline underline-offset-2">Dismiss</button></div> : null}
    </div>
  </DashboardLayout>;
}
