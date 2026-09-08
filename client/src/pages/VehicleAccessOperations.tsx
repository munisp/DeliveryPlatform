import { FormEvent, useMemo, useState } from "react";
import { CarFront, ClipboardCheck, Loader2, ShieldCheck } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import { VehicleRentalOperationsPanel } from "@/components/VehicleRentalOperationsPanel";
import { VehicleTrackerSafetyPanel } from "@/components/VehicleTrackerSafetyPanel";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

function idempotency(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function iso(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()))
    throw new Error("Enter a valid date and time.");
  return parsed.toISOString();
}

export default function VehicleAccessOperations() {
  const [notice, setNotice] = useState<string | null>(null);
  const [inspection, setInspection] = useState({
    contractId: "",
    kind: "handover" as "handover" | "return",
    objectKey: "",
    sha256Hex: "",
    odometerKm: "",
  });
  const [workerAction, setWorkerAction] = useState({
    contractId: "",
    action: "begin_return" as "begin_return" | "cancel",
    reason: "",
  });
  const [operatorAction, setOperatorAction] = useState({
    contractId: "",
    action: "approve" as
      | "approve"
      | "handover"
      | "close"
      | "suspend"
      | "begin_safe_return",
    reason: "",
  });
  const [provider, setProvider] = useState({ displayName: "", legalName: "" });
  const [eligibility, setEligibility] = useState({
    workerUserId: "",
    expiresAt: "",
  });
  const [asset, setAsset] = useState({
    providerId: "",
    registrationNumber: "",
    vinSha256: "",
    make: "",
    model: "",
    manufactureYear: "",
    odometerKm: "",
    passengerCapacity: "4",
  });
  const [assetEvidence, setAssetEvidence] = useState({
    assetId: "",
    kind: "registration" as
      | "registration"
      | "roadworthiness"
      | "commercial_cover"
      | "ownership_authority"
      | "inspection",
    objectKey: "",
    sha256Hex: "",
    expiresAt: "",
  });
  const [offer, setOffer] = useState({
    providerId: "",
    assetId: "",
    currency: "NGN",
    weeklyPriceMinor: "",
    depositMinor: "0",
    includedKmPerWeek: "",
    excessKmPriceMinor: "",
    minimumDays: "7",
  });

  const offers = trpc.vehicleAccess.listOffers.useQuery({ limit: 100 });
  const contracts = trpc.vehicleAccess.listContracts.useQuery({ limit: 100 });
  const utils = trpc.useUtils();
  const refresh = async (message: string) => {
    await Promise.all([
      utils.vehicleAccess.listOffers.invalidate(),
      utils.vehicleAccess.listContracts.invalidate(),
    ]);
    setNotice(message);
  };

  const inspectionMutation = trpc.vehicleAccess.recordInspection.useMutation({
    onSuccess: () => refresh("Immutable inspection evidence recorded."),
    onError: (error) => setNotice(error.message),
  });
  const transitionMutation = trpc.vehicleAccess.transition.useMutation({
    onSuccess: (state) =>
      refresh(`Contract moved to ${state.replace("_", " ")}.`),
    onError: (error) => setNotice(error.message),
  });
  const operatorTransitionMutation =
    trpc.vehicleAccess.operateTransition.useMutation({
      onSuccess: (state) =>
        refresh(`Operator transition completed: ${state.replace("_", " ")}.`),
      onError: (error) => setNotice(error.message),
    });
  const providerMutation = trpc.vehicleAccess.createProvider.useMutation({
    onSuccess: (id) => setNotice(`Fleet provider created: ${id}`),
    onError: (error) => setNotice(error.message),
  });
  const eligibilityMutation =
    trpc.vehicleAccess.verifyWorkerEligibility.useMutation({
      onSuccess: () => setNotice("Worker eligibility verified."),
      onError: (error) => setNotice(error.message),
    });
  const assetMutation = trpc.vehicleAccess.registerAsset.useMutation({
    onSuccess: (id) => setNotice(`Vehicle asset registered in intake: ${id}`),
    onError: (error) => setNotice(error.message),
  });
  const assetEvidenceMutation =
    trpc.vehicleAccess.recordAssetEvidence.useMutation({
      onSuccess: () => setNotice("Asset evidence recorded."),
      onError: (error) => setNotice(error.message),
    });
  const activateAssetMutation = trpc.vehicleAccess.activateAsset.useMutation({
    onSuccess: () => refresh("Vehicle asset activated for offers."),
    onError: (error) => setNotice(error.message),
  });
  const offerMutation = trpc.vehicleAccess.createOffer.useMutation({
    onSuccess: (id) => refresh(`Vehicle offer created: ${id}`),
    onError: (error) => setNotice(error.message),
  });

  const summary = useMemo(() => {
    const all = contracts.data ?? [];
    return {
      visible: all.length,
      requested: all.filter((item) => item.state === "requested").length,
      active: all.filter((item) => item.state === "active").length,
      returnPending: all.filter((item) => item.state === "return_pending")
        .length,
    };
  }, [contracts.data]);

  const submitInspection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    inspectionMutation.mutate({
      contractId: inspection.contractId,
      kind: inspection.kind,
      objectKey: inspection.objectKey,
      contentType: "image/jpeg",
      sha256Hex: inspection.sha256Hex,
      odometerKm: Number(inspection.odometerKm),
      idempotencyKey: idempotency("vehicle-inspection"),
    });
  };

  const submitWorkerAction = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    transitionMutation.mutate({
      contractId: workerAction.contractId,
      action: workerAction.action,
      reason: workerAction.action === "cancel" ? workerAction.reason : null,
      idempotencyKey: idempotency("vehicle-worker-transition"),
    });
  };

  const submitOperatorAction = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    operatorTransitionMutation.mutate({
      contractId: operatorAction.contractId,
      action: operatorAction.action,
      reason: ["suspend"].includes(operatorAction.action)
        ? operatorAction.reason
        : null,
      idempotencyKey: idempotency("vehicle-operator-transition"),
    });
  };
  const submitProvider = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    providerMutation.mutate(provider);
  };
  const submitEligibility = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      eligibilityMutation.mutate({
        workerUserId: Number(eligibility.workerUserId),
        allowedWorkCategories: ["ride_hailing", "delivery"],
        expiresAt: iso(eligibility.expiresAt),
      });
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Invalid eligibility expiry.",
      );
    }
  };
  const submitAsset = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    assetMutation.mutate({
      providerId: asset.providerId,
      registrationNumber: asset.registrationNumber,
      vinSha256: asset.vinSha256,
      make: asset.make,
      model: asset.model,
      manufactureYear: Number(asset.manufactureYear),
      odometerKm: Number(asset.odometerKm),
      passengerCapacity: Number(asset.passengerCapacity),
      allowedWorkCategories: ["ride_hailing", "delivery"],
    });
  };
  const submitAssetEvidence = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      assetEvidenceMutation.mutate({
        assetId: assetEvidence.assetId,
        kind: assetEvidence.kind,
        objectKey: assetEvidence.objectKey,
        sha256Hex: assetEvidence.sha256Hex,
        expiresAt: assetEvidence.expiresAt
          ? iso(assetEvidence.expiresAt)
          : null,
        idempotencyKey: idempotency("vehicle-asset-evidence"),
      });
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Invalid evidence expiry.",
      );
    }
  };
  const submitOffer = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    offerMutation.mutate({
      providerId: offer.providerId,
      assetId: offer.assetId,
      currency: offer.currency,
      weeklyPriceMinor: Number(offer.weeklyPriceMinor),
      depositMinor: Number(offer.depositMinor),
      includedKmPerWeek: Number(offer.includedKmPerWeek),
      excessKmPriceMinor: Number(offer.excessKmPriceMinor),
      minimumDays: Number(offer.minimumDays),
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-7">
        <section className="flex flex-col justify-between gap-5 border-b border-slate-800 pb-7 lg:flex-row lg:items-end">
          <div className="max-w-3xl space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-[0.22em] text-cyan-300">
              <CarFront className="h-4 w-4" /> Gig-worker vehicle access
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">
              Verified access to commercially eligible vehicles
            </h1>
            <p className="text-sm leading-6 text-slate-400">
              Discover active low-cost vehicle offers, request time-bounded
              access, and preserve handover and return evidence. PostgreSQL
              enforces lifecycle and evidence rules; vehicle access does not
              settle ride payments or create lending decisions.
            </p>
          </div>
        </section>

        {notice ? (
          <div className="border border-cyan-400/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
            {notice}
          </div>
        ) : null}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["Visible contracts", summary.visible],
            ["Pending review", summary.requested],
            ["Active access", summary.active],
            ["Return pending", summary.returnPending],
          ].map(([label, value]) => (
            <Card key={String(label)}>
              <CardHeader className="pb-2">
                <CardDescription>{label}</CardDescription>
                <CardTitle className="text-3xl">{value}</CardTitle>
              </CardHeader>
            </Card>
          ))}
        </section>

        <VehicleRentalOperationsPanel onNotice={setNotice} />
        <VehicleTrackerSafetyPanel onNotice={setNotice} />

        <section className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Available vehicle offers</CardTitle>
              <CardDescription>
                Only active offers backed by a provider-approved,
                evidence-verified available asset are shown.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {offers.isLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading eligible
                  offers…
                </div>
              ) : null}
              {offers.isError ? (
                <p className="py-6 text-sm text-rose-300">
                  {offers.error.message}
                </p>
              ) : null}
              {!offers.isLoading && !offers.isError && !offers.data?.length ? (
                <p className="py-6 text-sm text-slate-400">
                  No active vehicle offers are currently available.
                </p>
              ) : null}
              {offers.data?.map((offer) => (
                <div
                  key={offer.id}
                  className="grid gap-3 border border-slate-800 p-4 md:grid-cols-[1fr_auto] md:items-center"
                >
                  <div className="space-y-1">
                    <p className="font-medium text-slate-100">
                      {offer.manufactureYear} {offer.make} {offer.model}
                    </p>
                    <p className="font-mono text-xs text-slate-500">
                      {offer.id}
                    </p>
                    <p className="text-sm text-slate-400">
                      {offer.odometerKm.toLocaleString()} km ·{" "}
                      {offer.includedKmPerWeek.toLocaleString()} km/week
                      included · {offer.minimumDays}-day minimum
                    </p>
                  </div>
                  <div className="text-right text-sm text-slate-300">
                    <p className="font-medium">
                      {offer.currency}{" "}
                      {(offer.weeklyPriceMinor / 100).toLocaleString()} / week
                    </p>
                    <p className="text-slate-500">
                      Deposit: {offer.currency}{" "}
                      {(offer.depositMinor / 100).toLocaleString()}
                    </p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle>Inspection evidence</CardTitle>
                <CardDescription>
                  Workers or operators record immutable handover and return
                  evidence; object storage must be managed by the approved
                  evidence pipeline.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={submitInspection} className="space-y-3">
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                    placeholder="Contract UUID"
                    value={inspection.contractId}
                    onChange={(event) =>
                      setInspection({
                        ...inspection,
                        contractId: event.target.value,
                      })
                    }
                    required
                  />
                  <select
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                    value={inspection.kind}
                    onChange={(event) =>
                      setInspection({
                        ...inspection,
                        kind: event.target.value as typeof inspection.kind,
                      })
                    }
                  >
                    <option value="handover">Handover inspection</option>
                    <option value="return">Return inspection</option>
                  </select>
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                    placeholder="Evidence object key"
                    value={inspection.objectKey}
                    onChange={(event) =>
                      setInspection({
                        ...inspection,
                        objectKey: event.target.value,
                      })
                    }
                    required
                  />
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-slate-100"
                    placeholder="SHA-256 hex"
                    pattern="[a-f0-9]{64}"
                    value={inspection.sha256Hex}
                    onChange={(event) =>
                      setInspection({
                        ...inspection,
                        sha256Hex: event.target.value,
                      })
                    }
                    required
                  />
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                    placeholder="Odometer km"
                    inputMode="numeric"
                    value={inspection.odometerKm}
                    onChange={(event) =>
                      setInspection({
                        ...inspection,
                        odometerKm: event.target.value,
                      })
                    }
                    required
                  />
                  <button
                    className="rounded-md border border-slate-600 px-4 py-2 text-sm font-medium text-slate-100 disabled:opacity-60"
                    type="submit"
                    disabled={inspectionMutation.isPending}
                  >
                    {inspectionMutation.isPending
                      ? "Recording…"
                      : "Record inspection"}
                  </button>
                </form>
              </CardContent>
            </Card>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Authorized contract queue</CardTitle>
              <CardDescription>
                Workers see only their contracts. Operators see the full queue
                through the same database-authorized read function.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {contracts.isLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading
                  contracts…
                </div>
              ) : null}
              {contracts.isError ? (
                <p className="py-6 text-sm text-rose-300">
                  {contracts.error.message}
                </p>
              ) : null}
              {contracts.data?.map((contract) => (
                <div
                  key={contract.id}
                  className="grid gap-3 border border-slate-800 p-4 md:grid-cols-[1fr_auto] md:items-center"
                >
                  <div>
                    <p className="font-medium text-slate-100">
                      {contract.publicReference}
                    </p>
                    <p className="font-mono text-xs text-slate-500">
                      {contract.id}
                    </p>
                    <p className="text-sm text-slate-400">
                      {contract.state.replace("_", " ")} · worker{" "}
                      {contract.workerUserId}
                    </p>
                  </div>
                  <p className="text-sm text-slate-400">
                    {new Date(contract.startsAt).toLocaleString()} →{" "}
                    {new Date(contract.endsAt).toLocaleString()}
                  </p>
                </div>
              ))}
            </CardContent>
          </Card>
          <div className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle>Worker action</CardTitle>
                <CardDescription>
                  Workers may cancel before activation or start the return flow
                  after active access.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={submitWorkerAction} className="space-y-3">
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                    placeholder="Contract UUID"
                    value={workerAction.contractId}
                    onChange={(event) =>
                      setWorkerAction({
                        ...workerAction,
                        contractId: event.target.value,
                      })
                    }
                    required
                  />
                  <select
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                    value={workerAction.action}
                    onChange={(event) =>
                      setWorkerAction({
                        ...workerAction,
                        action: event.target
                          .value as typeof workerAction.action,
                      })
                    }
                  >
                    <option value="begin_return">Begin return</option>
                    <option value="cancel">Cancel request</option>
                  </select>
                  {workerAction.action === "cancel" ? (
                    <input
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                      placeholder="Cancellation reason"
                      minLength={3}
                      value={workerAction.reason}
                      onChange={(event) =>
                        setWorkerAction({
                          ...workerAction,
                          reason: event.target.value,
                        })
                      }
                      required
                    />
                  ) : null}
                  <button
                    className="rounded-md border border-slate-600 px-4 py-2 text-sm font-medium text-slate-100 disabled:opacity-60"
                    type="submit"
                    disabled={transitionMutation.isPending}
                  >
                    {transitionMutation.isPending
                      ? "Saving…"
                      : "Submit worker action"}
                  </button>
                </form>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Operator transition</CardTitle>
                <CardDescription>
                  Operator-only approval, activation, closure, safety hold, and
                  controlled safe-return transitions remain database-authorized.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={submitOperatorAction} className="space-y-3">
                  <input
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                    placeholder="Contract UUID"
                    value={operatorAction.contractId}
                    onChange={(event) =>
                      setOperatorAction({
                        ...operatorAction,
                        contractId: event.target.value,
                      })
                    }
                    required
                  />
                  <select
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                    value={operatorAction.action}
                    onChange={(event) =>
                      setOperatorAction({
                        ...operatorAction,
                        action: event.target
                          .value as typeof operatorAction.action,
                      })
                    }
                  >
                    <option value="approve">Approve</option>
                    <option value="handover">
                      Activate after handover evidence
                    </option>
                    <option value="close">Close after return evidence</option>
                    <option value="suspend">Safety suspend</option>
                    <option value="begin_safe_return">Begin safe return</option>
                  </select>
                  {operatorAction.action === "suspend" ? (
                    <input
                      className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                      placeholder="Safety suspension reason"
                      minLength={3}
                      value={operatorAction.reason}
                      onChange={(event) =>
                        setOperatorAction({
                          ...operatorAction,
                          reason: event.target.value,
                        })
                      }
                      required
                    />
                  ) : null}
                  <button
                    className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-60"
                    type="submit"
                    disabled={operatorTransitionMutation.isPending}
                  >
                    {operatorTransitionMutation.isPending
                      ? "Transitioning…"
                      : "Run operator transition"}
                  </button>
                </form>
              </CardContent>
            </Card>
          </div>
        </section>

        <section className="space-y-5 border border-slate-800 bg-slate-950/40 p-5">
          <div>
            <div className="flex items-center gap-2 font-medium text-slate-200">
              <ShieldCheck className="h-4 w-4 text-cyan-300" /> Operator
              provisioning
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-400">
              Create supply only through these authorized calls. A vehicle
              remains in intake until all five required evidence classes are
              recorded and an operator activates it.
            </p>
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            <form
              onSubmit={submitProvider}
              className="space-y-2 border border-slate-800 p-4"
            >
              <p className="text-sm font-medium text-slate-100">
                1. Fleet provider
              </p>
              <input
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                placeholder="Display name"
                value={provider.displayName}
                onChange={(event) =>
                  setProvider({ ...provider, displayName: event.target.value })
                }
                required
              />
              <input
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                placeholder="Legal name"
                value={provider.legalName}
                onChange={(event) =>
                  setProvider({ ...provider, legalName: event.target.value })
                }
                required
              />
              <button
                className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100"
                disabled={providerMutation.isPending}
              >
                {providerMutation.isPending ? "Creating…" : "Create provider"}
              </button>
            </form>
            <form
              onSubmit={submitEligibility}
              className="space-y-2 border border-slate-800 p-4"
            >
              <p className="text-sm font-medium text-slate-100">
                2. Worker eligibility
              </p>
              <input
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                placeholder="Worker user ID"
                inputMode="numeric"
                value={eligibility.workerUserId}
                onChange={(event) =>
                  setEligibility({
                    ...eligibility,
                    workerUserId: event.target.value,
                  })
                }
                required
              />
              <input
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                type="datetime-local"
                value={eligibility.expiresAt}
                onChange={(event) =>
                  setEligibility({
                    ...eligibility,
                    expiresAt: event.target.value,
                  })
                }
                required
              />
              <button
                className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100"
                disabled={eligibilityMutation.isPending}
              >
                {eligibilityMutation.isPending ? "Verifying…" : "Verify worker"}
              </button>
            </form>
            <form
              onSubmit={submitAsset}
              className="space-y-2 border border-slate-800 p-4"
            >
              <p className="text-sm font-medium text-slate-100">
                3. Used vehicle intake
              </p>
              <input
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                placeholder="Provider UUID"
                value={asset.providerId}
                onChange={(event) =>
                  setAsset({ ...asset, providerId: event.target.value })
                }
                required
              />
              <input
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                placeholder="Registration number"
                value={asset.registrationNumber}
                onChange={(event) =>
                  setAsset({ ...asset, registrationNumber: event.target.value })
                }
                required
              />
              <input
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-slate-100"
                placeholder="VIN SHA-256 hex"
                pattern="[a-f0-9]{64}"
                value={asset.vinSha256}
                onChange={(event) =>
                  setAsset({ ...asset, vinSha256: event.target.value })
                }
                required
              />
              <div className="grid grid-cols-2 gap-2">
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  placeholder="Make"
                  value={asset.make}
                  onChange={(event) =>
                    setAsset({ ...asset, make: event.target.value })
                  }
                  required
                />
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  placeholder="Model"
                  value={asset.model}
                  onChange={(event) =>
                    setAsset({ ...asset, model: event.target.value })
                  }
                  required
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  placeholder="Year"
                  inputMode="numeric"
                  value={asset.manufactureYear}
                  onChange={(event) =>
                    setAsset({ ...asset, manufactureYear: event.target.value })
                  }
                  required
                />
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  placeholder="Odometer km"
                  inputMode="numeric"
                  value={asset.odometerKm}
                  onChange={(event) =>
                    setAsset({ ...asset, odometerKm: event.target.value })
                  }
                  required
                />
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  placeholder="Seats"
                  inputMode="numeric"
                  value={asset.passengerCapacity}
                  onChange={(event) =>
                    setAsset({
                      ...asset,
                      passengerCapacity: event.target.value,
                    })
                  }
                  required
                />
              </div>
              <button
                className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100"
                disabled={assetMutation.isPending}
              >
                {assetMutation.isPending
                  ? "Registering…"
                  : "Register intake asset"}
              </button>
            </form>
            <form
              onSubmit={submitAssetEvidence}
              className="space-y-2 border border-slate-800 p-4"
            >
              <p className="text-sm font-medium text-slate-100">
                4. Asset evidence
              </p>
              <input
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                placeholder="Asset UUID"
                value={assetEvidence.assetId}
                onChange={(event) =>
                  setAssetEvidence({
                    ...assetEvidence,
                    assetId: event.target.value,
                  })
                }
                required
              />
              <select
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                value={assetEvidence.kind}
                onChange={(event) =>
                  setAssetEvidence({
                    ...assetEvidence,
                    kind: event.target.value as typeof assetEvidence.kind,
                  })
                }
              >
                <option value="registration">Registration</option>
                <option value="roadworthiness">Roadworthiness</option>
                <option value="commercial_cover">Commercial cover</option>
                <option value="ownership_authority">Ownership authority</option>
                <option value="inspection">Inspection</option>
              </select>
              <input
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                placeholder="Evidence object key"
                value={assetEvidence.objectKey}
                onChange={(event) =>
                  setAssetEvidence({
                    ...assetEvidence,
                    objectKey: event.target.value,
                  })
                }
                required
              />
              <input
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-slate-100"
                placeholder="SHA-256 hex"
                pattern="[a-f0-9]{64}"
                value={assetEvidence.sha256Hex}
                onChange={(event) =>
                  setAssetEvidence({
                    ...assetEvidence,
                    sha256Hex: event.target.value,
                  })
                }
                required
              />
              <input
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                type="datetime-local"
                value={assetEvidence.expiresAt}
                onChange={(event) =>
                  setAssetEvidence({
                    ...assetEvidence,
                    expiresAt: event.target.value,
                  })
                }
              />
              <button
                className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100"
                disabled={assetEvidenceMutation.isPending}
              >
                {assetEvidenceMutation.isPending
                  ? "Recording…"
                  : "Record evidence"}
              </button>
              <button
                type="button"
                className="ml-2 rounded-md bg-cyan-500 px-3 py-2 text-sm font-medium text-slate-950"
                onClick={() =>
                  activateAssetMutation.mutate({
                    assetId: assetEvidence.assetId,
                    idempotencyKey: idempotency("vehicle-activate"),
                  })
                }
                disabled={activateAssetMutation.isPending}
              >
                {activateAssetMutation.isPending
                  ? "Activating…"
                  : "Activate asset"}
              </button>
            </form>
            <form
              onSubmit={submitOffer}
              className="space-y-2 border border-slate-800 p-4 xl:col-span-2"
            >
              <p className="text-sm font-medium text-slate-100">
                5. Publish a low-cost vehicle offer
              </p>
              <div className="grid gap-2 md:grid-cols-2">
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  placeholder="Provider UUID"
                  value={offer.providerId}
                  onChange={(event) =>
                    setOffer({ ...offer, providerId: event.target.value })
                  }
                  required
                />
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  placeholder="Asset UUID"
                  value={offer.assetId}
                  onChange={(event) =>
                    setOffer({ ...offer, assetId: event.target.value })
                  }
                  required
                />
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  placeholder="Currency"
                  value={offer.currency}
                  onChange={(event) =>
                    setOffer({
                      ...offer,
                      currency: event.target.value.toUpperCase(),
                    })
                  }
                  required
                />
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  placeholder="Weekly price minor units"
                  inputMode="numeric"
                  value={offer.weeklyPriceMinor}
                  onChange={(event) =>
                    setOffer({ ...offer, weeklyPriceMinor: event.target.value })
                  }
                  required
                />
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  placeholder="Deposit minor units"
                  inputMode="numeric"
                  value={offer.depositMinor}
                  onChange={(event) =>
                    setOffer({ ...offer, depositMinor: event.target.value })
                  }
                  required
                />
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  placeholder="Included km/week"
                  inputMode="numeric"
                  value={offer.includedKmPerWeek}
                  onChange={(event) =>
                    setOffer({
                      ...offer,
                      includedKmPerWeek: event.target.value,
                    })
                  }
                  required
                />
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  placeholder="Excess km price minor"
                  inputMode="numeric"
                  value={offer.excessKmPriceMinor}
                  onChange={(event) =>
                    setOffer({
                      ...offer,
                      excessKmPriceMinor: event.target.value,
                    })
                  }
                  required
                />
                <input
                  className="rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                  placeholder="Minimum days"
                  inputMode="numeric"
                  value={offer.minimumDays}
                  onChange={(event) =>
                    setOffer({ ...offer, minimumDays: event.target.value })
                  }
                  required
                />
              </div>
              <button
                className="rounded-md bg-cyan-500 px-3 py-2 text-sm font-medium text-slate-950"
                disabled={offerMutation.isPending}
              >
                {offerMutation.isPending ? "Publishing…" : "Create offer"}
              </button>
            </form>
          </div>
        </section>

        <section className="border border-slate-800 bg-slate-950/40 p-5 text-sm text-slate-400">
          <div className="flex items-center gap-2 font-medium text-slate-200">
            <ShieldCheck className="h-4 w-4 text-cyan-300" /> Operational
            boundary
          </div>
          <p className="mt-2 leading-6">
            This workspace records vehicle-access operations only. It does not
            make automated credit decisions, unlock vehicles, issue insurance,
            perform remote immobilization, or settle ride funds. Any such
            integration requires separately approved jurisdictional, safety,
            privacy, and financial controls.
          </p>
          <div className="mt-3 flex items-center gap-2 text-slate-300">
            <ClipboardCheck className="h-4 w-4 text-cyan-300" /> Contract and
            inspection events are append-only evidence.
          </div>
        </section>
      </div>
    </DashboardLayout>
  );
}
