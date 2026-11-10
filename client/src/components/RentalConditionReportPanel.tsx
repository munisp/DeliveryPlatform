/**
 * Rental condition report panel (drizzle/0096 wave) — check-out / check-in
 * condition evidence for a contract. Reads come from
 * `rentalCondition.deltaReport` (report + photo jsonb normalized via
 * @/lib/rentalConditionWire); recording goes through
 * `rentalCondition.recordReport`, which requires at least one
 * dashboard_odometer zone photo server-side.
 *
 * Photos are evidence stored server-side with no GET endpoint yet, so each
 * photo renders as a placeholder tile (zone, damage badge, object key, short
 * sha256) rather than an <img>.
 */
import { FormEvent, useMemo, useState } from "react";
import { Camera, Loader2 } from "lucide-react";
import { trpc } from "@/lib/trpc";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  CONDITION_GRADES,
  CONDITION_PHOTO_CONTENT_TYPES,
  PHOTO_ZONES,
  isUuid,
  normalizePhaseReport,
  photoZoneLabel,
  type ConditionGrade,
  type ConditionPhase,
  type ConditionPhotoContentType,
  type PhotoZone,
} from "@/lib/rentalConditionWire";

function idempotency(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

const inputClass =
  "w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100";

type PhotoDraft = {
  zone: PhotoZone;
  objectKey: string;
  contentType: ConditionPhotoContentType;
  sha256Hex: string;
  damageFlag: boolean;
  note: string;
};

function emptyPhotoDraft(zone: PhotoZone): PhotoDraft {
  return {
    zone,
    objectKey: "",
    contentType: "image/jpeg",
    sha256Hex: "",
    damageFlag: false,
    note: "",
  };
}

export function RentalConditionReportPanel({
  onNotice,
}: {
  onNotice: (message: string) => void;
}) {
  const utils = trpc.useUtils();
  const [contractId, setContractId] = useState("");
  const [phaseTab, setPhaseTab] = useState<ConditionPhase>("check_out");
  const [report, setReport] = useState({
    phase: "check_out" as ConditionPhase,
    odometerKm: "",
    fuelPct: "",
    overallCondition: "good" as ConditionGrade,
    notes: "",
  });
  const [photos, setPhotos] = useState<PhotoDraft[]>([
    emptyPhotoDraft("dashboard_odometer"),
  ]);

  const delta = trpc.rentalCondition.deltaReport.useQuery(
    { contractId },
    { enabled: isUuid(contractId), staleTime: 15_000 },
  );
  const checkOut = useMemo(
    () => normalizePhaseReport(delta.data?.checkOut),
    [delta.data],
  );
  const checkIn = useMemo(
    () => normalizePhaseReport(delta.data?.checkIn),
    [delta.data],
  );
  const deltas = delta.data?.deltas ?? null;
  const activeReport = phaseTab === "check_out" ? checkOut : checkIn;

  const recordReportMutation = trpc.rentalCondition.recordReport.useMutation({
    onSuccess: async (result) => {
      await utils.rentalCondition.deltaReport.invalidate();
      setPhotos([emptyPhotoDraft("dashboard_odometer")]);
      onNotice(`Condition report recorded: ${result.reportId}`);
    },
    onError: (error) => onNotice(error.message),
  });

  const updatePhoto = (index: number, patch: Partial<PhotoDraft>) => {
    setPhotos((current) =>
      current.map((photo, position) =>
        position === index ? { ...photo, ...patch } : photo,
      ),
    );
  };

  const submitReport = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!photos.some((photo) => photo.zone === "dashboard_odometer")) {
      onNotice(
        "A dashboard / odometer photo is required before the report can be recorded.",
      );
      return;
    }
    const seen = new Set<string>();
    for (const photo of photos) {
      const key = `${photo.zone}:${photo.sha256Hex}`;
      if (seen.has(key)) {
        onNotice("Duplicate zone photo digests are not allowed in one report.");
        return;
      }
      seen.add(key);
    }
    recordReportMutation.mutate({
      contractId,
      phase: report.phase,
      odometerKm: Number(report.odometerKm),
      fuelPct: Number(report.fuelPct),
      overallCondition: report.overallCondition,
      ...(report.notes ? { notes: report.notes } : {}),
      photos: photos.map((photo) => ({
        zone: photo.zone,
        objectKey: photo.objectKey,
        contentType: photo.contentType,
        sha256Hex: photo.sha256Hex,
        damageFlag: photo.damageFlag,
        ...(photo.note ? { note: photo.note } : {}),
      })),
      idempotencyKey: idempotency("rental-condition-report"),
    });
  };

  return (
    <section className="space-y-5" aria-labelledby="rental-condition-heading">
      <div className="border-b border-slate-800 pb-4">
        <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
          <Camera className="h-4 w-4" /> Condition evidence
        </div>
        <h2
          id="rental-condition-heading"
          className="mt-2 text-xl font-semibold text-white"
        >
          Check-out and check-in condition reports
        </h2>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-slate-400">
          Zone photos, odometer, and fuel are append-only evidence captured at
          handover and return. The database enforces one report per phase per
          contract, odometer monotonicity, and worker-or-operator authority.
        </p>
      </div>

      <section className="grid gap-5 xl:grid-cols-[1.45fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Contract condition reports</CardTitle>
            <CardDescription>
              Enter a contract UUID to view the recorded check-out and check-in
              reports. Photo binaries are served by the evidence pipeline; tiles
              below carry the zone, damage flag, object key, and digest.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <input
              className={inputClass}
              placeholder="Contract UUID"
              value={contractId}
              onChange={(event) => setContractId(event.target.value)}
            />
            {delta.isFetching ? (
              <div className="flex items-center gap-2 py-6 text-sm text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading condition
                reports…
              </div>
            ) : null}
            {delta.isError ? (
              <p className="py-4 text-sm text-rose-300">
                {delta.error?.message}
              </p>
            ) : null}
            {isUuid(contractId) && !delta.isError ? (
              <>
                <div className="flex gap-2">
                  {(["check_out", "check_in"] as ConditionPhase[]).map(
                    (phase) => (
                      <button
                        key={phase}
                        type="button"
                        onClick={() => setPhaseTab(phase)}
                        className={
                          phaseTab === phase
                            ? "rounded-md bg-cyan-500 px-3 py-2 text-sm font-medium text-slate-950"
                            : "rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-300"
                        }
                      >
                        {phase === "check_out" ? "Check-out" : "Check-in"}
                      </button>
                    ),
                  )}
                </div>
                {activeReport ? (
                  <div className="space-y-3 border border-slate-800 p-4">
                    <dl className="grid gap-2 text-sm sm:grid-cols-3">
                      <div>
                        <dt className="text-slate-500">Odometer</dt>
                        <dd className="text-slate-200">
                          {activeReport.odometerKm.toLocaleString()} km
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Fuel</dt>
                        <dd className="text-slate-200">
                          {activeReport.fuelPct}%
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Overall condition</dt>
                        <dd className="capitalize text-slate-200">
                          {activeReport.overallCondition}
                        </dd>
                      </div>
                    </dl>
                    {activeReport.notes ? (
                      <p className="text-sm text-slate-400">
                        {activeReport.notes}
                      </p>
                    ) : null}
                    {activeReport.createdAt ? (
                      <p className="text-xs text-slate-500">
                        Captured{" "}
                        {new Date(activeReport.createdAt).toLocaleString()}
                      </p>
                    ) : null}
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {activeReport.photos.map((photo, index) => (
                        <div
                          key={`${photo.zone}-${photo.sha256Hex || index}`}
                          className="space-y-1 border border-slate-800 bg-slate-950/40 p-3"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="flex items-center gap-1 text-sm font-medium text-slate-200">
                              <Camera className="h-3.5 w-3.5 text-cyan-300" />
                              {photoZoneLabel(photo.zone)}
                            </p>
                            {photo.damageFlag ? (
                              <span className="rounded-full border border-rose-400/40 bg-rose-500/10 px-2 py-0.5 text-xs text-rose-200">
                                Damage
                              </span>
                            ) : (
                              <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">
                                No damage
                              </span>
                            )}
                          </div>
                          <p className="break-all font-mono text-xs text-slate-500">
                            {photo.objectKey}
                          </p>
                          <p className="font-mono text-xs text-slate-600">
                            sha256 {photo.sha256Hex.slice(0, 12)}…
                          </p>
                          {photo.note ? (
                            <p className="text-xs text-slate-400">
                              {photo.note}
                            </p>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="py-4 text-sm text-slate-400">
                    No {phaseTab === "check_out" ? "check-out" : "check-in"}{" "}
                    report has been recorded for this contract.
                  </p>
                )}
                {deltas ? (
                  <div className="grid gap-2 border border-slate-800 bg-slate-950/40 p-3 text-sm sm:grid-cols-3">
                    <p className="text-slate-300">
                      Distance driven:{" "}
                      {deltas.odometerKm === null
                        ? "—"
                        : `${deltas.odometerKm.toLocaleString()} km`}
                    </p>
                    <p className="text-slate-300">
                      Fuel change:{" "}
                      {deltas.fuelPct === null ? "—" : `${deltas.fuelPct}%`}
                    </p>
                    <p className="text-slate-300">
                      New damage zones: {deltas.newDamageZones.length}
                    </p>
                  </div>
                ) : null}
              </>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Record condition report</CardTitle>
            <CardDescription>
              One report per phase per contract. A dashboard / odometer zone
              photo is required; check-in odometer may not regress below
              check-out.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={submitReport}>
              <select
                className={inputClass}
                value={report.phase}
                onChange={(event) =>
                  setReport({
                    ...report,
                    phase: event.target.value as ConditionPhase,
                  })
                }
              >
                <option value="check_out">Check-out (handover)</option>
                <option value="check_in">Check-in (return)</option>
              </select>
              <div className="grid grid-cols-2 gap-2">
                <input
                  className={inputClass}
                  placeholder="Odometer km"
                  inputMode="numeric"
                  value={report.odometerKm}
                  onChange={(event) =>
                    setReport({ ...report, odometerKm: event.target.value })
                  }
                  required
                />
                <input
                  className={inputClass}
                  placeholder="Fuel %"
                  inputMode="numeric"
                  min={0}
                  max={100}
                  type="number"
                  value={report.fuelPct}
                  onChange={(event) =>
                    setReport({ ...report, fuelPct: event.target.value })
                  }
                  required
                />
              </div>
              <select
                className={inputClass}
                value={report.overallCondition}
                onChange={(event) =>
                  setReport({
                    ...report,
                    overallCondition: event.target.value as ConditionGrade,
                  })
                }
              >
                {CONDITION_GRADES.map((grade) => (
                  <option key={grade} value={grade} className="capitalize">
                    {grade}
                  </option>
                ))}
              </select>
              <input
                className={inputClass}
                placeholder="Notes (optional)"
                minLength={3}
                maxLength={1000}
                value={report.notes}
                onChange={(event) =>
                  setReport({ ...report, notes: event.target.value })
                }
              />
              <div className="space-y-2 border border-slate-800 p-3">
                <p className="text-sm font-medium text-slate-100">
                  Zone photos (1–24; dashboard / odometer required)
                </p>
                {photos.map((photo, index) => (
                  <div
                    key={index}
                    className="space-y-2 border border-slate-800/60 p-2"
                  >
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        className={inputClass}
                        value={photo.zone}
                        onChange={(event) =>
                          updatePhoto(index, {
                            zone: event.target.value as PhotoZone,
                          })
                        }
                      >
                        {PHOTO_ZONES.map((spec) => (
                          <option key={spec.zone} value={spec.zone}>
                            {spec.label}
                            {spec.required ? " (required)" : ""}
                          </option>
                        ))}
                      </select>
                      <select
                        className={inputClass}
                        value={photo.contentType}
                        onChange={(event) =>
                          updatePhoto(index, {
                            contentType: event.target
                              .value as ConditionPhotoContentType,
                          })
                        }
                      >
                        {CONDITION_PHOTO_CONTENT_TYPES.map((contentType) => (
                          <option key={contentType} value={contentType}>
                            {contentType}
                          </option>
                        ))}
                      </select>
                    </div>
                    <input
                      className={inputClass}
                      placeholder="Evidence object key"
                      minLength={3}
                      maxLength={512}
                      value={photo.objectKey}
                      onChange={(event) =>
                        updatePhoto(index, { objectKey: event.target.value })
                      }
                      required
                    />
                    <input
                      className={`${inputClass} font-mono`}
                      placeholder="SHA-256 hex"
                      pattern="[a-f0-9]{64}"
                      value={photo.sha256Hex}
                      onChange={(event) =>
                        updatePhoto(index, { sha256Hex: event.target.value })
                      }
                      required
                    />
                    <input
                      className={inputClass}
                      placeholder="Damage note (optional)"
                      minLength={3}
                      maxLength={500}
                      value={photo.note}
                      onChange={(event) =>
                        updatePhoto(index, { note: event.target.value })
                      }
                    />
                    <div className="flex items-center justify-between gap-2">
                      <label className="flex items-center gap-2 text-sm text-slate-300">
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-rose-500"
                          checked={photo.damageFlag}
                          onChange={(event) =>
                            updatePhoto(index, {
                              damageFlag: event.target.checked,
                            })
                          }
                        />
                        Damage flagged
                      </label>
                      {photos.length > 1 ? (
                        <button
                          type="button"
                          className="rounded-md border border-slate-600 px-2 py-1 text-xs text-slate-300"
                          onClick={() =>
                            setPhotos((current) =>
                              current.filter((_, position) => position !== index),
                            )
                          }
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
                {photos.length < 24 ? (
                  <button
                    type="button"
                    className="rounded-md border border-slate-600 px-3 py-2 text-sm text-slate-100"
                    onClick={() =>
                      setPhotos((current) => [...current, emptyPhotoDraft("front")])
                    }
                  >
                    Add zone photo
                  </button>
                ) : null}
              </div>
              <button
                className="rounded-md border border-slate-600 px-4 py-2 text-sm font-medium text-slate-100 disabled:opacity-60"
                type="submit"
                disabled={recordReportMutation.isPending || !isUuid(contractId)}
              >
                {recordReportMutation.isPending
                  ? "Recording…"
                  : "Record condition report"}
              </button>
            </form>
          </CardContent>
        </Card>
      </section>
    </section>
  );
}
