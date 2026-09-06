import { FormEvent, useMemo, useState } from "react";
import { ClipboardCheck, Loader2, Wrench } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const states = [
  "requested",
  "scheduled",
  "assigned",
  "en_route",
  "on_site",
  "completed",
  "cancelled",
] as const;

function idempotency(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function localDateTimeToIso(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error("Enter a valid date and time.");
  return date.toISOString();
}

export default function FieldServiceOperations() {
  const [state, setState] = useState<(typeof states)[number] | "all">("all");
  const [schedule, setSchedule] = useState({
    workOrderId: "",
    startsAt: "",
    endsAt: "",
  });
  const [assignment, setAssignment] = useState({
    workOrderId: "",
    technicianUserId: "",
  });
  const [cancellation, setCancellation] = useState({
    workOrderId: "",
    reason: "",
  });
  const [notice, setNotice] = useState<string | null>(null);

  const workOrders = trpc.fieldService.listWorkOrders.useQuery({
    ...(state === "all" ? {} : { state }),
    limit: 100,
  });
  const utils = trpc.useUtils();
  const refresh = async (message: string) => {
    await utils.fieldService.listWorkOrders.invalidate();
    setNotice(message);
  };

  const scheduleMutation = trpc.fieldService.scheduleWorkOrder.useMutation({
    onSuccess: () => refresh("Work order scheduled."),
    onError: (error) => setNotice(error.message),
  });
  const assignMutation = trpc.fieldService.assignWorkOrder.useMutation({
    onSuccess: () => refresh("Technician assigned."),
    onError: (error) => setNotice(error.message),
  });
  const cancelMutation = trpc.fieldService.cancelWorkOrder.useMutation({
    onSuccess: () => refresh("Work order cancelled."),
    onError: (error) => setNotice(error.message),
  });

  const summary = useMemo(() => {
    const all = workOrders.data ?? [];
    return {
      total: all.length,
      dispatchable: all.filter((order) =>
        ["requested", "scheduled", "assigned"].includes(order.state),
      ).length,
      inProgress: all.filter((order) =>
        ["en_route", "on_site"].includes(order.state),
      ).length,
      completed: all.filter((order) => order.state === "completed").length,
    };
  }, [workOrders.data]);

  const submitSchedule = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      scheduleMutation.mutate({
        workOrderId: schedule.workOrderId,
        scheduledStartAt: localDateTimeToIso(schedule.startsAt),
        scheduledEndAt: localDateTimeToIso(schedule.endsAt),
        idempotencyKey: idempotency("field-schedule"),
      });
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Unable to schedule work order.",
      );
    }
  };

  const submitAssignment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    assignMutation.mutate({
      workOrderId: assignment.workOrderId,
      technicianUserId: Number(assignment.technicianUserId),
      idempotencyKey: idempotency("field-assignment"),
    });
  };

  const submitCancellation = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    cancelMutation.mutate({
      workOrderId: cancellation.workOrderId,
      reason: cancellation.reason,
      idempotencyKey: idempotency("field-cancellation"),
    });
  };

  return (
    <DashboardLayout>
      <div className="space-y-7">
        <section className="flex flex-col justify-between gap-5 border-b border-slate-800 pb-7 lg:flex-row lg:items-end">
          <div className="max-w-3xl space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-[0.22em] text-cyan-300">
              <Wrench className="h-4 w-4" /> Field service
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">
              Work-order operations
            </h1>
            <p className="text-sm leading-6 text-slate-400">
              Schedule customer service visits, assign eligible technicians, and
              monitor authoritative PostgreSQL work-order transitions.
              Completion proof and lifecycle evidence are immutable once
              recorded.
            </p>
          </div>
          <label className="text-sm text-slate-300">
            Queue state
            <select
              className="ml-3 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
              value={state}
              onChange={(event) => setState(event.target.value as typeof state)}
            >
              <option value="all">All states</option>
              {states.map((entry) => (
                <option key={entry} value={entry}>
                  {entry.replace("_", " ")}
                </option>
              ))}
            </select>
          </label>
        </section>

        {notice ? (
          <div className="border border-cyan-400/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
            {notice}
          </div>
        ) : null}

        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            ["Visible orders", summary.total],
            ["Dispatch queue", summary.dispatchable],
            ["In progress", summary.inProgress],
            ["Completed", summary.completed],
          ].map(([label, value]) => (
            <Card key={String(label)}>
              <CardHeader className="pb-2">
                <CardDescription>{label}</CardDescription>
                <CardTitle className="text-3xl">{value}</CardTitle>
              </CardHeader>
            </Card>
          ))}
        </section>

        <section className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
          <Card>
            <CardHeader>
              <CardTitle>Authoritative work-order queue</CardTitle>
              <CardDescription>
                Technicians only see orders assigned to their active profile.
                Operators see the provider queue permitted by their account.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {workOrders.isLoading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading work
                  orders…
                </div>
              ) : null}
              {workOrders.isError ? (
                <p className="py-6 text-sm text-rose-300">
                  {workOrders.error.message}
                </p>
              ) : null}
              {!workOrders.isLoading &&
              !workOrders.isError &&
              !workOrders.data?.length ? (
                <p className="py-6 text-sm text-slate-400">
                  No work orders match the selected state.
                </p>
              ) : null}
              {workOrders.data?.map((order) => (
                <div
                  key={order.id}
                  className="grid gap-3 border border-slate-800 p-4 md:grid-cols-[1fr_auto] md:items-center"
                >
                  <div className="space-y-1">
                    <p className="font-medium text-slate-100">
                      {order.publicReference}
                    </p>
                    <p className="font-mono text-xs text-slate-500">
                      {order.id}
                    </p>
                    <p className="text-sm text-slate-400">
                      {order.state.replace("_", " ")} · {order.priority}{" "}
                      priority · technician{" "}
                      {order.assignedTechnicianUserId ?? "unassigned"}
                    </p>
                  </div>
                  <div className="text-sm text-slate-400">
                    {order.scheduledStartAt
                      ? new Date(order.scheduledStartAt).toLocaleString()
                      : "Unscheduled"}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <div className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle>Schedule</CardTitle>
                <CardDescription>
                  Operator-only transition from requested to scheduled.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={submitSchedule} className="space-y-3">
                  <label className="space-y-1 text-sm text-slate-300">
                    Work-order UUID
                    <input
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                      value={schedule.workOrderId}
                      onChange={(event) =>
                        setSchedule({
                          ...schedule,
                          workOrderId: event.target.value,
                        })
                      }
                      required
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-300">
                    Start
                    <input
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                      type="datetime-local"
                      value={schedule.startsAt}
                      onChange={(event) =>
                        setSchedule({
                          ...schedule,
                          startsAt: event.target.value,
                        })
                      }
                      required
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-300">
                    End
                    <input
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                      type="datetime-local"
                      value={schedule.endsAt}
                      onChange={(event) =>
                        setSchedule({ ...schedule, endsAt: event.target.value })
                      }
                      required
                    />
                  </label>
                  <button
                    className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-60"
                    type="submit"
                    disabled={scheduleMutation.isPending}
                  >
                    {scheduleMutation.isPending
                      ? "Scheduling…"
                      : "Schedule work order"}
                  </button>
                </form>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Assign</CardTitle>
                <CardDescription>
                  The database verifies active technician coverage for the work
                  order’s provider and service area.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={submitAssignment} className="space-y-3">
                  <label className="space-y-1 text-sm text-slate-300">
                    Work-order UUID
                    <input
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                      value={assignment.workOrderId}
                      onChange={(event) =>
                        setAssignment({
                          ...assignment,
                          workOrderId: event.target.value,
                        })
                      }
                      required
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-300">
                    Technician user ID
                    <input
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                      inputMode="numeric"
                      value={assignment.technicianUserId}
                      onChange={(event) =>
                        setAssignment({
                          ...assignment,
                          technicianUserId: event.target.value,
                        })
                      }
                      required
                    />
                  </label>
                  <button
                    className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-60"
                    type="submit"
                    disabled={assignMutation.isPending}
                  >
                    {assignMutation.isPending
                      ? "Assigning…"
                      : "Assign technician"}
                  </button>
                </form>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Cancel</CardTitle>
                <CardDescription>
                  Cancellation is restricted to requested, scheduled, or
                  assigned work orders.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={submitCancellation} className="space-y-3">
                  <label className="space-y-1 text-sm text-slate-300">
                    Work-order UUID
                    <input
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                      value={cancellation.workOrderId}
                      onChange={(event) =>
                        setCancellation({
                          ...cancellation,
                          workOrderId: event.target.value,
                        })
                      }
                      required
                    />
                  </label>
                  <label className="space-y-1 text-sm text-slate-300">
                    Reason
                    <input
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                      value={cancellation.reason}
                      onChange={(event) =>
                        setCancellation({
                          ...cancellation,
                          reason: event.target.value,
                        })
                      }
                      minLength={3}
                      maxLength={1000}
                      required
                    />
                  </label>
                  <button
                    className="rounded-md border border-slate-600 px-4 py-2 text-sm font-medium text-slate-100 disabled:opacity-60"
                    type="submit"
                    disabled={cancelMutation.isPending}
                  >
                    {cancelMutation.isPending
                      ? "Cancelling…"
                      : "Cancel work order"}
                  </button>
                </form>
              </CardContent>
            </Card>
          </div>
        </section>
        <section className="border border-slate-800 bg-slate-950/40 p-5 text-sm text-slate-400">
          <div className="flex items-center gap-2 font-medium text-slate-200">
            <ClipboardCheck className="h-4 w-4 text-cyan-300" /> Technician
            completion
          </div>
          <p className="mt-2 leading-6">
            The authenticated technician flow is exposed through the same
            `fieldService.advanceWorkOrder` and `fieldService.completeWorkOrder`
            procedures. Both enforce assignment and sequence in the database and
            require a bounded completion summary, object key, MIME type, SHA-256
            digest, and idempotency key.
          </p>
        </section>
      </div>
    </DashboardLayout>
  );
}
