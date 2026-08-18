import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Member = { id: number; email: string; name: string; role: "admin" | "operator" | "viewer"; updatedAt: string };
type NotificationPreferences = { roleUpdateEmail: boolean; presetOwnershipTransferEmail: boolean; updatedAt: string | null };
type ApiError = { error?: string };

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

async function downloadInvitationActivity(filters: { status: string; startDate: string; endDate: string; columns: ActivityColumn[] }) {
  const query = new URLSearchParams();
  if (filters.status !== "all") query.set("status", filters.status);
  if (filters.startDate) query.set("startDate", filters.startDate);
  if (filters.endDate) query.set("endDate", filters.endDate);
  query.set("columns", filters.columns.join(","));
  const response = await fetch(`/api/auth/invitations/activity.csv?${query.toString()}`, { credentials: "include" });
  if (!response.ok) throw new Error("invitation_activity_export_failed");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "invitation-activity.csv";
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function TenantAdminActions() {
  const [selected, setSelected] = useState<number[]>([]);
  const [role, setRole] = useState<Member["role"]>("operator");
  const [roleConfirmationOpen, setRoleConfirmationOpen] = useState(false);
  const [activityStatus, setActivityStatus] = useState("all");
  const [activityStartDate, setActivityStartDate] = useState("");
  const [activityEndDate, setActivityEndDate] = useState("");
  const [activityColumns, setActivityColumns] = useState<ActivityColumn[]>(ACTIVITY_COLUMNS.map(([value]) => value));
  const members = useQuery({ queryKey: ["tenant-members"], queryFn: () => request<{ members: Member[] }>("/api/auth/members") });
  const preferences = useQuery({ queryKey: ["tenant-admin-notification-preferences"], queryFn: () => request<NotificationPreferences>("/api/auth/tenant/notification-preferences") });
  const selectedMembers = useMemo(() => members.data?.members.filter((member) => selected.includes(member.id)) ?? [], [members.data?.members, selected]);
  const changeRoles = useMutation({ mutationFn: () => request<{ changed: number; role: Member["role"]; notificationDelivery: string }>("/api/auth/members/actions/bulk/role", { memberIds: selected, role }), onSuccess: () => { setSelected([]); members.refetch(); } });
  const exportCsv = useMutation({ mutationFn: () => downloadInvitationActivity({ status: activityStatus, startDate: activityStartDate, endDate: activityEndDate, columns: activityColumns }) });
  const updatePreferences = useMutation({ mutationFn: (next: NotificationPreferences) => request<NotificationPreferences>("/api/auth/tenant/notification-preferences", { roleUpdateEmail: next.roleUpdateEmail, presetOwnershipTransferEmail: next.presetOwnershipTransferEmail }), onSuccess: () => preferences.refetch() });
  const toggleMember = (id: number) => setSelected((ids) => ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id]);
  const toggleColumn = (column: ActivityColumn) => setActivityColumns((columns) => columns.includes(column) ? columns.filter((value) => value !== column) : [...columns, column]);
  const selectable = members.data?.members.filter((member) => member.role !== "admin") ?? [];
  const activePreferences = preferences.data ?? { roleUpdateEmail: false, presetOwnershipTransferEmail: false, updatedAt: null };
  const invalidDateRange = Boolean(activityStartDate && activityEndDate && activityStartDate > activityEndDate);

  return <DashboardLayout><div className="mx-auto max-w-4xl space-y-6"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Tenant administration</p><h1 className="mt-2 text-3xl font-semibold text-white">Manage roles and reporting</h1><p className="mt-2 text-slate-400">Change up to 10 non-administrator member roles at once, configure operational alerts, and export only the invitation data required for a report.</p></div><Card><CardHeader><CardTitle>Bulk member role change</CardTitle><CardDescription>Select active members, choose a role, and review the impact before the bounded update.</CardDescription></CardHeader><CardContent className="space-y-4">{members.isLoading ? <p className="text-sm text-slate-400">Loading members…</p> : members.isError ? <p className="text-sm text-rose-300">Member roles are unavailable.</p> : <><div className="flex flex-wrap items-end gap-3"><label className="grid gap-2 text-sm text-slate-200"><span>New role</span><select value={role} onChange={(event) => setRole(event.target.value as Member["role"])} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"><option value="operator">Operator</option><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label><button type="button" onClick={() => setRoleConfirmationOpen(true)} disabled={!selected.length || changeRoles.isPending} className="rounded-xl bg-cyan-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50">Review {selected.length} selected</button><span className="text-sm text-slate-400">{selected.length} of 10 selected</span></div><ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">{members.data?.members.map((member) => <li key={member.id} className="flex items-center gap-3 px-4 py-3"><input type="checkbox" checked={selected.includes(member.id)} disabled={member.role === "admin" || !selectable.some((candidate) => candidate.id === member.id)} onChange={() => toggleMember(member.id)} aria-label={`Select ${member.email}`} /><div className="min-w-0 flex-1"><strong className="block truncate text-slate-100">{member.name}</strong><span className="text-sm text-slate-400">{member.email}</span></div><span className="rounded-full border border-slate-700 px-2 py-1 text-xs text-slate-300">{member.role}</span></li>)}</ul></>}{changeRoles.isSuccess ? <p role="status" className="text-sm text-emerald-300">Updated {changeRoles.data.changed} member role{changeRoles.data.changed === 1 ? "" : "s"} to {changeRoles.data.role}. Email alerts: {changeRoles.data.notificationDelivery.replace("_", " ")}.</p> : null}{changeRoles.isError ? <p role="alert" className="text-sm text-rose-300">Role update could not be completed. Check administrator protections and try again.</p> : null}</CardContent></Card><Card><CardHeader><CardTitle>Invitation activity export</CardTitle><CardDescription>Download a bounded tenant-scoped activity window and select only the fields needed for this report. Values are safely serialized for spreadsheet tools.</CardDescription></CardHeader><CardContent className="space-y-4"><div className="flex flex-wrap gap-3"><label className="grid gap-2 text-sm text-slate-200"><span>Status</span><select value={activityStatus} onChange={(event) => setActivityStatus(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"><option value="all">All statuses</option><option value="pending">Pending</option><option value="accepted">Accepted</option><option value="expired">Expired</option><option value="revoked">Revoked</option></select></label><label className="grid gap-2 text-sm text-slate-200"><span>From</span><input type="date" value={activityStartDate} onChange={(event) => setActivityStartDate(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" /></label><label className="grid gap-2 text-sm text-slate-200"><span>To</span><input type="date" value={activityEndDate} onChange={(event) => setActivityEndDate(event.target.value)} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" /></label></div><fieldset className="rounded-xl border border-slate-800 p-3"><legend className="px-1 text-sm font-medium text-slate-200">CSV columns</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">{ACTIVITY_COLUMNS.map(([column, label]) => <label key={column} className="flex items-center gap-2 text-sm text-slate-300"><input type="checkbox" checked={activityColumns.includes(column)} onChange={() => toggleColumn(column)} />{label}</label>)}</div></fieldset><button type="button" onClick={() => exportCsv.mutate()} disabled={exportCsv.isPending || invalidDateRange || !activityColumns.length} className="rounded-xl border border-cyan-400/40 bg-cyan-500/10 px-4 py-2 font-medium text-cyan-100 disabled:opacity-50">{exportCsv.isPending ? "Preparing export…" : "Download invitation activity CSV"}</button>{invalidDateRange ? <p role="alert" className="text-sm text-rose-300">The start date must be before the end date.</p> : null}{!activityColumns.length ? <p role="alert" className="text-sm text-rose-300">Select at least one CSV column.</p> : null}{exportCsv.isError ? <p role="alert" className="text-sm text-rose-300">The activity export is unavailable. Try a maximum one-year range.</p> : null}{exportCsv.isSuccess ? <p role="status" className="text-sm text-emerald-300">Invitation activity CSV downloaded.</p> : null}</CardContent></Card><Card><CardHeader><CardTitle>Email alert preferences</CardTitle><CardDescription>Opt in to tenant-admin alerts. Alerts are sent after a successful committed change and never include invitation tokens or branding image data.</CardDescription></CardHeader><CardContent className="space-y-3">{preferences.isLoading ? <p className="text-sm text-slate-400">Loading notification preferences…</p> : <><label className="flex items-start gap-3 text-sm text-slate-200"><input type="checkbox" checked={activePreferences.roleUpdateEmail} disabled={updatePreferences.isPending} onChange={(event) => updatePreferences.mutate({ ...activePreferences, roleUpdateEmail: event.target.checked })} /><span><strong className="block">Member role updates</strong><small className="text-slate-400">Email me when another administrator updates tenant member roles.</small></span></label><label className="flex items-start gap-3 text-sm text-slate-200"><input type="checkbox" checked={activePreferences.presetOwnershipTransferEmail} disabled={updatePreferences.isPending} onChange={(event) => updatePreferences.mutate({ ...activePreferences, presetOwnershipTransferEmail: event.target.checked })} /><span><strong className="block">Preset ownership transfers</strong><small className="text-slate-400">Email me when another administrator transfers a branding preset.</small></span></label></>}{updatePreferences.isSuccess ? <p role="status" className="text-sm text-emerald-300">Notification preferences saved.</p> : null}{updatePreferences.isError ? <p role="alert" className="text-sm text-rose-300">Preferences could not be saved.</p> : null}</CardContent></Card>{roleConfirmationOpen ? <div className="lifecycle-modal-backdrop" role="presentation"><section className="lifecycle-modal" role="dialog" aria-modal="true" aria-labelledby="role-confirmation-title"><h2 id="role-confirmation-title">Update {selected.length} member role{selected.length === 1 ? "" : "s"}?</h2><p>The selected members will become <strong>{role}</strong>. This may change what they can access in the tenant. Your own role and the final tenant administrator remain protected.</p>{selectedMembers.length ? <ul className="mt-3 list-disc pl-5 text-sm text-slate-300">{selectedMembers.map((member) => <li key={member.id}>{member.email}</li>)}</ul> : null}<div><button type="button" onClick={() => setRoleConfirmationOpen(false)}>Cancel</button><button type="button" className="invitation-revoke" onClick={() => { setRoleConfirmationOpen(false); changeRoles.mutate(); }}>Confirm role change</button></div></section></div> : null}</div></DashboardLayout>;
}
