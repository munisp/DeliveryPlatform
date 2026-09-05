import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useState } from "react";

type Zone = { id: string; code: string; display_name: string; active: boolean; dispatch_enabled: boolean };
type WorkOrder = { id: string; external_reference: string; title: string; state: string; priority: number; zone_name: string | null; assignee_user_id: number | null; updated_at: string };
type Event = { id: string; event_type: string; previous_state: string | null; next_state: string | null; created_at: string; external_reference: string };
type Subscription = { id: string; display_name: string; endpoint_url: string; event_types: string[]; active: boolean };
type Workflow = { id: string; workflow_code: string; version: number; display_name: string; state: string; policy_version: string; published_at: string | null };
type Geofence = { id: string; code: string; display_name: string; active: boolean; dwell_threshold_seconds: number };
type Position = { work_order_id: string; external_reference: string; subject_user_id: number | null; observed_at: string; longitude: number; latitude: number; accuracy_m: number | null; integrity_score: number; source: string };
type Snapshot = { zones: Zone[]; orders: WorkOrder[]; events: Event[]; subscriptions: Subscription[]; workflows: Workflow[]; geofences: Geofence[]; positions: Position[] };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: "include", cache: "no-store", headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: "request_failed" }));
    throw new Error(body.error ?? "request_failed");
  }
  return response.json() as Promise<T>;
}

function stateClass(state: string) {
  if (state === "completed") return "border-emerald-400/30 bg-emerald-500/10 text-emerald-100";
  if (state === "failed" || state === "cancelled") return "border-rose-400/30 bg-rose-500/10 text-rose-100";
  if (state === "in_progress" || state === "allocated") return "border-cyan-400/30 bg-cyan-500/10 text-cyan-100";
  return "border-slate-600 bg-slate-800/60 text-slate-200";
}

export default function LogisticsOperations() {
  const client = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [zoneCode, setZoneCode] = useState("LAG-IKOYI");
  const [zoneName, setZoneName] = useState("Ikoyi pilot zone");
  const [reference, setReference] = useState("");
  const [title, setTitle] = useState("");
  const [pickupAddress, setPickupAddress] = useState("");
  const [dropoffAddress, setDropoffAddress] = useState("");
  const [pickupLatitude, setPickupLatitude] = useState("6.455");
  const [pickupLongitude, setPickupLongitude] = useState("3.395");
  const [dropoffLatitude, setDropoffLatitude] = useState("6.480");
  const [dropoffLongitude, setDropoffLongitude] = useState("3.410");
  const [workflowCode, setWorkflowCode] = useState("LAGOS_STANDARD_DELIVERY");
  const [workflowName, setWorkflowName] = useState("Lagos standard delivery");
  const [policyVersion, setPolicyVersion] = useState("ops-v1");
  const [geofenceCode, setGeofenceCode] = useState("IKOYI_PICKUP");
  const [geofenceName, setGeofenceName] = useState("Ikoyi pickup perimeter");
  const snapshot = useQuery({ queryKey: ["operations-snapshot"], queryFn: () => api<Snapshot>("/api/operations/snapshot"), refetchInterval: 20_000 });
  const refresh = () => client.invalidateQueries({ queryKey: ["operations-snapshot"] });
  const createZone = useMutation({
    mutationFn: () => api<Zone>("/api/operations/zones", { method: "POST", body: JSON.stringify({ code: zoneCode, displayName: zoneName, polygon: [[3.372, 6.442], [3.420, 6.442], [3.420, 6.490], [3.372, 6.490]] }) }),
    onSuccess: () => { setMessage("Service zone created."); refresh(); }, onError: (error) => setMessage(error instanceof Error ? error.message : "zone_create_failed"),
  });
  const createWorkflow = useMutation({
    mutationFn: () => api<Workflow>("/api/operations/workflows", { method: "POST", body: JSON.stringify({ workflowCode, displayName: workflowName, policyVersion, requiredStopKinds: ["pickup", "dropoff"], transitions: { draft: ["queued", "cancelled"], queued: ["allocated", "cancelled"], allocated: ["in_progress", "cancelled"], in_progress: ["completed", "failed", "cancelled"] }, inputSchema: { type: "object", properties: { customer_reference: { type: "string" } } } }) }),
    onSuccess: () => { setMessage("Draft workflow version created."); refresh(); }, onError: (error) => setMessage(error instanceof Error ? error.message : "workflow_create_failed"),
  });
  const publishWorkflow = useMutation({
    mutationFn: (id: string) => api<{ state: string }>(`/api/operations/workflows/${id}/publish`, { method: "POST", body: JSON.stringify({ idempotencyKey: `workflow-publish:${id}:${crypto.randomUUID()}` }) }),
    onSuccess: () => { setMessage("Workflow published; any prior published version was archived."); refresh(); }, onError: (error) => setMessage(error instanceof Error ? error.message : "workflow_publish_failed"),
  });
  const createGeofence = useMutation({
    mutationFn: () => api<Geofence>("/api/operations/geofences", { method: "POST", body: JSON.stringify({ code: geofenceCode, displayName: geofenceName, dwellThresholdSeconds: 300, polygon: [[3.385, 6.450], [3.410, 6.450], [3.410, 6.475], [3.385, 6.475]] }) }),
    onSuccess: () => { setMessage("Geofence created."); refresh(); }, onError: (error) => setMessage(error instanceof Error ? error.message : "geofence_create_failed"),
  });
  const createOrder = useMutation({
    mutationFn: () => api<WorkOrder>("/api/operations/work-orders", { method: "POST", body: JSON.stringify({ externalReference: reference, title, priority: 3, serviceZoneId: snapshot.data?.zones[0]?.id, stops: [
      { kind: "pickup", displayName: "Pickup", address: pickupAddress, latitude: Number(pickupLatitude), longitude: Number(pickupLongitude) },
      { kind: "dropoff", displayName: "Drop-off", address: dropoffAddress, latitude: Number(dropoffLatitude), longitude: Number(dropoffLongitude) },
    ] }) }),
    onSuccess: () => { setReference(""); setTitle(""); setPickupAddress(""); setDropoffAddress(""); setMessage("Routeable work order created in draft state."); refresh(); }, onError: (error) => setMessage(error instanceof Error ? error.message : "work_order_create_failed"),
  });
  const transition = useMutation({
    mutationFn: ({ id, nextState }: { id: string; nextState: string }) => api<{ state: string }>(`/api/operations/work-orders/${id}/transition`, { method: "POST", body: JSON.stringify({ nextState, idempotencyKey: `${id}:${nextState}:${crypto.randomUUID()}`, ...(nextState === "allocated" ? { assigneeUserId: 1 } : {}) }) }),
    onSuccess: () => { setMessage("Work order transition recorded."); refresh(); }, onError: (error) => setMessage(error instanceof Error ? error.message : "transition_failed"),
  });
  const createRoutePlan = useMutation({
    mutationFn: (id: string) => api<{ route_plan_id: string; total_distance_m: number; stops: unknown[] }>(`/api/operations/work-orders/${id}/route-plans`, { method: "POST" }),
    onSuccess: (result) => { setMessage(`Route plan ${result.route_plan_id} created with ${result.stops.length} stops and ${Math.round(result.total_distance_m)} m estimated geodesic distance.`); refresh(); }, onError: (error) => setMessage(error instanceof Error ? error.message : "route_plan_failed"),
  });

  const data = snapshot.data;
  return <DashboardLayout><div className="space-y-6">
    <div><div className="text-xs font-medium uppercase tracking-[0.22em] text-cyan-300">Independent logistics operations</div><h1 className="mt-2 text-3xl font-semibold text-white">Jobs, zones, live execution, and integration events</h1><p className="mt-2 max-w-3xl text-slate-400">This workspace is independently designed around durable, tenant-scoped work orders. It has no dependency on third-party logistics source code or interfaces.</p></div>
    {message ? <div className="rounded-xl border border-cyan-400/30 bg-cyan-950/30 px-4 py-3 text-sm text-cyan-100">{message}</div> : null}
    {snapshot.isError ? <Card className="border-amber-500/40 bg-amber-950/20"><CardHeader><CardTitle className="text-amber-100">Operations data is unavailable</CardTitle><CardDescription>The workspace does not display synthetic records when the authenticated API cannot load durable tenant data.</CardDescription></CardHeader><CardContent className="text-sm text-amber-100/80">{snapshot.error instanceof Error ? snapshot.error.message : "operations_unavailable"}</CardContent></Card> : null}
    <div className="grid gap-4 md:grid-cols-4">
      {[['Active zones', data?.zones.filter((zone) => zone.active).length ?? '—'], ['Open work', data?.orders.filter((order) => !['completed','cancelled','failed'].includes(order.state)).length ?? '—'], ['Published workflows', data?.workflows.filter((workflow) => workflow.state === 'published').length ?? '—'], ['Active geofences', data?.geofences.filter((geofence) => geofence.active).length ?? '—']].map(([label, value]) => <Card key={String(label)}><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-3xl text-white">{value}</CardTitle></CardHeader></Card>)}
    </div>
    <div className="grid gap-4 xl:grid-cols-2">
      <Card><CardHeader><CardTitle>Define a dispatch zone</CardTitle><CardDescription>Creates a durable polygonal service boundary under the active tenant. The pilot coordinates can be changed before submission.</CardDescription></CardHeader><CardContent className="space-y-3"><input value={zoneCode} onChange={(event) => setZoneCode(event.target.value)} aria-label="Zone code" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><input value={zoneName} onChange={(event) => setZoneName(event.target.value)} aria-label="Zone name" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><button type="button" disabled={createZone.isPending} onClick={() => createZone.mutate()} className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-50">Create zone</button></CardContent></Card>
      <Card><CardHeader><CardTitle>Create a routeable work order</CardTitle><CardDescription>Records a tenant-unique job with an operator-entered pickup and drop-off. Coordinates are validated by the durable API, then the Rust planner can create a versioned route plan after queuing.</CardDescription></CardHeader><CardContent className="space-y-3"><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="External reference" aria-label="External reference" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Work order title" aria-label="Work order title" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><input value={pickupAddress} onChange={(event) => setPickupAddress(event.target.value)} placeholder="Pickup address" aria-label="Pickup address" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><div className="grid grid-cols-2 gap-2"><input value={pickupLatitude} onChange={(event) => setPickupLatitude(event.target.value)} placeholder="Pickup latitude" aria-label="Pickup latitude" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><input value={pickupLongitude} onChange={(event) => setPickupLongitude(event.target.value)} placeholder="Pickup longitude" aria-label="Pickup longitude" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /></div><input value={dropoffAddress} onChange={(event) => setDropoffAddress(event.target.value)} placeholder="Drop-off address" aria-label="Drop-off address" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><div className="grid grid-cols-2 gap-2"><input value={dropoffLatitude} onChange={(event) => setDropoffLatitude(event.target.value)} placeholder="Drop-off latitude" aria-label="Drop-off latitude" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><input value={dropoffLongitude} onChange={(event) => setDropoffLongitude(event.target.value)} placeholder="Drop-off longitude" aria-label="Drop-off longitude" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /></div><button type="button" disabled={createOrder.isPending || !data?.zones.length || !reference.trim() || !title.trim() || !pickupAddress.trim() || !dropoffAddress.trim()} onClick={() => createOrder.mutate()} className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-50">Create work order</button></CardContent></Card>
    </div>
    <div className="grid gap-4 xl:grid-cols-2">
      <Card><CardHeader><CardTitle>Versioned workflow authoring</CardTitle><CardDescription>Creates a tenant-scoped draft with an explicit state-transition policy. Publication archives the prior published version of the same workflow code.</CardDescription></CardHeader><CardContent className="space-y-3"><input value={workflowCode} onChange={(event) => setWorkflowCode(event.target.value)} aria-label="Workflow code" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><input value={workflowName} onChange={(event) => setWorkflowName(event.target.value)} aria-label="Workflow name" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><input value={policyVersion} onChange={(event) => setPolicyVersion(event.target.value)} aria-label="Policy version" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><button type="button" disabled={createWorkflow.isPending} onClick={() => createWorkflow.mutate()} className="rounded-lg bg-violet-400 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-50">Create draft workflow</button><div className="space-y-2 pt-2">{data?.workflows.map((workflow) => <div key={workflow.id} className="flex items-center justify-between rounded-lg border border-slate-800 p-3 text-sm text-slate-300"><span>{workflow.display_name} · v{workflow.version} · {workflow.state}</span>{workflow.state === 'draft' ? <button type="button" disabled={publishWorkflow.isPending} onClick={() => publishWorkflow.mutate(workflow.id)} className="rounded border border-violet-400/30 px-2 py-1 text-xs text-violet-100">Publish</button> : null}</div>)}</div></CardContent></Card>
      <Card><CardHeader><CardTitle>Geofence controls and live locations</CardTitle><CardDescription>Creates a tenant-scoped operational perimeter. The live list is sourced from the latest durable tracking position per work order; no synthetic map markers are rendered.</CardDescription></CardHeader><CardContent className="space-y-3"><input value={geofenceCode} onChange={(event) => setGeofenceCode(event.target.value)} aria-label="Geofence code" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><input value={geofenceName} onChange={(event) => setGeofenceName(event.target.value)} aria-label="Geofence name" className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white" /><button type="button" disabled={createGeofence.isPending} onClick={() => createGeofence.mutate()} className="rounded-lg bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-50">Create geofence</button><div className="space-y-2 pt-2">{data?.positions.slice(0, 6).map((position) => <div key={position.work_order_id} className="rounded-lg border border-slate-800 p-3 text-xs text-slate-300"><span className="font-medium text-white">{position.external_reference}</span> · {Number(position.latitude).toFixed(5)}, {Number(position.longitude).toFixed(5)} · integrity {position.integrity_score}</div>) ?? <p className="text-sm text-slate-400">No durable current locations.</p>}</div></CardContent></Card>
    </div>
    <Card><CardHeader><CardTitle>Live work queue</CardTitle><CardDescription>Data is loaded from the authenticated operations API every 20 seconds. State changes are blocked by the database-backed transition policy.</CardDescription></CardHeader><CardContent><div className="space-y-3">{snapshot.isLoading ? <p className="text-sm text-slate-400">Loading durable work-order data...</p> : data?.orders.length ? data.orders.map((order) => <div key={order.id} className="flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-4 lg:flex-row lg:items-center lg:justify-between"><div><div className="font-medium text-white">{order.title}</div><div className="mt-1 text-sm text-slate-400">{order.external_reference} · {order.zone_name ?? 'No zone'} · priority {order.priority}</div></div><div className="flex items-center gap-2"><span className={`rounded-full border px-3 py-1 text-xs font-medium ${stateClass(order.state)}`}>{order.state.replace(/_/g, ' ')}</span>{order.state === 'draft' ? <button type="button" onClick={() => transition.mutate({ id: order.id, nextState: 'queued' })} className="rounded-lg border border-cyan-400/30 px-3 py-1 text-xs text-cyan-100">Queue</button> : null}{order.state === 'queued' ? <><button type="button" disabled={createRoutePlan.isPending} onClick={() => createRoutePlan.mutate(order.id)} className="rounded-lg border border-violet-400/30 px-3 py-1 text-xs text-violet-100 disabled:opacity-50">Plan route</button><button type="button" onClick={() => transition.mutate({ id: order.id, nextState: 'allocated' })} className="rounded-lg border border-cyan-400/30 px-3 py-1 text-xs text-cyan-100">Allocate</button></> : null}{order.state === 'allocated' ? <button type="button" onClick={() => transition.mutate({ id: order.id, nextState: 'in_progress' })} className="rounded-lg border border-cyan-400/30 px-3 py-1 text-xs text-cyan-100">Start</button> : null}{order.state === 'in_progress' ? <button type="button" onClick={() => transition.mutate({ id: order.id, nextState: 'completed' })} className="rounded-lg border border-emerald-400/30 px-3 py-1 text-xs text-emerald-100">Complete</button> : null}</div></div>) : <p className="text-sm text-slate-400">No durable work orders exist for this tenant.</p>}</div></CardContent></Card>
    <div className="grid gap-4 xl:grid-cols-2"><Card><CardHeader><CardTitle>Activity log</CardTitle><CardDescription>Immutable work-order events created by successful state changes.</CardDescription></CardHeader><CardContent><div className="space-y-2">{data?.events.length ? data.events.slice(0, 12).map((event) => <div key={event.id} className="rounded-lg border border-slate-800 p-3 text-sm text-slate-300"><span className="font-medium text-white">{event.external_reference}</span> · {event.event_type.replace(/_/g, ' ')} · {new Date(event.created_at).toLocaleString()}</div>) : <p className="text-sm text-slate-400">No recorded events.</p>}</div></CardContent></Card><Card><CardHeader><CardTitle>Partner event delivery</CardTitle><CardDescription>HTTPS-only subscriptions receive signed, idempotent event envelopes from the durable retry queue.</CardDescription></CardHeader><CardContent><div className="space-y-2">{data?.subscriptions.length ? data.subscriptions.map((subscription) => <div key={subscription.id} className="rounded-lg border border-slate-800 p-3 text-sm text-slate-300"><span className="font-medium text-white">{subscription.display_name}</span><div className="mt-1 break-all text-xs text-slate-400">{subscription.endpoint_url}</div><div className="mt-1 text-xs text-cyan-200">{subscription.event_types.join(', ')}</div></div>) : <p className="text-sm text-slate-400">No active tenant subscriptions.</p>}</div></CardContent></Card></div>
  </div></DashboardLayout>;
}
