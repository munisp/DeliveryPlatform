import { FormEvent, useMemo, useState } from "react";
import { CalendarClock, FileCheck2, MapPin, PackagePlus } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { useSessionProfile } from "@/lib/sessionProfile";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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

const inputClass =
  "w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100";
const operatorRoles = new Set([
  "operator",
  "ops",
  "admin",
  "platform_admin",
  "super_admin",
]);

export function VehicleRentalOperationsPanel({
  onNotice,
}: {
  onNotice: (message: string) => void;
}) {
  const utils = trpc.useUtils();
  const sessionProfile = useSessionProfile();
  const isOperator = operatorRoles.has(sessionProfile.data?.role ?? "");
  const [offerId, setOfferId] = useState("");
  const [contract, setContract] = useState({
    startsAt: "",
    endsAt: "",
    quantities: {} as Record<string, number>,
  });
  const [agreement, setAgreement] = useState({
    contractId: "",
    agreementVersion: "",
    agreementSha256Hex: "",
    acceptanceSha256Hex: "",
  });
  const [extension, setExtension] = useState({
    contractId: "",
    requestedEndsAt: "",
  });
  const [location, setLocation] = useState({
    providerId: "",
    locationCode: "",
    displayName: "",
    addressSummary: "",
    timezoneName: "Africa/Lagos",
  });
  const [block, setBlock] = useState({
    assetId: "",
    reason: "maintenance" as
      | "maintenance"
      | "inspection"
      | "operator_hold"
      | "seasonal_unavailable"
      | "repair",
    note: "",
    startsAt: "",
    endsAt: "",
  });
  const [addOn, setAddOn] = useState({
    providerId: "",
    addOnCode: "",
    displayName: "",
    category: "equipment" as
      | "protection"
      | "equipment"
      | "fuel_plan"
      | "additional_driver"
      | "assistance"
      | "other",
    currency: "NGN",
    chargeUnit: "flat" as "flat" | "per_day" | "per_week",
    unitPriceMinor: "",
    maxQuantity: "1",
  });
  const [assignment, setAssignment] = useState({ assetId: "", locationId: "" });
  const [blockCancellation, setBlockCancellation] = useState({
    availabilityBlockId: "",
    reason: "",
  });
  const [extensionDecision, setExtensionDecision] = useState({
    extensionRequestId: "",
    action: "approve" as "approve" | "reject",
    reason: "",
  });

  const addOns = trpc.vehicleAccess.listRentalAddOns.useQuery(
    { offerId, limit: 24 },
    { enabled: /^[0-9a-fA-F-]{36}$/.test(offerId) },
  );
  const operations = trpc.vehicleAccess.rentalOperationsSnapshot.useQuery(
    undefined,
    { refetchInterval: 30_000 },
  );

  const refresh = async (message: string) => {
    await Promise.all([
      utils.vehicleAccess.listOffers.invalidate(),
      utils.vehicleAccess.listContracts.invalidate(),
      utils.vehicleAccess.rentalOperationsSnapshot.invalidate(),
      utils.vehicleAccess.listRentalAddOns.invalidate(),
    ]);
    onNotice(message);
  };

  const requestWithAddOns =
    trpc.vehicleAccess.requestContractWithAddOns.useMutation({
      onSuccess: (id) =>
        refresh(`Rental request with frozen add-ons recorded: ${id}`),
      onError: (error) => onNotice(error.message),
    });
  const acceptAgreement = trpc.vehicleAccess.acceptAgreement.useMutation({
    onSuccess: () => refresh("Immutable agreement acceptance recorded."),
    onError: (error) => onNotice(error.message),
  });
  const requestExtension = trpc.vehicleAccess.requestExtension.useMutation({
    onSuccess: (id) => refresh(`Extension request recorded: ${id}`),
    onError: (error) => onNotice(error.message),
  });
  const createLocation = trpc.vehicleAccess.createProviderLocation.useMutation({
    onSuccess: (id) => refresh(`Fleet location created: ${id}`),
    onError: (error) => onNotice(error.message),
  });
  const createBlock = trpc.vehicleAccess.createAvailabilityBlock.useMutation({
    onSuccess: (id) => refresh(`Availability block created: ${id}`),
    onError: (error) => onNotice(error.message),
  });
  const createAddOn = trpc.vehicleAccess.createRentalAddOn.useMutation({
    onSuccess: (id) => refresh(`Rental add-on created: ${id}`),
    onError: (error) => onNotice(error.message),
  });
  const assignLocation = trpc.vehicleAccess.assignAssetLocation.useMutation({
    onSuccess: (id) => refresh(`Asset location assignment recorded: ${id}`),
    onError: (error) => onNotice(error.message),
  });
  const cancelBlock = trpc.vehicleAccess.cancelAvailabilityBlock.useMutation({
    onSuccess: () => refresh("Availability block cancelled."),
    onError: (error) => onNotice(error.message),
  });
  const decideExtension = trpc.vehicleAccess.decideExtension.useMutation({
    onSuccess: (state) => refresh(`Extension ${state}.`),
    onError: (error) => onNotice(error.message),
  });

  const snapshot = operations.data;
  const selectedAddOns = useMemo(
    () =>
      (addOns.data ?? [])
        .map((item) => ({
          addOnVersionId: item.id,
          quantity: contract.quantities[item.id] ?? 0,
        }))
        .filter((item) => item.quantity > 0),
    [addOns.data, contract.quantities],
  );
  const selectedAsset = snapshot?.currentAssetLocations.find(
    (asset) => asset.assetId === assignment.assetId,
  );
  const assignmentLocations = (snapshot?.providerLocations ?? []).filter(
    (item) => item.providerId === selectedAsset?.providerId,
  );

  const submitRentalRequest = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      requestWithAddOns.mutate({
        offerId,
        startsAt: asIso(contract.startsAt),
        endsAt: asIso(contract.endsAt),
        addOns: selectedAddOns,
        idempotencyKey: idempotency("rental-request"),
      });
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "Invalid rental request.",
      );
    }
  };

  const submitAgreement = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    acceptAgreement.mutate({
      ...agreement,
      idempotencyKey: idempotency("rental-agreement"),
    });
  };

  const submitExtension = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      requestExtension.mutate({
        contractId: extension.contractId,
        requestedEndsAt: asIso(extension.requestedEndsAt),
        idempotencyKey: idempotency("rental-extension"),
      });
    } catch (error) {
      onNotice(
        error instanceof Error ? error.message : "Invalid extension date.",
      );
    }
  };

  const submitLocation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    createLocation.mutate({
      ...location,
      locationCode: location.locationCode.toUpperCase(),
      idempotencyKey: idempotency("rental-location"),
    });
  };

  const submitBlock = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      createBlock.mutate({
        ...block,
        startsAt: asIso(block.startsAt),
        endsAt: asIso(block.endsAt),
        idempotencyKey: idempotency("rental-block"),
      });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Invalid block dates.");
    }
  };

  const submitAddOn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    createAddOn.mutate({
      ...addOn,
      addOnCode: addOn.addOnCode.toLowerCase(),
      unitPriceMinor: Number(addOn.unitPriceMinor),
      maxQuantity: Number(addOn.maxQuantity),
      idempotencyKey: idempotency("rental-add-on"),
    });
  };

  const submitAssignment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    assignLocation.mutate({
      ...assignment,
      idempotencyKey: idempotency("asset-location"),
    });
  };

  const submitBlockCancellation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    cancelBlock.mutate({
      ...blockCancellation,
      idempotencyKey: idempotency("rental-block-cancel"),
    });
  };

  const submitExtensionDecision = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    decideExtension.mutate({
      extensionRequestId: extensionDecision.extensionRequestId,
      action: extensionDecision.action,
      reason:
        extensionDecision.action === "reject" ? extensionDecision.reason : null,
      idempotencyKey: idempotency("rental-extension-decision"),
    });
  };

  return (
    <section className="space-y-5" aria-labelledby="rental-operations-heading">
      <div className="border-b border-slate-800 pb-4">
        <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
          <CalendarClock className="h-4 w-4" /> Rental operations
        </div>
        <h2
          id="rental-operations-heading"
          className="mt-2 text-xl font-semibold text-white"
        >
          Locations, availability, frozen add-ons, agreement evidence, and
          extensions
        </h2>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">
          Requests preserve the selected add-on price snapshot. Availability
          conflicts, eligibility, contract state, agreement acceptance, and
          operator decisions are enforced by PostgreSQL. This workspace does not
          capture deposits, issue credit, or alter settled funds.
        </p>
      </div>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          [
            "Active availability blocks",
            snapshot?.activeAvailabilityBlocks ?? "—",
          ],
          [
            "Extensions awaiting operator",
            snapshot?.requestedExtensions ?? "—",
          ],
          ["Upcoming pickups", snapshot?.upcomingPickups.length ?? "—"],
          ["Upcoming returns", snapshot?.upcomingReturns.length ?? "—"],
        ].map(([label, value]) => (
          <Card key={String(label)}>
            <CardHeader className="pb-2">
              <CardDescription>{label}</CardDescription>
              <CardTitle className="text-3xl">{value}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.45fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Build a rental request</CardTitle>
            <CardDescription>
              Enter an active offer ID to view compatible add-ons. Selected
              add-ons are immutable once the request is recorded.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={submitRentalRequest}>
              <input
                className={inputClass}
                placeholder="Offer UUID"
                value={offerId}
                onChange={(event) => setOfferId(event.target.value)}
                required
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm text-slate-300">
                  Start
                  <input
                    className={`${inputClass} mt-1`}
                    type="datetime-local"
                    value={contract.startsAt}
                    onChange={(event) =>
                      setContract({ ...contract, startsAt: event.target.value })
                    }
                    required
                  />
                </label>
                <label className="text-sm text-slate-300">
                  End
                  <input
                    className={`${inputClass} mt-1`}
                    type="datetime-local"
                    value={contract.endsAt}
                    onChange={(event) =>
                      setContract({ ...contract, endsAt: event.target.value })
                    }
                    required
                  />
                </label>
              </div>
              {addOns.isFetching ? (
                <p className="text-sm text-slate-400">
                  Loading compatible add-ons…
                </p>
              ) : null}
              {addOns.isError ? (
                <p className="text-sm text-rose-300">{addOns.error.message}</p>
              ) : null}
              {addOns.data?.length ? (
                <div className="space-y-2 border border-slate-800 p-3">
                  <p className="text-sm font-medium text-slate-100">
                    Compatible add-ons
                  </p>
                  {addOns.data.map((item) => (
                    <label
                      key={item.id}
                      className="grid grid-cols-[1fr_72px] items-center gap-3 text-sm text-slate-300"
                    >
                      <span>
                        {item.displayName} · {item.currency}{" "}
                        {(item.unitPriceMinor / 100).toLocaleString()} ·{" "}
                        {item.chargeUnit.replace("_", " ")}
                      </span>
                      <input
                        className={inputClass}
                        aria-label={`${item.displayName} quantity`}
                        inputMode="numeric"
                        min="0"
                        max={item.maxQuantity}
                        type="number"
                        value={contract.quantities[item.id] ?? 0}
                        onChange={(event) =>
                          setContract({
                            ...contract,
                            quantities: {
                              ...contract.quantities,
                              [item.id]: Number(event.target.value),
                            },
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
              ) : null}
              <button
                className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-60"
                disabled={requestWithAddOns.isPending}
                type="submit"
              >
                {requestWithAddOns.isPending
                  ? "Recording…"
                  : "Request access with selected add-ons"}
              </button>
            </form>
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Accept agreement</CardTitle>
              <CardDescription>
                Handover requires worker-bound agreement-hash evidence in
                addition to inspection evidence.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={submitAgreement}>
                <input
                  className={inputClass}
                  placeholder="Contract UUID"
                  value={agreement.contractId}
                  onChange={(event) =>
                    setAgreement({
                      ...agreement,
                      contractId: event.target.value,
                    })
                  }
                  required
                />
                <input
                  className={inputClass}
                  placeholder="Agreement version"
                  value={agreement.agreementVersion}
                  onChange={(event) =>
                    setAgreement({
                      ...agreement,
                      agreementVersion: event.target.value,
                    })
                  }
                  required
                />
                <input
                  className={`${inputClass} font-mono`}
                  placeholder="Agreement SHA-256 hex"
                  pattern="[a-f0-9]{64}"
                  value={agreement.agreementSha256Hex}
                  onChange={(event) =>
                    setAgreement({
                      ...agreement,
                      agreementSha256Hex: event.target.value,
                    })
                  }
                  required
                />
                <input
                  className={`${inputClass} font-mono`}
                  placeholder="Acceptance SHA-256 hex"
                  pattern="[a-f0-9]{64}"
                  value={agreement.acceptanceSha256Hex}
                  onChange={(event) =>
                    setAgreement({
                      ...agreement,
                      acceptanceSha256Hex: event.target.value,
                    })
                  }
                  required
                />
                <button
                  className="rounded-md border border-slate-600 px-4 py-2 text-sm text-slate-100 disabled:opacity-60"
                  disabled={acceptAgreement.isPending}
                  type="submit"
                >
                  {acceptAgreement.isPending
                    ? "Recording…"
                    : "Record agreement acceptance"}
                </button>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Request extension</CardTitle>
              <CardDescription>
                Extensions remain pending until an operator approves an
                availability-safe end date.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={submitExtension}>
                <input
                  className={inputClass}
                  placeholder="Contract UUID"
                  value={extension.contractId}
                  onChange={(event) =>
                    setExtension({
                      ...extension,
                      contractId: event.target.value,
                    })
                  }
                  required
                />
                <input
                  className={inputClass}
                  type="datetime-local"
                  value={extension.requestedEndsAt}
                  onChange={(event) =>
                    setExtension({
                      ...extension,
                      requestedEndsAt: event.target.value,
                    })
                  }
                  required
                />
                <button
                  className="rounded-md border border-slate-600 px-4 py-2 text-sm text-slate-100 disabled:opacity-60"
                  disabled={requestExtension.isPending}
                  type="submit"
                >
                  {requestExtension.isPending
                    ? "Requesting…"
                    : "Request extension"}
                </button>
              </form>
            </CardContent>
          </Card>
        </div>
      </section>

      {operations.isError ? (
        <p className="text-sm text-rose-300">{operations.error.message}</p>
      ) : null}
      {isOperator ? (
        <section className="space-y-4 border border-amber-400/25 bg-amber-500/5 p-5">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-100">
            <FileCheck2 className="h-4 w-4 text-amber-200" aria-hidden="true" />
            Operator operations
          </div>
          <p className="text-sm leading-6 text-slate-400">
            The server and database independently enforce fleet-operator
            authority. The live queue below comes only from the authorized
            snapshot function; direct table writes remain revoked.
          </p>
          <div className="grid gap-4 xl:grid-cols-3">
            <form
              className="space-y-2 border border-slate-800 p-4"
              onSubmit={submitLocation}
            >
              <p className="flex items-center gap-2 text-sm font-medium text-slate-100">
                <MapPin className="h-4 w-4 text-cyan-300" /> Fleet location
              </p>
              <input
                className={inputClass}
                placeholder="Provider UUID"
                value={location.providerId}
                onChange={(event) =>
                  setLocation({ ...location, providerId: event.target.value })
                }
                required
              />
              <input
                className={inputClass}
                placeholder="Location code, e.g. LAG_IKEJA"
                value={location.locationCode}
                onChange={(event) =>
                  setLocation({ ...location, locationCode: event.target.value })
                }
                required
              />
              <input
                className={inputClass}
                placeholder="Display name"
                value={location.displayName}
                onChange={(event) =>
                  setLocation({ ...location, displayName: event.target.value })
                }
                required
              />
              <input
                className={inputClass}
                placeholder="Address summary"
                value={location.addressSummary}
                onChange={(event) =>
                  setLocation({
                    ...location,
                    addressSummary: event.target.value,
                  })
                }
                required
              />
              <input
                className={inputClass}
                placeholder="IANA timezone"
                value={location.timezoneName}
                onChange={(event) =>
                  setLocation({ ...location, timezoneName: event.target.value })
                }
                required
              />
              <button
                className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100 disabled:opacity-60"
                disabled={createLocation.isPending}
                type="submit"
              >
                {createLocation.isPending ? "Creating…" : "Create location"}
              </button>
            </form>

            <form
              className="space-y-2 border border-slate-800 p-4"
              onSubmit={submitBlock}
            >
              <p className="flex items-center gap-2 text-sm font-medium text-slate-100">
                <CalendarClock className="h-4 w-4 text-cyan-300" /> Availability
                block
              </p>
              <select
                className={inputClass}
                value={block.assetId}
                onChange={(event) =>
                  setBlock({ ...block, assetId: event.target.value })
                }
                required
              >
                <option value="">Select an asset</option>
                {snapshot?.currentAssetLocations.map((asset) => (
                  <option key={asset.assetId} value={asset.assetId}>
                    {asset.registrationNumber} · {asset.make} {asset.model}
                  </option>
                ))}
              </select>
              <select
                className={inputClass}
                value={block.reason}
                onChange={(event) =>
                  setBlock({
                    ...block,
                    reason: event.target.value as typeof block.reason,
                  })
                }
              >
                <option value="maintenance">Maintenance</option>
                <option value="inspection">Inspection</option>
                <option value="operator_hold">Operator hold</option>
                <option value="seasonal_unavailable">
                  Seasonal unavailable
                </option>
                <option value="repair">Repair</option>
              </select>
              <input
                className={inputClass}
                placeholder="Reason note"
                minLength={3}
                maxLength={1000}
                value={block.note}
                onChange={(event) =>
                  setBlock({ ...block, note: event.target.value })
                }
                required
              />
              <input
                className={inputClass}
                type="datetime-local"
                value={block.startsAt}
                onChange={(event) =>
                  setBlock({ ...block, startsAt: event.target.value })
                }
                required
              />
              <input
                className={inputClass}
                type="datetime-local"
                value={block.endsAt}
                onChange={(event) =>
                  setBlock({ ...block, endsAt: event.target.value })
                }
                required
              />
              <button
                className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100 disabled:opacity-60"
                disabled={createBlock.isPending}
                type="submit"
              >
                {createBlock.isPending ? "Creating…" : "Create block"}
              </button>
            </form>

            <form
              className="space-y-2 border border-slate-800 p-4"
              onSubmit={submitAddOn}
            >
              <p className="flex items-center gap-2 text-sm font-medium text-slate-100">
                <PackagePlus className="h-4 w-4 text-cyan-300" /> Rental add-on
              </p>
              <input
                className={inputClass}
                placeholder="Provider UUID"
                value={addOn.providerId}
                onChange={(event) =>
                  setAddOn({ ...addOn, providerId: event.target.value })
                }
                required
              />
              <input
                className={inputClass}
                placeholder="Code, e.g. safety_kit"
                value={addOn.addOnCode}
                onChange={(event) =>
                  setAddOn({ ...addOn, addOnCode: event.target.value })
                }
                required
              />
              <input
                className={inputClass}
                placeholder="Display name"
                value={addOn.displayName}
                onChange={(event) =>
                  setAddOn({ ...addOn, displayName: event.target.value })
                }
                required
              />
              <div className="grid grid-cols-2 gap-2">
                <select
                  className={inputClass}
                  value={addOn.category}
                  onChange={(event) =>
                    setAddOn({
                      ...addOn,
                      category: event.target.value as typeof addOn.category,
                    })
                  }
                >
                  <option value="equipment">Equipment</option>
                  <option value="protection">Protection</option>
                  <option value="fuel_plan">Fuel plan</option>
                  <option value="additional_driver">Additional driver</option>
                  <option value="assistance">Assistance</option>
                  <option value="other">Other</option>
                </select>
                <select
                  className={inputClass}
                  value={addOn.chargeUnit}
                  onChange={(event) =>
                    setAddOn({
                      ...addOn,
                      chargeUnit: event.target.value as typeof addOn.chargeUnit,
                    })
                  }
                >
                  <option value="flat">Flat</option>
                  <option value="per_day">Per day</option>
                  <option value="per_week">Per week</option>
                </select>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <input
                  className={inputClass}
                  placeholder="Currency"
                  maxLength={3}
                  value={addOn.currency}
                  onChange={(event) =>
                    setAddOn({
                      ...addOn,
                      currency: event.target.value.toUpperCase(),
                    })
                  }
                  required
                />
                <input
                  className={inputClass}
                  placeholder="Minor price"
                  inputMode="numeric"
                  value={addOn.unitPriceMinor}
                  onChange={(event) =>
                    setAddOn({ ...addOn, unitPriceMinor: event.target.value })
                  }
                  required
                />
                <input
                  className={inputClass}
                  placeholder="Max qty"
                  inputMode="numeric"
                  value={addOn.maxQuantity}
                  onChange={(event) =>
                    setAddOn({ ...addOn, maxQuantity: event.target.value })
                  }
                  required
                />
              </div>
              <button
                className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100 disabled:opacity-60"
                disabled={createAddOn.isPending}
                type="submit"
              >
                {createAddOn.isPending ? "Creating…" : "Create add-on"}
              </button>
            </form>
          </div>

          <section className="grid gap-4 xl:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>Assign asset location</CardTitle>
                <CardDescription>
                  The assignment is append-only; the latest assignment is the
                  current operational location.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-3" onSubmit={submitAssignment}>
                  <select
                    className={inputClass}
                    value={assignment.assetId}
                    onChange={(event) =>
                      setAssignment({
                        assetId: event.target.value,
                        locationId: "",
                      })
                    }
                    required
                  >
                    <option value="">Select an asset</option>
                    {snapshot?.currentAssetLocations.map((asset) => (
                      <option key={asset.assetId} value={asset.assetId}>
                        {asset.registrationNumber} ·{" "}
                        {asset.locationName ?? "No location"}
                      </option>
                    ))}
                  </select>
                  <select
                    className={inputClass}
                    value={assignment.locationId}
                    onChange={(event) =>
                      setAssignment({
                        ...assignment,
                        locationId: event.target.value,
                      })
                    }
                    disabled={!assignment.assetId}
                    required
                  >
                    <option value="">
                      Select a compatible provider location
                    </option>
                    {assignmentLocations.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.locationCode} · {item.displayName}
                      </option>
                    ))}
                  </select>
                  <button
                    className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100 disabled:opacity-60"
                    disabled={assignLocation.isPending}
                    type="submit"
                  >
                    {assignLocation.isPending
                      ? "Assigning…"
                      : "Assign location"}
                  </button>
                </form>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Cancel availability block</CardTitle>
                <CardDescription>
                  Cancelling a block preserves the original record and emits a
                  separate operations event.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-3" onSubmit={submitBlockCancellation}>
                  <select
                    className={inputClass}
                    value={blockCancellation.availabilityBlockId}
                    onChange={(event) =>
                      setBlockCancellation({
                        ...blockCancellation,
                        availabilityBlockId: event.target.value,
                      })
                    }
                    required
                  >
                    <option value="">Select an active block</option>
                    {snapshot?.activeAvailabilityBlockItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.reason} ·{" "}
                        {new Date(item.startsAt).toLocaleString()}
                      </option>
                    ))}
                  </select>
                  <input
                    className={inputClass}
                    placeholder="Cancellation reason"
                    minLength={3}
                    maxLength={1000}
                    value={blockCancellation.reason}
                    onChange={(event) =>
                      setBlockCancellation({
                        ...blockCancellation,
                        reason: event.target.value,
                      })
                    }
                    required
                  />
                  <button
                    className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100 disabled:opacity-60"
                    disabled={cancelBlock.isPending}
                    type="submit"
                  >
                    {cancelBlock.isPending ? "Cancelling…" : "Cancel block"}
                  </button>
                </form>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Decide extension</CardTitle>
                <CardDescription>
                  Approval rechecks active availability; a rejection requires a
                  reason that becomes auditable evidence.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-3" onSubmit={submitExtensionDecision}>
                  <select
                    className={inputClass}
                    value={extensionDecision.extensionRequestId}
                    onChange={(event) =>
                      setExtensionDecision({
                        ...extensionDecision,
                        extensionRequestId: event.target.value,
                      })
                    }
                    required
                  >
                    <option value="">Select an extension request</option>
                    {snapshot?.requestedExtensionItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.reference} · worker {item.workerUserId} ·{" "}
                        {new Date(item.requestedEndsAt).toLocaleString()}
                      </option>
                    ))}
                  </select>
                  <select
                    className={inputClass}
                    value={extensionDecision.action}
                    onChange={(event) =>
                      setExtensionDecision({
                        ...extensionDecision,
                        action: event.target.value as "approve" | "reject",
                      })
                    }
                  >
                    <option value="approve">Approve</option>
                    <option value="reject">Reject</option>
                  </select>
                  {extensionDecision.action === "reject" ? (
                    <input
                      className={inputClass}
                      placeholder="Rejection reason"
                      minLength={3}
                      maxLength={1000}
                      value={extensionDecision.reason}
                      onChange={(event) =>
                        setExtensionDecision({
                          ...extensionDecision,
                          reason: event.target.value,
                        })
                      }
                      required
                    />
                  ) : null}
                  <button
                    className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100 disabled:opacity-60"
                    disabled={decideExtension.isPending}
                    type="submit"
                  >
                    {decideExtension.isPending
                      ? "Saving…"
                      : "Record extension decision"}
                  </button>
                </form>
              </CardContent>
            </Card>
          </section>

          <section className="grid gap-4 xl:grid-cols-3">
            <QueueCard
              title="Provider locations"
              empty="No active provider locations are in the authorized queue."
              items={snapshot?.providerLocations ?? []}
              render={(item) => (
                <>
                  <p className="font-medium text-slate-100">
                    {item.locationCode} · {item.displayName}
                  </p>
                  <p className="text-slate-400">{item.addressSummary}</p>
                </>
              )}
            />
            <QueueCard
              title="Active availability blocks"
              empty="No active availability blocks are in the authorized queue."
              items={snapshot?.activeAvailabilityBlockItems ?? []}
              render={(item) => (
                <>
                  <p className="font-medium text-slate-100">{item.reason}</p>
                  <p className="text-slate-400">{item.note}</p>
                  <p className="text-slate-500">
                    {new Date(item.startsAt).toLocaleString()} →{" "}
                    {new Date(item.endsAt).toLocaleString()}
                  </p>
                </>
              )}
            />
            <QueueCard
              title="Extension requests"
              empty="No extension requests require a decision."
              items={snapshot?.requestedExtensionItems ?? []}
              render={(item) => (
                <>
                  <p className="font-medium text-slate-100">{item.reference}</p>
                  <p className="text-slate-400">Worker {item.workerUserId}</p>
                  <p className="text-slate-500">
                    Requested to{" "}
                    {new Date(item.requestedEndsAt).toLocaleString()}
                  </p>
                </>
              )}
            />
          </section>
        </section>
      ) : (
        <p className="border border-slate-800 bg-slate-950/40 px-4 py-3 text-sm text-slate-400">
          Fleet location, availability, add-on catalog, and extension-decision
          controls are displayed only to operations roles. Requests remain
          server- and database-authorized regardless of this presentation rule.
        </p>
      )}
    </section>
  );
}

function QueueCard<T extends { id: string }>({
  title,
  empty,
  items,
  render,
}: {
  title: string;
  empty: string;
  items: T[];
  render: (item: T) => React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {items.length ? (
          items.map((item) => (
            <div key={item.id} className="border-b border-slate-800 pb-3">
              {render(item)}
              <p className="mt-1 break-all font-mono text-xs text-slate-600">
                {item.id}
              </p>
            </div>
          ))
        ) : (
          <p className="text-slate-400">{empty}</p>
        )}
      </CardContent>
    </Card>
  );
}
