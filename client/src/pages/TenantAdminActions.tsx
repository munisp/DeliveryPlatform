import { useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Member = { id: number; email: string; name: string; role: "admin" | "operator" | "viewer"; updatedAt: string };
type ApiError = { error?: string };

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

async function downloadInvitationActivity() {
  const response = await fetch("/api/auth/invitations/activity.csv", { credentials: "include" });
  if (!response.ok) throw new Error("invitation_activity_export_failed");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "invitation-activity.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function TenantAdminActions() {
  const [selected, setSelected] = useState<number[]>([]);
  const [role, setRole] = useState<Member["role"]>("operator");
  const members = useQuery({ queryKey: ["tenant-members"], queryFn: () => request<{ members: Member[] }>("/api/auth/members") });
  const selectedMembers = useMemo(() => members.data?.members.filter((member) => selected.includes(member.id)) ?? [], [members.data?.members, selected]);
  const changeRoles = useMutation({ mutationFn: () => request<{ changed: number; role: Member["role"] }>("/api/auth/members/actions/bulk/role", { memberIds: selected, role }), onSuccess: () => { setSelected([]); members.refetch(); } });
  const exportCsv = useMutation({ mutationFn: downloadInvitationActivity });
  const toggleMember = (id: number) => setSelected((ids) => ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id]);
  const selectable = members.data?.members.filter((member) => member.role !== "admin") ?? [];

  return <DashboardLayout><div className="mx-auto max-w-4xl space-y-6"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-300">Tenant administration</p><h1 className="mt-2 text-3xl font-semibold text-white">Manage roles and reporting</h1><p className="mt-2 text-slate-400">Change up to 10 non-administrator member roles at once. Your own role and the final tenant administrator are protected by the server.</p></div><Card><CardHeader><CardTitle>Bulk member role change</CardTitle><CardDescription>Select active members, choose a role, and confirm the bounded update.</CardDescription></CardHeader><CardContent className="space-y-4">{members.isLoading ? <p className="text-sm text-slate-400">Loading members…</p> : members.isError ? <p className="text-sm text-rose-300">Member roles are unavailable.</p> : <><div className="flex flex-wrap items-end gap-3"><label className="grid gap-2 text-sm text-slate-200"><span>New role</span><select value={role} onChange={(event) => setRole(event.target.value as Member["role"])} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2"><option value="operator">Operator</option><option value="viewer">Viewer</option><option value="admin">Administrator</option></select></label><button type="button" onClick={() => changeRoles.mutate()} disabled={!selected.length || changeRoles.isPending} className="rounded-xl bg-cyan-400 px-4 py-2 font-semibold text-slate-950 disabled:opacity-50">Update {selected.length} selected</button><span className="text-sm text-slate-400">{selected.length} of 10 selected</span></div><ul className="divide-y divide-slate-800 rounded-xl border border-slate-800">{members.data?.members.map((member) => <li key={member.id} className="flex items-center gap-3 px-4 py-3"><input type="checkbox" checked={selected.includes(member.id)} disabled={member.role === "admin" || !selectable.some((candidate) => candidate.id === member.id)} onChange={() => toggleMember(member.id)} aria-label={`Select ${member.email}`} /><div className="min-w-0 flex-1"><strong className="block truncate text-slate-100">{member.name}</strong><span className="text-sm text-slate-400">{member.email}</span></div><span className="rounded-full border border-slate-700 px-2 py-1 text-xs text-slate-300">{member.role}</span></li>)}</ul></>}{changeRoles.isSuccess ? <p role="status" className="text-sm text-emerald-300">Updated {changeRoles.data.changed} member role{changeRoles.data.changed === 1 ? "" : "s"} to {changeRoles.data.role}.</p> : null}{changeRoles.isError ? <p role="alert" className="text-sm text-rose-300">Role update could not be completed. Check administrator protections and try again.</p> : null}</CardContent></Card><Card><CardHeader><CardTitle>Invitation activity export</CardTitle><CardDescription>Download tenant-scoped invitation statuses for reporting. Values are safely serialized for spreadsheet tools.</CardDescription></CardHeader><CardContent><button type="button" onClick={() => exportCsv.mutate()} disabled={exportCsv.isPending} className="rounded-xl border border-cyan-400/40 bg-cyan-500/10 px-4 py-2 font-medium text-cyan-100 disabled:opacity-50">{exportCsv.isPending ? "Preparing export…" : "Download invitation activity CSV"}</button>{exportCsv.isError ? <p role="alert" className="mt-3 text-sm text-rose-300">The activity export is unavailable. Try again shortly.</p> : null}{exportCsv.isSuccess ? <p role="status" className="mt-3 text-sm text-emerald-300">Invitation activity CSV downloaded.</p> : null}</CardContent></Card></div></DashboardLayout>;
}
