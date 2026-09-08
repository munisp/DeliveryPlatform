import { type FormEvent, useState } from "react";
import { MapPinned, RadioTower, ShieldAlert, ShieldCheck } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { useSessionProfile } from "@/lib/sessionProfile";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const inputClass =
  "w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100";
const operatorRoles = new Set([
  "operator",
  "ops",
  "admin",
  "platform_admin",
  "super_admin",
]);

function idempotency(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function asIso(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Enter a valid date and time.");
  }
  return parsed.toISOString();
}

export function VehicleTrackerSafetyPanel({
  onNotice,
}: {
  onNotice: (message: string) => void;
}) {
  const utils = trpc.useUtils();
  const sessionProfile = useSessionProfile();
  const isOperator = operatorRoles.has(sessionProfile.data?.role ?? "");
  const [consent, setConsent] = useState({
    contractId: "",
    consentVersion: "",
    consentSha256Hex: "",
  });
  const [trackerProvider, setTrackerProvider] = useState({
    fleetProviderId: "",
    providerKind: "generic_webhook" as
      | "generic_webhook"
      | "samsara_webhook"
      | "geotab_feed"
      | "traccar_rest"
      | "oem_gateway"
      | "aftermarket_gateway",
    integrationKey: "",
    displayName: "",
    credentialRef: "",
  });
  const [assetTracker, setAssetTracker] = useState({
    assetId: "",
    trackerProviderId: "",
    externalDeviceId: "",
    deviceIdentifierSha256: "",
    supportsPreventNextStart: false,
  });
  const [geofence, setGeofence] = useState({
    assetId: "",
    geofenceKind: "restricted" as "restricted" | "return_zone" | "service_zone",
    code: "",
    displayName: "",
    geojson: '{"type":"MultiPolygon","coordinates":[]}',
  });
  const [paymentSignal, setPaymentSignal] = useState({
    contractId: "",
    paymentReferenceSha256Hex: "",
    state: "past_due" as "past_due" | "cured" | "disputed" | "unknown",
    effectiveAt: "",
    graceEndsAt: "",
    evidenceSha256Hex: "",
    source: "rental_payment_authority",
  });
  const [controlRequest, setControlRequest] = useState({
    contractId: "",
    paymentTrackingSignalId: "",
    reasonCode: "rental.payment_grace_elapsed",
  });
  const [caseDecision, setCaseDecision] = useState({
    controlCaseId: "",
    cancellationReason: "",
  });

  const tracker = trpc.vehicleAccess.trackerOperationsSnapshot.useQuery(
    undefined,
    { refetchInterval: 30_000 },
  );
  const rental = trpc.vehicleAccess.rentalOperationsSnapshot.useQuery();
  const refresh = async (message: string) => {
    await Promise.all([
      utils.vehicleAccess.trackerOperationsSnapshot.invalidate(),
      utils.vehicleAccess.rentalOperationsSnapshot.invalidate(),
      utils.vehicleAccess.listContracts.invalidate(),
    ]);
    onNotice(message);
  };

  const recordConsent =
    trpc.vehicleAccess.recordTrackerControlConsent.useMutation({
      onSuccess: () => refresh("Immutable tracker-control consent recorded."),
      onError: (error) => onNotice(error.message),
    });
  const createTrackerProvider =
    trpc.vehicleAccess.createTrackerProvider.useMutation({
      onSuccess: (id) => refresh(`Tracker provider registered: ${id}`),
      onError: (error) => onNotice(error.message),
    });
  const registerAssetTracker =
    trpc.vehicleAccess.registerAssetTracker.useMutation({
      onSuccess: (id) => refresh(`Vehicle tracker registered: ${id}`),
      onError: (error) => onNotice(error.message),
    });
  const createGeofence =
    trpc.vehicleAccess.createRentalAssetGeofence.useMutation({
      onSuccess: (id) => refresh(`Rental geofence created: ${id}`),
      onError: (error) => onNotice(error.message),
    });
  const recordPaymentSignal =
    trpc.vehicleAccess.recordRentalPaymentTrackingSignal.useMutation({
      onSuccess: (id) =>
        refresh(`Non-financial payment signal recorded: ${id}`),
      onError: (error) => onNotice(error.message),
    });
  const requestPreventNextStart =
    trpc.vehicleAccess.requestPreventNextStart.useMutation({
      onSuccess: (id) => refresh(`Prevent-next-start review requested: ${id}`),
      onError: (error) => onNotice(error.message),
    });
  const authorizePreventNextStart =
    trpc.vehicleAccess.authorizePreventNextStart.useMutation({
      onSuccess: () =>
        refresh("Prevent-next-start control independently authorized."),
      onError: (error) => onNotice(error.message),
    });
  const cancelPreventNextStart =
    trpc.vehicleAccess.cancelPreventNextStart.useMutation({
      onSuccess: () => refresh("Prevent-next-start control cancelled."),
      onError: (error) => onNotice(error.message),
    });

  const submitConsent = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    recordConsent.mutate({
      ...consent,
      idempotencyKey: idempotency("tracker-consent"),
    });
  };
  const submitTrackerProvider = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    createTrackerProvider.mutate({
      ...trackerProvider,
      integrationKey: trackerProvider.integrationKey.toLowerCase(),
      idempotencyKey: idempotency("tracker-provider"),
    });
  };
  const submitAssetTracker = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    registerAssetTracker.mutate({
      ...assetTracker,
      idempotencyKey: idempotency("asset-tracker"),
    });
  };
  const submitGeofence = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const geojson = JSON.parse(geofence.geojson);
      if (
        !geojson ||
        geojson.type !== "MultiPolygon" ||
        !Array.isArray(geojson.coordinates)
      ) {
        throw new Error("Enter a GeoJSON MultiPolygon.");
      }
      createGeofence.mutate({
        assetId: geofence.assetId,
        geofenceKind: geofence.geofenceKind,
        code: geofence.code.toUpperCase(),
        displayName: geofence.displayName,
        geojson,
        idempotencyKey: idempotency("rental-geofence"),
      });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Invalid GeoJSON.");
    }
  };
  const submitPaymentSignal = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      recordPaymentSignal.mutate({
        ...paymentSignal,
        effectiveAt: asIso(paymentSignal.effectiveAt),
        graceEndsAt:
          paymentSignal.state === "past_due"
            ? asIso(paymentSignal.graceEndsAt)
            : null,
        idempotencyKey: idempotency("rental-payment-signal"),
      });
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "Invalid payment signal date.",
      );
    }
  };
  const submitControlRequest = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    requestPreventNextStart.mutate({
      ...controlRequest,
      idempotencyKey: idempotency("prevent-next-start-request"),
    });
  };
  const submitControlAuthorization = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    authorizePreventNextStart.mutate({
      controlCaseId: caseDecision.controlCaseId,
      idempotencyKey: idempotency("prevent-next-start-authorize"),
    });
  };
  const submitControlCancellation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    cancelPreventNextStart.mutate({
      controlCaseId: caseDecision.controlCaseId,
      reason: caseDecision.cancellationReason,
      idempotencyKey: idempotency("prevent-next-start-cancel"),
    });
  };

  const snapshot = tracker.data;
  const operatorCases = snapshot?.controlCases ?? [];
  const currentAssets = rental.data?.currentAssetLocations ?? [];
  const visibleContracts = rental.data?.upcomingReturns ?? [];

  return (
    <section className="space-y-5" aria-labelledby="tracker-safety-heading">
      <div className="border-b border-rose-400/30 pb-4">
        <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-[0.18em] text-rose-200">
          <RadioTower className="h-4 w-4" /> Vehicle tracking safety
        </div>
        <h2
          id="tracker-safety-heading"
          className="mt-2 text-xl font-semibold text-white"
        >
          GPS evidence, rental geofences, and stationary-only prevent-next-start
        </h2>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">
          Tracker data and geofence flags are durable PostgreSQL evidence. The
          platform never issues an engine-stop command and payment status never
          autonomously controls a vehicle. A prevent-next-start case needs
          explicit tracking consent, an uncured grace signal, fresh ignition-off
          and stationary telemetry, no emergency flag, and independent operator
          approval.
        </p>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Active trackers", snapshot?.activeTrackers ?? "—"],
          ["Recent risk flags", snapshot?.openFlags ?? "—"],
          ["Latest positions", snapshot?.recentPositions.length ?? "—"],
          ["Open safety cases", snapshot?.controlCases.length ?? "—"],
        ].map(([label, value]) => (
          <Card key={String(label)}>
            <CardHeader className="pb-2">
              <CardDescription>{label}</CardDescription>
              <CardTitle className="text-3xl">{value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Record tracker-control consent</CardTitle>
            <CardDescription>
              Consent is separate from the rental agreement and is immutable
              once recorded. It does not grant permission for in-motion
              shutdown.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={submitConsent}>
              <input
                className={inputClass}
                placeholder="Contract UUID"
                value={consent.contractId}
                onChange={(event) =>
                  setConsent({ ...consent, contractId: event.target.value })
                }
                required
              />
              <input
                className={inputClass}
                placeholder="Consent version"
                value={consent.consentVersion}
                onChange={(event) =>
                  setConsent({ ...consent, consentVersion: event.target.value })
                }
                required
              />
              <input
                className={`${inputClass} font-mono`}
                placeholder="Consent SHA-256 hex"
                pattern="[a-f0-9]{64}"
                value={consent.consentSha256Hex}
                onChange={(event) =>
                  setConsent({
                    ...consent,
                    consentSha256Hex: event.target.value,
                  })
                }
                required
              />
              <button
                className="rounded-md border border-slate-600 px-4 py-2 text-sm text-slate-100 disabled:opacity-60"
                disabled={recordConsent.isPending}
                type="submit"
              >
                {recordConsent.isPending
                  ? "Recording…"
                  : "Record control consent"}
              </button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Live tracker evidence</CardTitle>
            <CardDescription>
              Only the latest verified, normalized tracker signal for a contract
              is shown here. A blank list means no authorized telemetry is
              available.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {tracker.isFetching ? (
              <p className="text-sm text-slate-400">Refreshing tracker data…</p>
            ) : null}
            {tracker.isError ? (
              <p className="text-sm text-rose-300">{tracker.error.message}</p>
            ) : null}
            {snapshot?.recentPositions.length ? (
              snapshot.recentPositions.map((item) => (
                <div
                  className="border border-slate-800 p-3 text-sm"
                  key={item.trackerId}
                >
                  <p className="font-mono text-slate-200">{item.assetId}</p>
                  <p className="mt-1 text-slate-400">
                    {item.latitude.toFixed(5)}, {item.longitude.toFixed(5)} ·{" "}
                    {item.speedKph ?? "—"} kph · ignition{" "}
                    {item.ignitionOn === null
                      ? "unknown"
                      : item.ignitionOn
                        ? "on"
                        : "off"}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Observed {new Date(item.observedAt).toLocaleString()} ·
                    integrity {item.integrityScore}/100
                  </p>
                </div>
              ))
            ) : (
              <p className="text-sm text-slate-500">
                No tracker position is currently visible to this account.
              </p>
            )}
          </CardContent>
        </Card>
      </section>

      {isOperator ? (
        <section className="space-y-4 border border-rose-400/25 bg-rose-500/5 p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-rose-100">
            <ShieldAlert className="h-4 w-4 text-rose-200" aria-hidden="true" />
            Safety-gated operator controls
          </div>
          <p className="max-w-4xl text-sm leading-6 text-slate-400">
            These controls register tracker capabilities and create review
            cases; they do not dispatch a device command from the browser. The
            server and database independently enforce operator authority,
            consent, payment grace, tracker freshness, stationary ignition-off
            state, emergency exclusion, and two-person authorization.
          </p>
          <div className="grid gap-4 xl:grid-cols-3">
            <form
              className="space-y-2 border border-slate-800 p-4"
              onSubmit={submitTrackerProvider}
            >
              <p className="flex items-center gap-2 text-sm font-medium text-slate-100">
                <RadioTower className="h-4 w-4 text-cyan-300" /> Tracker
                provider
              </p>
              <input
                className={inputClass}
                placeholder="Fleet provider UUID"
                value={trackerProvider.fleetProviderId}
                onChange={(event) =>
                  setTrackerProvider({
                    ...trackerProvider,
                    fleetProviderId: event.target.value,
                  })
                }
                required
              />
              <select
                className={inputClass}
                value={trackerProvider.providerKind}
                onChange={(event) =>
                  setTrackerProvider({
                    ...trackerProvider,
                    providerKind: event.target
                      .value as typeof trackerProvider.providerKind,
                  })
                }
              >
                <option value="generic_webhook">Signed generic webhook</option>
                <option value="samsara_webhook">Samsara webhook</option>
                <option value="geotab_feed">Geotab cursor feed</option>
                <option value="traccar_rest">Traccar REST</option>
                <option value="oem_gateway">OEM gateway</option>
                <option value="aftermarket_gateway">Aftermarket gateway</option>
              </select>
              <input
                className={inputClass}
                placeholder="Integration key"
                value={trackerProvider.integrationKey}
                onChange={(event) =>
                  setTrackerProvider({
                    ...trackerProvider,
                    integrationKey: event.target.value,
                  })
                }
                required
              />
              <input
                className={inputClass}
                placeholder="Display name"
                value={trackerProvider.displayName}
                onChange={(event) =>
                  setTrackerProvider({
                    ...trackerProvider,
                    displayName: event.target.value,
                  })
                }
                required
              />
              <input
                className={inputClass}
                placeholder="Server-side credential reference"
                value={trackerProvider.credentialRef}
                onChange={(event) =>
                  setTrackerProvider({
                    ...trackerProvider,
                    credentialRef: event.target.value,
                  })
                }
                required
              />
              <button
                className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100 disabled:opacity-60"
                disabled={createTrackerProvider.isPending}
                type="submit"
              >
                {createTrackerProvider.isPending
                  ? "Registering…"
                  : "Register tracker provider"}
              </button>
            </form>

            <form
              className="space-y-2 border border-slate-800 p-4"
              onSubmit={submitAssetTracker}
            >
              <p className="flex items-center gap-2 text-sm font-medium text-slate-100">
                <ShieldCheck className="h-4 w-4 text-cyan-300" /> Asset tracker
              </p>
              <select
                className={inputClass}
                value={assetTracker.assetId}
                onChange={(event) =>
                  setAssetTracker({
                    ...assetTracker,
                    assetId: event.target.value,
                  })
                }
                required
              >
                <option value="">Select an asset</option>
                {currentAssets.map((asset) => (
                  <option key={asset.assetId} value={asset.assetId}>
                    {asset.registrationNumber} · {asset.make} {asset.model}
                  </option>
                ))}
              </select>
              <input
                className={inputClass}
                placeholder="Tracker provider UUID"
                value={assetTracker.trackerProviderId}
                onChange={(event) =>
                  setAssetTracker({
                    ...assetTracker,
                    trackerProviderId: event.target.value,
                  })
                }
                required
              />
              <input
                className={inputClass}
                placeholder="Provider device ID"
                value={assetTracker.externalDeviceId}
                onChange={(event) =>
                  setAssetTracker({
                    ...assetTracker,
                    externalDeviceId: event.target.value,
                  })
                }
                required
              />
              <input
                className={`${inputClass} font-mono`}
                placeholder="Device identity SHA-256 hex"
                pattern="[a-f0-9]{64}"
                value={assetTracker.deviceIdentifierSha256}
                onChange={(event) =>
                  setAssetTracker({
                    ...assetTracker,
                    deviceIdentifierSha256: event.target.value,
                  })
                }
                required
              />
              <label className="flex items-center gap-2 text-sm text-slate-300">
                <input
                  checked={assetTracker.supportsPreventNextStart}
                  onChange={(event) =>
                    setAssetTracker({
                      ...assetTracker,
                      supportsPreventNextStart: event.target.checked,
                    })
                  }
                  type="checkbox"
                />{" "}
                Vendor-certified prevent-next-start capability
              </label>
              <button
                className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100 disabled:opacity-60"
                disabled={registerAssetTracker.isPending}
                type="submit"
              >
                {registerAssetTracker.isPending
                  ? "Registering…"
                  : "Register asset tracker"}
              </button>
            </form>

            <form
              className="space-y-2 border border-slate-800 p-4"
              onSubmit={submitGeofence}
            >
              <p className="flex items-center gap-2 text-sm font-medium text-slate-100">
                <MapPinned className="h-4 w-4 text-cyan-300" /> Rental geofence
              </p>
              <select
                className={inputClass}
                value={geofence.assetId}
                onChange={(event) =>
                  setGeofence({ ...geofence, assetId: event.target.value })
                }
                required
              >
                <option value="">Select an asset</option>
                {currentAssets.map((asset) => (
                  <option key={asset.assetId} value={asset.assetId}>
                    {asset.registrationNumber}
                  </option>
                ))}
              </select>
              <select
                className={inputClass}
                value={geofence.geofenceKind}
                onChange={(event) =>
                  setGeofence({
                    ...geofence,
                    geofenceKind: event.target
                      .value as typeof geofence.geofenceKind,
                  })
                }
              >
                <option value="restricted">Restricted</option>
                <option value="return_zone">Return zone</option>
                <option value="service_zone">Service zone</option>
              </select>
              <input
                className={inputClass}
                placeholder="Fence code"
                value={geofence.code}
                onChange={(event) =>
                  setGeofence({ ...geofence, code: event.target.value })
                }
                required
              />
              <input
                className={inputClass}
                placeholder="Display name"
                value={geofence.displayName}
                onChange={(event) =>
                  setGeofence({ ...geofence, displayName: event.target.value })
                }
                required
              />
              <textarea
                className={`${inputClass} min-h-24 font-mono text-xs`}
                aria-label="GeoJSON MultiPolygon"
                value={geofence.geojson}
                onChange={(event) =>
                  setGeofence({ ...geofence, geojson: event.target.value })
                }
                required
              />
              <button
                className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100 disabled:opacity-60"
                disabled={createGeofence.isPending}
                type="submit"
              >
                {createGeofence.isPending ? "Creating…" : "Create geofence"}
              </button>
            </form>
          </div>

          <section className="grid gap-4 xl:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Record payment risk signal</CardTitle>
                <CardDescription>
                  Reference/hash evidence only. This does not charge, settle,
                  reverse, or transfer money.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-3" onSubmit={submitPaymentSignal}>
                  <input
                    className={inputClass}
                    placeholder="Contract UUID"
                    value={paymentSignal.contractId}
                    onChange={(event) =>
                      setPaymentSignal({
                        ...paymentSignal,
                        contractId: event.target.value,
                      })
                    }
                    required
                  />
                  <input
                    className={`${inputClass} font-mono`}
                    placeholder="Payment reference SHA-256 hex"
                    pattern="[a-f0-9]{64}"
                    value={paymentSignal.paymentReferenceSha256Hex}
                    onChange={(event) =>
                      setPaymentSignal({
                        ...paymentSignal,
                        paymentReferenceSha256Hex: event.target.value,
                      })
                    }
                    required
                  />
                  <select
                    className={inputClass}
                    value={paymentSignal.state}
                    onChange={(event) =>
                      setPaymentSignal({
                        ...paymentSignal,
                        state: event.target.value as typeof paymentSignal.state,
                      })
                    }
                  >
                    <option value="past_due">Past due</option>
                    <option value="cured">Cured</option>
                    <option value="disputed">Disputed</option>
                    <option value="unknown">Unknown</option>
                  </select>
                  <label className="text-sm text-slate-300">
                    Effective at
                    <input
                      className={`${inputClass} mt-1`}
                      type="datetime-local"
                      value={paymentSignal.effectiveAt}
                      onChange={(event) =>
                        setPaymentSignal({
                          ...paymentSignal,
                          effectiveAt: event.target.value,
                        })
                      }
                      required
                    />
                  </label>
                  {paymentSignal.state === "past_due" ? (
                    <label className="text-sm text-slate-300">
                      Grace ends at
                      <input
                        className={`${inputClass} mt-1`}
                        type="datetime-local"
                        value={paymentSignal.graceEndsAt}
                        onChange={(event) =>
                          setPaymentSignal({
                            ...paymentSignal,
                            graceEndsAt: event.target.value,
                          })
                        }
                        required
                      />
                    </label>
                  ) : null}
                  <input
                    className={`${inputClass} font-mono`}
                    placeholder="Evidence SHA-256 hex"
                    pattern="[a-f0-9]{64}"
                    value={paymentSignal.evidenceSha256Hex}
                    onChange={(event) =>
                      setPaymentSignal({
                        ...paymentSignal,
                        evidenceSha256Hex: event.target.value,
                      })
                    }
                    required
                  />
                  <input
                    className={inputClass}
                    placeholder="Evidence source"
                    value={paymentSignal.source}
                    onChange={(event) =>
                      setPaymentSignal({
                        ...paymentSignal,
                        source: event.target.value,
                      })
                    }
                    required
                  />
                  <button
                    className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100 disabled:opacity-60"
                    disabled={recordPaymentSignal.isPending}
                    type="submit"
                  >
                    {recordPaymentSignal.isPending
                      ? "Recording…"
                      : "Record risk signal"}
                  </button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Request prevent-next-start review</CardTitle>
                <CardDescription>
                  Only a stationary, ignition-off asset with consent and an
                  uncured grace signal can enter review.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-3" onSubmit={submitControlRequest}>
                  <select
                    className={inputClass}
                    value={controlRequest.contractId}
                    onChange={(event) =>
                      setControlRequest({
                        ...controlRequest,
                        contractId: event.target.value,
                      })
                    }
                    required
                  >
                    <option value="">Select active/return contract</option>
                    {visibleContracts.map((contract) => (
                      <option
                        key={contract.contractId}
                        value={contract.contractId}
                      >
                        {contract.reference} · {contract.state}
                      </option>
                    ))}
                  </select>
                  <input
                    className={inputClass}
                    placeholder="Payment tracking signal UUID"
                    value={controlRequest.paymentTrackingSignalId}
                    onChange={(event) =>
                      setControlRequest({
                        ...controlRequest,
                        paymentTrackingSignalId: event.target.value,
                      })
                    }
                    required
                  />
                  <input
                    className={inputClass}
                    placeholder="Reason code"
                    value={controlRequest.reasonCode}
                    onChange={(event) =>
                      setControlRequest({
                        ...controlRequest,
                        reasonCode: event.target.value,
                      })
                    }
                    required
                  />
                  <button
                    className="rounded-md border border-rose-400/60 px-3 py-2 text-sm text-rose-100 disabled:opacity-60"
                    disabled={requestPreventNextStart.isPending}
                    type="submit"
                  >
                    {requestPreventNextStart.isPending
                      ? "Checking interlocks…"
                      : "Request safety review"}
                  </button>
                </form>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Independent authorization or cancellation</CardTitle>
                <CardDescription>
                  The requester cannot authorize their own case. Browser actions
                  never contact a tracker.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <form
                  className="space-y-3"
                  onSubmit={submitControlAuthorization}
                >
                  <select
                    className={inputClass}
                    value={caseDecision.controlCaseId}
                    onChange={(event) =>
                      setCaseDecision({
                        ...caseDecision,
                        controlCaseId: event.target.value,
                      })
                    }
                    required
                  >
                    <option value="">Select control case</option>
                    {operatorCases.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.state} · {item.reasonCode} · expires{" "}
                        {new Date(item.expiresAt).toLocaleTimeString()}
                      </option>
                    ))}
                  </select>
                  <button
                    className="rounded-md border border-amber-400/60 px-3 py-2 text-sm text-amber-100 disabled:opacity-60"
                    disabled={authorizePreventNextStart.isPending}
                    type="submit"
                  >
                    {authorizePreventNextStart.isPending
                      ? "Authorizing…"
                      : "Independently authorize"}
                  </button>
                </form>
                <form
                  className="space-y-3"
                  onSubmit={submitControlCancellation}
                >
                  <input
                    className={inputClass}
                    placeholder="Cancellation reason"
                    minLength={3}
                    maxLength={1000}
                    value={caseDecision.cancellationReason}
                    onChange={(event) =>
                      setCaseDecision({
                        ...caseDecision,
                        cancellationReason: event.target.value,
                      })
                    }
                    required
                  />
                  <button
                    className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100 disabled:opacity-60"
                    disabled={cancelPreventNextStart.isPending}
                    type="submit"
                  >
                    {cancelPreventNextStart.isPending
                      ? "Cancelling…"
                      : "Cancel safety case"}
                  </button>
                </form>
              </CardContent>
            </Card>
          </section>

          <section className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Recent tracker flags</CardTitle>
                <CardDescription>
                  Flags are immutable evidence, including tamper, geofence,
                  stale-data, integrity, and signal-consistency conditions.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {snapshot?.recentFlags.length ? (
                  snapshot.recentFlags.map((flag) => (
                    <div
                      className="border border-slate-800 p-3 text-sm"
                      key={flag.id}
                    >
                      <p className="font-medium text-slate-100">
                        {flag.flagCode.replaceAll("_", " ")} · {flag.severity}
                      </p>
                      <p className="mt-1 text-slate-400">
                        Asset {flag.assetId} ·{" "}
                        {new Date(flag.detectedAt).toLocaleString()}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-slate-500">
                    No tracker flags are currently in the authorized snapshot.
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Open control cases</CardTitle>
                <CardDescription>
                  Cases expire quickly. Only the trusted internal adapter may
                  claim an independently authorized case, and it rechecks every
                  safety interlock immediately before any dispatch.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {operatorCases.length ? (
                  operatorCases.map((item) => (
                    <div
                      className="border border-slate-800 p-3 text-sm"
                      key={item.id}
                    >
                      <p className="font-medium text-slate-100">
                        {item.state} · {item.reasonCode}
                      </p>
                      <p className="mt-1 text-slate-400">
                        Contract {item.contractId} · expires{" "}
                        {new Date(item.expiresAt).toLocaleString()}
                      </p>
                    </div>
                  ))
                ) : (
                  <p className="text-sm text-slate-500">
                    No requested, authorized, or dispatched control cases.
                  </p>
                )}
              </CardContent>
            </Card>
          </section>
        </section>
      ) : (
        <p className="border border-slate-800 bg-slate-950/50 p-4 text-sm text-slate-400">
          Fleet tracker setup, geofence creation, payment-risk evidence, and
          control case handling are visible only to operator roles. The
          authenticated service and PostgreSQL authority independently enforce
          this restriction.
        </p>
      )}
    </section>
  );
}
