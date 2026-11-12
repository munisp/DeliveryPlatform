import { useState } from "react";
import { CalendarPlus, HeartPulse, ShieldCheck, Stethoscope } from "lucide-react";

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

const SERVICE_LINES = ["patient_trip", "regulated_delivery"] as const;
const SCHEDULE_MODES = ["scheduled", "same_day", "recurring"] as const;

const NEXT_STATUS: Record<string, { target: "en_route" | "arrived" | "completed"; label: string }> = {
  scheduled: { target: "en_route", label: "Mark en route" },
  en_route: { target: "arrived", label: "Mark arrived" },
  arrived: { target: "completed", label: "Mark completed" },
};

const inputClass =
  "w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500";
const buttonClass =
  "rounded-md border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50";
const dangerButtonClass =
  "rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/20 disabled:opacity-50";

export default function HealthcareTransport() {
  const healthcare = trpc.mobility.healthcare.useQuery();
  const myBookings = trpc.verticalOps.myHealthcareBookings.useQuery();
  const utils = trpc.useUtils();
  const data = healthcare.data;

  const [notice, setNotice] = useState<string | null>(null);
  const [bookingForm, setBookingForm] = useState({
    patientRef: "",
    serviceLine: "patient_trip" as (typeof SERVICE_LINES)[number],
    scheduleMode: "scheduled" as (typeof SCHEDULE_MODES)[number],
    mobilityNeeds: "",
    appointmentAt: "",
    fare: "",
  });
  const [noteInputs, setNoteInputs] = useState<Record<number, string>>({});
  const [cancelReasons, setCancelReasons] = useState<Record<number, string>>({});

  const onWriteSuccess = async (message: string) => {
    setNotice(message);
    await Promise.all([
      utils.mobility.healthcare.invalidate(),
      utils.verticalOps.myHealthcareBookings.invalidate(),
    ]);
  };
  const onWriteError = (error: { message: string }) => setNotice(error.message);

  const scheduleBooking = trpc.verticalOps.scheduleHealthcareBooking.useMutation({
    onSuccess: (result) =>
      void onWriteSuccess(
        `Booking #${result.bookingId} scheduled${result.replayed ? " (replayed)" : ""}.`,
      ),
    onError: onWriteError,
  });
  const transitionBooking = trpc.verticalOps.transitionHealthcareBooking.useMutation({
    onSuccess: (result) =>
      void onWriteSuccess(`Booking #${result.bookingId} is now ${result.status}.`),
    onError: onWriteError,
  });
  const recordNote = trpc.verticalOps.recordComplianceNote.useMutation({
    onSuccess: (result) =>
      void onWriteSuccess(`Compliance note recorded on booking #${result.bookingId}.`),
    onError: onWriteError,
  });

  const busy =
    scheduleBooking.isPending || transitionBooking.isPending || recordNote.isPending;

  const submitBooking = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const fareMinor = bookingForm.fare.trim() === "" ? 0 : majorToMinor(bookingForm.fare);
    if (fareMinor === null) {
      setNotice("Fare must be a non-negative amount with at most 2 decimals.");
      return;
    }
    if (bookingForm.patientRef.trim().length === 0) {
      setNotice("Patient reference is required.");
      return;
    }
    const appointment =
      bookingForm.appointmentAt.trim() === ""
        ? undefined
        : new Date(bookingForm.appointmentAt);
    if (appointment !== undefined && Number.isNaN(appointment.getTime())) {
      setNotice("Appointment time is not a valid date/time.");
      return;
    }
    scheduleBooking.mutate({
      patientRef: bookingForm.patientRef.trim(),
      serviceLine: bookingForm.serviceLine,
      scheduleMode: bookingForm.scheduleMode,
      mobilityNeeds: bookingForm.mobilityNeeds.trim() || undefined,
      appointmentAt: appointment?.toISOString(),
      fareMinor,
      idempotencyKey: newKey("hc-schedule"),
    });
  };

  const submitNote = (bookingId: number) => {
    const note = (noteInputs[bookingId] ?? "").trim();
    if (note.length === 0) {
      setNotice("Compliance note text is required.");
      return;
    }
    recordNote.mutate({
      bookingId,
      note,
      idempotencyKey: newKey("hc-note"),
    });
    setNoteInputs((prev) => ({ ...prev, [bookingId]: "" }));
  };

  const submitCancel = (bookingId: number) => {
    const reason = (cancelReasons[bookingId] ?? "").trim();
    if (reason.length === 0) {
      setNotice("A cancellation reason is required.");
      return;
    }
    transitionBooking.mutate({
      bookingId,
      targetStatus: "cancelled",
      reason,
      idempotencyKey: newKey("hc-cancel"),
    });
  };

  const renderBookingActions = (bookingId: number, status: string) => (
    <div className="flex flex-wrap items-center gap-2">
      {NEXT_STATUS[status] ? (
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() =>
            transitionBooking.mutate({
              bookingId,
              targetStatus: NEXT_STATUS[status].target,
              idempotencyKey: newKey("hc-transition"),
            })
          }
        >
          {NEXT_STATUS[status].label}
        </button>
      ) : null}
      {["scheduled", "en_route", "arrived"].includes(status) ? (
        <>
          <input
            className="w-44 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
            placeholder="Cancel reason"
            value={cancelReasons[bookingId] ?? ""}
            onChange={(event) =>
              setCancelReasons((prev) => ({ ...prev, [bookingId]: event.target.value }))
            }
          />
          <button
            type="button"
            className={dangerButtonClass}
            disabled={busy}
            onClick={() => submitCancel(bookingId)}
          >
            Cancel booking
          </button>
        </>
      ) : null}
      {status !== "cancelled" ? (
        <>
          <input
            className="w-56 rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
            placeholder="Compliance note"
            value={noteInputs[bookingId] ?? ""}
            onChange={(event) =>
              setNoteInputs((prev) => ({ ...prev, [bookingId]: event.target.value }))
            }
          />
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => submitNote(bookingId)}
          >
            Record note
          </button>
        </>
      ) : null}
    </div>
  );

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6">
        <div className="space-y-2 border-b border-slate-800 pb-6">
          <p className="text-sm font-medium uppercase tracking-[0.18em] text-cyan-300">
            Care transportation
          </p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-50">
            Healthcare transport
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-slate-400">
            Scheduled care trips, transport programs, and compliance posture
            from live booking records.
          </p>
        </div>

        {healthcare.isLoading ? (
          <p className="text-sm text-slate-400">
            Loading healthcare transport…
          </p>
        ) : null}
        {healthcare.isError ? (
          <QueryErrorState
            resource="healthcare transport data"
            message={healthcare.error.message}
            onRetry={() => void healthcare.refetch()}
            retrying={healthcare.isRefetching}
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
              <CalendarPlus className="h-5 w-5 text-rose-300" />
              Schedule booking
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitBooking} className="grid gap-3 md:grid-cols-3">
              <input
                className={inputClass}
                placeholder="Patient reference"
                value={bookingForm.patientRef}
                onChange={(event) =>
                  setBookingForm((prev) => ({ ...prev, patientRef: event.target.value }))
                }
              />
              <select
                className={inputClass}
                value={bookingForm.serviceLine}
                onChange={(event) =>
                  setBookingForm((prev) => ({
                    ...prev,
                    serviceLine: event.target.value as (typeof SERVICE_LINES)[number],
                  }))
                }
              >
                {SERVICE_LINES.map((line) => (
                  <option key={line} value={line}>
                    {line}
                  </option>
                ))}
              </select>
              <select
                className={inputClass}
                value={bookingForm.scheduleMode}
                onChange={(event) =>
                  setBookingForm((prev) => ({
                    ...prev,
                    scheduleMode: event.target.value as (typeof SCHEDULE_MODES)[number],
                  }))
                }
              >
                {SCHEDULE_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
              <input
                className={inputClass}
                placeholder="Mobility needs (optional)"
                value={bookingForm.mobilityNeeds}
                onChange={(event) =>
                  setBookingForm((prev) => ({ ...prev, mobilityNeeds: event.target.value }))
                }
              />
              <input
                className={inputClass}
                type="datetime-local"
                value={bookingForm.appointmentAt}
                onChange={(event) =>
                  setBookingForm((prev) => ({ ...prev, appointmentAt: event.target.value }))
                }
              />
              <input
                className={inputClass}
                placeholder="Fare (NGN, e.g. 4500.00)"
                inputMode="decimal"
                value={bookingForm.fare}
                onChange={(event) =>
                  setBookingForm((prev) => ({ ...prev, fare: event.target.value }))
                }
              />
              <div className="md:col-span-3">
                <button type="submit" className={buttonClass} disabled={busy}>
                  Schedule booking
                </button>
              </div>
            </form>
          </CardContent>
        </Card>

        {data ? (
          <>
            <div className="grid gap-4 md:grid-cols-4">
              {[
                ["Care programs", data.summary.care_programs],
                ["Scheduled trips", data.summary.scheduled_trips],
                ["Compliant providers", data.summary.compliant_providers],
                ["Compliance packs", data.summary.compliance_packs],
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

            <div className="flex gap-3 border border-cyan-400/30 bg-cyan-400/5 p-4 text-sm text-cyan-50">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-cyan-300" />
              <p>{data.summary.recommended_action}</p>
            </div>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <HeartPulse className="h-5 w-5 text-rose-300" />
                  Active cases
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.active_cases.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No scheduled or in-progress care trips. Bookings appear
                    here once a care coordinator schedules transport.
                  </p>
                ) : (
                  data.active_cases.map((booking) => (
                    <div
                      key={booking.id}
                      className="space-y-2 border-b border-slate-800 pb-3 last:border-0"
                    >
                      <div className="flex flex-col justify-between gap-2 md:flex-row md:items-center">
                        <div>
                          <p className="font-medium text-slate-100">
                            Case #{booking.id} ·{" "}
                            {booking.service_line === "patient_trip"
                              ? "Patient trip"
                              : "Regulated delivery"}
                          </p>
                          <p className="text-xs text-slate-500">
                            {booking.status}
                          </p>
                        </div>
                        <p className="text-sm text-slate-300">
                          {booking.eta_minutes === null
                            ? "No appointment time set"
                            : `Appointment in ${booking.eta_minutes} min`}
                        </p>
                      </div>
                      {renderBookingActions(booking.id, booking.status)}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base text-slate-100">
                  <Stethoscope className="h-5 w-5 text-emerald-300" />
                  Transport programs
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {data.transport_programs.length === 0 ? (
                  <p className="text-sm text-slate-400">
                    No care programs have bookings yet. Programs are derived
                    from real bookings once transport is scheduled.
                  </p>
                ) : (
                  data.transport_programs.map((program) => (
                    <div
                      key={program.id}
                      className="flex flex-col justify-between gap-2 border-b border-slate-800 pb-3 last:border-0 md:flex-row md:items-center"
                    >
                      <div>
                        <p className="font-medium text-slate-100">
                          {program.name}
                        </p>
                        <p className="text-xs text-slate-500">
                          {program.compliance ?? "No compliance notes recorded"}
                        </p>
                      </div>
                      <span className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">
                        {program.schedule_mode}
                      </span>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card className="border-slate-800 bg-slate-950/60">
              <CardHeader>
                <CardTitle className="text-base text-slate-100">
                  Compliance packs
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2">
                {data.compliance_packs.map((pack) => (
                  <span
                    key={pack}
                    className="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300"
                  >
                    {pack}
                  </span>
                ))}
              </CardContent>
            </Card>
          </>
        ) : null}

        <Card className="border-slate-800 bg-slate-950/60">
          <CardHeader>
            <CardTitle className="text-base text-slate-100">My bookings</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {myBookings.isLoading ? (
              <p className="text-sm text-slate-400">Loading your bookings…</p>
            ) : myBookings.isError ? (
              <p className="text-sm text-slate-400">{myBookings.error.message}</p>
            ) : (myBookings.data?.bookings.length ?? 0) === 0 ? (
              <p className="text-sm text-slate-400">
                You have not scheduled any care transport yet.
              </p>
            ) : (
              myBookings.data?.bookings.map((booking) => (
                <div
                  key={booking.id}
                  className="space-y-2 border-b border-slate-800 pb-3 last:border-0"
                >
                  <div className="flex flex-col justify-between gap-2 md:flex-row md:items-center">
                    <div>
                      <p className="font-medium text-slate-100">
                        #{booking.id} · {booking.patientRef}
                      </p>
                      <p className="text-xs text-slate-500">
                        {booking.serviceLine} · {booking.scheduleMode} · {booking.status}
                        {booking.complianceNotes ? " · notes recorded" : ""}
                      </p>
                    </div>
                    <p className="text-sm font-semibold text-slate-100">
                      {minorToMajor(booking.fareMinor)}
                    </p>
                  </div>
                  {renderBookingActions(booking.id, booking.status)}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </DashboardLayout>
  );
}
