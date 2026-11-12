import { useState } from "react";
import { CircleAlert, Container, PlusCircle, Truck } from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { QueryErrorState } from "@/components/QueryState";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

function money(amount: number) {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Integer minor units (kobo) -> major display string. */
function minorToMajor(minor: number) {
  return money(minor / 100);
}

/**
 * Exact major-string -> integer-minor parse (no float math on money):
 * accepts "12500" or "12500.50", rejects anything else.
 */
function majorToMinor(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

/** Idempotency keys per merchantSelfServe.ts:68 pattern. */
function newKey(prefix: string) {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  return `${prefix}-${random}`;
}

const EQUIPMENT_OPTIONS = ["box_truck", "sprinter", "reefer", "flatbed"] as const;

const NEXT_STATUS: Record<string, { target: "picked_up" | "in_transit" | "delivered"; label: string }> = {
  assigned: { target: "picked_up", label: "Mark picked up" },
  picked_up: { target: "in_transit", label: "Mark in transit" },
  in_transit: { target: "delivered", label: "Mark delivered" },
};

const inputClass =
  "w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500";
const buttonClass =
  "rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50";
const dangerButtonClass =
  "rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/20 disabled:opacity-50";

export default function FreightOperations() {
  const freight = trpc.mobility.freight.useQuery();
  const myLoads = trpc.verticalOps.myFreightLoads.useQuery();
  const utils = trpc.useUtils();
  const data = freight.data;

  const [notice, setNotice] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({
    laneCode: "",
    originLabel: "",
    destinationLabel: "",
    shipperProviderId: "",
    equipment: "box_truck" as (typeof EQUIPMENT_OPTIONS)[number],
    value: "",
  });
  const [carrierInputs, setCarrierInputs] = useState<Record<number, string>>({});
  const [cancelReasons, setCancelReasons] = useState<Record<number, string>>({});

  const onWriteSuccess = async (message: string) => {
    setNotice(message);
    await Promise.all([
      utils.mobility.freight.invalidate(),
      utils.verticalOps.myFreightLoads.invalidate(),
    ]);
  };
  const onWriteError = (error: { message: string }) => setNotice(error.message);

  const createLoad = trpc.verticalOps.createFreightLoad.useMutation({
    onSuccess: (result) =>
      void onWriteSuccess(
        `Load #${result.loadId} created in draft${result.replayed ? " (replayed)" : ""}.`,
      ),
    onError: onWriteError,
  });
  const tenderLoad = trpc.verticalOps.tenderFreightLoad.useMutation({
    onSuccess: (result) => void onWriteSuccess(`Load #${result.loadId} tendered.`),
    onError: onWriteError,
  });
  const assignCarrier = trpc.verticalOps.assignFreightCarrier.useMutation({
    onSuccess: (result) =>
      void onWriteSuccess(
        `Load #${result.loadId} assigned to carrier ${result.carrierProviderId}.`,
      ),
    onError: onWriteError,
  });
  const transitionLoad = trpc.verticalOps.transitionFreightLoad.useMutation({
    onSuccess: (result) =>
      void onWriteSuccess(`Load #${result.loadId} is now ${result.status}.`),
    onError: onWriteError,
  });

  const busy =
    createLoad.isPending ||
    tenderLoad.isPending ||
    assignCarrier.isPending ||
    transitionLoad.isPending;

  const submitCreate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const valueMinor = createForm.value.trim() === "" ? 0 : majorToMinor(createForm.value);
    if (valueMinor === null) {
      setNotice("Value must be a non-negative amount with at most 2 decimals.");
      return;
    }
    const shipperId = Number(createForm.shipperProviderId);
    createLoad.mutate({
      laneCode: createForm.laneCode.trim() || undefined,
      originLabel: createForm.originLabel.trim() || undefined,
      destinationLabel: createForm.destinationLabel.trim() || undefined,
      shipperProviderId:
        createForm.shipperProviderId.trim() !== "" && Number.isInteger(shipperId) && shipperId > 0
          ? shipperId
          : undefined,
      equipment: createForm.equipment,
      valueMinor,
      idempotencyKey: newKey("freight-create"),
    });
  };

  const submitAssign = (loadId: number) => {
    const carrierId = Number(carrierInputs[loadId]);
    if (!Number.isInteger(carrierId) || carrierId <= 0) {
      setNotice("Enter a numeric carrier provider id to assign.");
      return;
    }
    assignCarrier.mutate({
      loadId,
      carrierProviderId: carrierId,
      idempotencyKey: newKey("freight-assign"),
    });
  };

  const submitCancel = (loadId: number) => {
    const reason = (cancelReasons[loadId] ?? "").trim();
    if (reason.length === 0) {
      setNotice("A cancellation reason is required.");
      return;
    }
    transitionLoad.mutate({
      loadId,
      targetStatus: "cancelled",
      reason,
      idempotencyKey: newKey("freight-cancel"),
    });
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="space-y-2 border-b border-slate-800 pb-6">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
            Freight control tower
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-50">
            Freight operations
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-400">
            Load board, lanes, and carrier network from the live freight
            ledger. No synthetic loads are shown.
          </p>
        </div>

        {freight.isLoading ? (
          <p className="text-sm text-slate-400">Loading freight operations…</p>
        ) : null}
        {freight.isError ? (
          <QueryErrorState
            resource="freight operations data"
            message={freight.error.message}
            onRetry={() => void freight.refetch()}
            retrying={freight.isRefetching}
          />
        ) : null}

        {notice ? (
          <p className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200">
            {notice}
          </p>
        ) : null}

        <Card className="border-slate-800 bg-slate-950/60">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base text-slate-100">
              <PlusCircle className="h-5 w-5 text-cyan-300" />
              Create load
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitCreate} className="grid gap-3 md:grid-cols-3">
              <input
                className={inputClass}
                placeholder="Lane code (e.g. LOS-ABV)"
                value={createForm.laneCode}
                onChange={(event) =>
                  setCreateForm((prev) => ({ ...prev, laneCode: event.target.value }))
                }
              />
              <input
                className={inputClass}
                placeholder="Origin"
                value={createForm.originLabel}
                onChange={(event) =>
                  setCreateForm((prev) => ({ ...prev, originLabel: event.target.value }))
                }
              />
              <input
                className={inputClass}
                placeholder="Destination"
                value={createForm.destinationLabel}
                onChange={(event) =>
                  setCreateForm((prev) => ({ ...prev, destinationLabel: event.target.value }))
                }
              />
              <select
                className={inputClass}
                value={createForm.equipment}
                onChange={(event) =>
                  setCreateForm((prev) => ({
                    ...prev,
                    equipment: event.target.value as (typeof EQUIPMENT_OPTIONS)[number],
                  }))
                }
              >
                {EQUIPMENT_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
              <input
                className={inputClass}
                placeholder="Value (NGN, e.g. 25000.00)"
                inputMode="decimal"
                value={createForm.value}
                onChange={(event) =>
                  setCreateForm((prev) => ({ ...prev, value: event.target.value }))
                }
              />
              <input
                className={inputClass}
                placeholder="Shipper provider id (optional)"
                inputMode="numeric"
                value={createForm.shipperProviderId}
                onChange={(event) =>
                  setCreateForm((prev) => ({ ...prev, shipperProviderId: event.target.value }))
                }
              />
              <div className="md:col-span-3">
                <button type="submit" className={buttonClass} disabled={busy}>
                  Create draft load
                </button>
              </div>
            </form>
          </CardContent>
        </Card>

        {data ? (
          <>
            <div className="grid gap-4 md:grid-cols-4">
              {[
                ["Shipper accounts", data.summary.shipper_accounts],
                ["Carrier lanes", data.summary.carrier_lanes],
                ["Active loads", data.summary.active_loads],
                ["Open procurement", data.summary.procurement_events],
              ].map(([label, value]) => (
                <Card
                  key={label}
                  className="border-slate-800 bg-slate-950/60"
                >
                  <CardHeader className="pb-2">
                    <CardTitle className="text-xs text-slate-400">
                      {label}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-semibold text-slate-50">
                    {value}
                  </CardContent>
                </Card>
              ))}
            </div>

            <p className="text-sm text-slate-400">
              {data.summary.recommended_action}
            </p>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <Container className="h-5 w-5 text-cyan-300" />
                  Load board
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.load_board.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No freight loads have been tendered yet. Loads appear here
                    as shippers post them.
                  </p>
                ) : (
                  data.load_board.map((load) => (
                    <div
                      key={load.id}
                      className="space-y-2 border-b border-slate-800 pb-3 last:border-0"
                    >
                      <div className="flex flex-col justify-between gap-2 md:flex-row md:items-center">
                        <div>
                          <p className="font-medium text-slate-100">
                            #{load.id} · {load.lane}
                          </p>
                          <p className="text-xs text-slate-500">
                            {load.equipment} · {load.status}
                            {load.address ? ` · ${load.address}` : ""}
                          </p>
                        </div>
                        <p className="text-sm font-semibold text-slate-100">
                          {money(load.value)}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {load.status === "draft" ? (
                          <button
                            type="button"
                            className={buttonClass}
                            disabled={busy}
                            onClick={() =>
                              tenderLoad.mutate({
                                loadId: load.id,
                                idempotencyKey: newKey("freight-tender"),
                              })
                            }
                          >
                            Tender load
                          </button>
                        ) : null}
                        {load.status === "tendered" ? (
                          <>
                            <input
                              className="w-40 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
                              placeholder="Carrier provider id"
                              inputMode="numeric"
                              value={carrierInputs[load.id] ?? ""}
                              onChange={(event) =>
                                setCarrierInputs((prev) => ({
                                  ...prev,
                                  [load.id]: event.target.value,
                                }))
                              }
                            />
                            <button
                              type="button"
                              className={buttonClass}
                              disabled={busy}
                              onClick={() => submitAssign(load.id)}
                            >
                              Assign carrier
                            </button>
                          </>
                        ) : null}
                        {NEXT_STATUS[load.status] ? (
                          <button
                            type="button"
                            className={buttonClass}
                            disabled={busy}
                            onClick={() =>
                              transitionLoad.mutate({
                                loadId: load.id,
                                targetStatus: NEXT_STATUS[load.status].target,
                                idempotencyKey: newKey("freight-transition"),
                              })
                            }
                          >
                            {NEXT_STATUS[load.status].label}
                          </button>
                        ) : null}
                        {["draft", "tendered", "assigned", "picked_up", "in_transit"].includes(
                          load.status,
                        ) ? (
                          <>
                            <input
                              className="w-44 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
                              placeholder="Cancel reason"
                              value={cancelReasons[load.id] ?? ""}
                              onChange={(event) =>
                                setCancelReasons((prev) => ({
                                  ...prev,
                                  [load.id]: event.target.value,
                                }))
                              }
                            />
                            <button
                              type="button"
                              className={dangerButtonClass}
                              disabled={busy}
                              onClick={() => submitCancel(load.id)}
                            >
                              Cancel load
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <Truck className="h-5 w-5 text-emerald-300" />
                  Carrier network
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-3 border border-amber-400/30 bg-amber-400/5 p-3 text-xs text-amber-100">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                  <p>
                    Carrier compliance scoring is not instrumented yet, so no
                    score is shown. Verification status comes directly from
                    provider onboarding records.
                  </p>
                </div>
                {data.carrier_network.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No carriers or freight shippers are onboarded yet. Providers
                    with freight or logistics categories appear here.
                  </p>
                ) : (
                  data.carrier_network.map((carrier) => (
                    <div
                      key={carrier.id}
                      className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 md:flex-row md:items-center"
                    >
                      <div>
                        <p className="font-medium text-slate-100">
                          {carrier.name}
                        </p>
                        <p className="text-xs text-slate-500">
                          {carrier.category ?? "general"} · {carrier.status}
                        </p>
                      </div>
                      <span
                        className={
                          carrier.verification_status === "verified"
                            ? "text-sm text-emerald-200"
                            : "text-sm text-amber-200"
                        }
                      >
                        {carrier.verification_status}
                      </span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </>
        ) : null}

        <Card className="border-slate-800 bg-slate-950/60">
          <CardHeader>
            <CardTitle className="text-base text-slate-100">My shipper loads</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {myLoads.isLoading ? (
              <p className="text-sm text-slate-400">Loading your loads…</p>
            ) : myLoads.isError ? (
              <p className="text-sm text-slate-400">{myLoads.error.message}</p>
            ) : (myLoads.data?.loads.length ?? 0) === 0 ? (
              <p className="text-sm text-slate-400">
                No loads are linked to a shipper provider you own.
              </p>
            ) : (
              myLoads.data?.loads.map((load) => (
                <div
                  key={load.id}
                  className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 md:flex-row md:items-center"
                >
                  <div>
                    <p className="font-medium text-slate-100">
                      #{load.id} · {load.laneCode ?? load.originLabel ?? "Load"}
                    </p>
                    <p className="text-xs text-slate-500">
                      {load.equipment} · {load.status}
                    </p>
                  </div>
                  <p className="text-sm font-semibold text-slate-100">
                    {minorToMajor(load.valueMinor)}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
