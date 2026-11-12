import { useCallback, useState } from "react";
import {
  CircleAlert,
  ClipboardList,
  Headset,
  Loader2,
  RefreshCcw,
  UserRound,
} from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { trpc } from "@/lib/trpc";

/**
 * SupportConsole — operator support/CRM console (P3-S / WS-SUPPORT).
 *
 * Surfaces the supportAgent router: ticket queue with status filters, a
 * detail panel with assign / progress / resolve / close / reopen actions
 * (spec status edges, resolve-requires-resolution), a customer-360 panel
 * for the ticket customer, and the trip_support_case queue with operator
 * actions (assign / request info / resolve / reopen / close).
 *
 * Every mutation sends a stable idempotency key (rotated only after a
 * successful call) so a network retry never double-applies an action.
 */

type TicketStatus = "open" | "in_progress" | "resolved" | "closed";

const STATUS_FILTERS: Array<{ value: TicketStatus | ""; label: string }> = [
  { value: "", label: "All" },
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
];

const TRIP_ACTIONS = [
  { value: "assign", label: "Assign to me" },
  { value: "request_information", label: "Request info" },
  { value: "resolve", label: "Resolve" },
  { value: "reopen", label: "Reopen" },
  { value: "close", label: "Close" },
] as const;

function dateLabel(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "—";
}

function statusBadge(status: string) {
  const tone =
    status === "open"
      ? "bg-amber-100 text-amber-800"
      : status === "in_progress" || status === "assigned"
        ? "bg-blue-100 text-blue-800"
        : status === "resolved"
          ? "bg-emerald-100 text-emerald-800"
          : "bg-stone-200 text-stone-600";
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {status.replace(/_/g, " ")}
    </span>
  );
}

/** Stable idempotency key that rotates only after a successful mutation. */
function useIdempotencyKey(prefix: string) {
  const [key, setKey] = useState(() => `${prefix}-${crypto.randomUUID()}`);
  const rotate = useCallback(() => setKey(`${prefix}-${crypto.randomUUID()}`), [prefix]);
  return [key, rotate] as const;
}

export default function SupportConsole() {
  const utils = trpc.useUtils();
  const [statusFilter, setStatusFilter] = useState<TicketStatus | "">("open");
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [selectedTicketId, setSelectedTicketId] = useState<number | null>(null);
  const [assigneeId, setAssigneeId] = useState("");
  const [resolution, setResolution] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const [assignKey, rotateAssignKey] = useIdempotencyKey("wa-assign");
  const [updateKey, rotateUpdateKey] = useIdempotencyKey("wa-update");
  const [tripActionKey, rotateTripActionKey] = useIdempotencyKey("wa-tripact");

  const queue = trpc.supportAgent.ticketQueue.useQuery({
    status: statusFilter || undefined,
    assignedToMe: assignedToMe || undefined,
    limit: 50,
    offset: 0,
  });
  const detail = trpc.supportAgent.ticketDetail.useQuery(
    { ticketId: selectedTicketId ?? 0 },
    { enabled: selectedTicketId !== null },
  );
  const customerId = detail.data?.customerId ?? null;
  const customer360 = trpc.supportAgent.customer360.useQuery(
    { userId: customerId ?? 0 },
    { enabled: customerId !== null },
  );
  const tripCases = trpc.supportAgent.tripCaseQueue.useQuery({
    limit: 25,
    offset: 0,
  });

  const refresh = useCallback(() => {
    utils.supportAgent.ticketQueue.invalidate();
    utils.supportAgent.ticketDetail.invalidate();
    utils.supportAgent.tripCaseQueue.invalidate();
    utils.supportAgent.customer360.invalidate();
  }, [utils]);

  const assignMutation = trpc.supportAgent.assignTicket.useMutation({
    onSuccess: () => {
      rotateAssignKey();
      setActionError(null);
      refresh();
    },
    onError: (error) => setActionError(error.message),
  });
  const updateMutation = trpc.supportAgent.updateTicket.useMutation({
    onSuccess: () => {
      rotateUpdateKey();
      setActionError(null);
      setResolution("");
      refresh();
    },
    onError: (error) => setActionError(error.message),
  });
  const tripActionMutation = trpc.supportAgent.actOnTripSupportCase.useMutation({
    onSuccess: () => {
      rotateTripActionKey();
      setActionError(null);
      refresh();
    },
    onError: (error) => setActionError(error.message),
  });

  const runUpdate = (status: TicketStatus) => {
    if (selectedTicketId === null) return;
    updateMutation.mutate({
      ticketId: selectedTicketId,
      status,
      resolution: status === "resolved" ? resolution : undefined,
      idempotencyKey: updateKey,
    });
  };

  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Headset className="h-6 w-6 text-stone-700" />
            <h1 className="text-2xl font-semibold text-stone-900">Support console</h1>
          </div>
          <button
            type="button"
            onClick={refresh}
            className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50"
          >
            <RefreshCcw className="h-4 w-4" />
            Refresh
          </button>
        </header>

        {actionError ? (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{actionError}</span>
          </div>
        ) : null}

        {/* Queue filters */}
        <div className="flex flex-wrap items-center gap-2">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setStatusFilter(filter.value)}
              className={`rounded-full px-3 py-1 text-sm ${
                statusFilter === filter.value
                  ? "bg-stone-900 text-white"
                  : "border border-stone-300 text-stone-600 hover:bg-stone-50"
              }`}
            >
              {filter.label}
            </button>
          ))}
          <label className="ml-2 inline-flex items-center gap-1.5 text-sm text-stone-700">
            <input
              type="checkbox"
              checked={assignedToMe}
              onChange={(event) => setAssignedToMe(event.target.checked)}
            />
            Assigned to me
          </label>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
          {/* Ticket queue */}
          <section className="rounded-2xl border border-stone-200 bg-white">
            <h2 className="border-b border-stone-100 px-4 py-3 text-sm font-semibold text-stone-900">
              Ticket queue{queue.data ? ` (${queue.data.total})` : ""}
            </h2>
            {queue.isLoading ? (
              <p className="px-4 py-6 text-sm text-stone-500">
                <Loader2 className="mr-2 inline h-4 w-4 animate-spin" />
                Loading tickets…
              </p>
            ) : queue.isError ? (
              <p className="px-4 py-6 text-sm text-red-600">
                {queue.error.message}
              </p>
            ) : !queue.data || queue.data.tickets.length === 0 ? (
              <p className="px-4 py-6 text-sm text-stone-500">
                No tickets match this filter.
              </p>
            ) : (
              <ul className="divide-y divide-stone-100">
                {queue.data.tickets.map((ticket) => (
                  <li key={ticket.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedTicketId(ticket.id)}
                      className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-stone-50 ${
                        selectedTicketId === ticket.id ? "bg-stone-50" : ""
                      }`}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-stone-900">
                          {ticket.ticketNumber} · {ticket.subject}
                        </p>
                        <p className="mt-0.5 text-xs text-stone-500">
                          {ticket.customerName ?? "Unknown customer"} ·{" "}
                          {ticket.type.replace(/_/g, " ")} ·{" "}
                          {dateLabel(ticket.createdAt)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {statusBadge(ticket.status)}
                        <span className="text-xs text-stone-400">
                          {ticket.assigneeName ?? "unassigned"}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Detail + customer 360 */}
          <section className="space-y-6">
            <div className="rounded-2xl border border-stone-200 bg-white p-4">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-900">
                <ClipboardList className="h-4 w-4" />
                Ticket detail
              </h2>
              {selectedTicketId === null ? (
                <p className="text-sm text-stone-500">
                  Select a ticket from the queue.
                </p>
              ) : detail.isLoading ? (
                <p className="text-sm text-stone-500">Loading…</p>
              ) : detail.isError || !detail.data ? (
                <p className="text-sm text-red-600">
                  {detail.error?.message ?? "Ticket unavailable."}
                </p>
              ) : (
                <div className="space-y-3 text-sm">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-stone-900">
                      {detail.data.ticketNumber}
                    </p>
                    {statusBadge(detail.data.status)}
                  </div>
                  <p className="text-stone-900">{detail.data.subject}</p>
                  <p className="leading-5 text-stone-600">
                    {detail.data.description}
                  </p>
                  {detail.data.resolution ? (
                    <p className="rounded-lg bg-emerald-50 px-3 py-2 text-emerald-900">
                      Resolution: {detail.data.resolution}
                    </p>
                  ) : null}

                  <div className="space-y-2 border-t border-stone-100 pt-3">
                    <div className="flex gap-2">
                      <input
                        type="number"
                        min={1}
                        value={assigneeId}
                        onChange={(event) => setAssigneeId(event.target.value)}
                        placeholder="Assignee user id"
                        className="w-full rounded-lg border border-stone-300 px-3 py-1.5 text-sm"
                      />
                      <button
                        type="button"
                        disabled={assignMutation.isPending || !assigneeId.trim()}
                        onClick={() =>
                          updateMutation.isPending ||
                          assignMutation.mutate({
                            ticketId: detail.data.id,
                            assigneeUserId: Number(assigneeId),
                            idempotencyKey: assignKey,
                          })
                        }
                        className="shrink-0 rounded-lg bg-stone-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                      >
                        Assign
                      </button>
                    </div>

                    <textarea
                      value={resolution}
                      onChange={(event) => setResolution(event.target.value)}
                      placeholder="Resolution note (required to resolve)"
                      rows={2}
                      className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
                    />
                    <div className="flex flex-wrap gap-2">
                      {detail.data.status === "open" ? (
                        <button
                          type="button"
                          disabled={updateMutation.isPending}
                          onClick={() => runUpdate("in_progress")}
                          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                        >
                          Start progress
                        </button>
                      ) : null}
                      {detail.data.status === "in_progress" ? (
                        <button
                          type="button"
                          disabled={updateMutation.isPending || !resolution.trim()}
                          onClick={() => runUpdate("resolved")}
                          className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                        >
                          Resolve
                        </button>
                      ) : null}
                      {detail.data.status === "resolved" ? (
                        <>
                          <button
                            type="button"
                            disabled={updateMutation.isPending}
                            onClick={() => runUpdate("closed")}
                            className="rounded-lg bg-stone-700 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                          >
                            Close
                          </button>
                          <button
                            type="button"
                            disabled={updateMutation.isPending}
                            onClick={() => runUpdate("in_progress")}
                            className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm text-stone-700 disabled:opacity-50"
                          >
                            Reopen
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Customer 360 */}
            {customerId !== null ? (
              <div className="rounded-2xl border border-stone-200 bg-white p-4">
                <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-stone-900">
                  <UserRound className="h-4 w-4" />
                  Customer 360
                </h2>
                {customer360.isLoading ? (
                  <p className="text-sm text-stone-500">Loading…</p>
                ) : customer360.isError || !customer360.data ? (
                  <p className="text-sm text-red-600">
                    {customer360.error?.message ?? "Customer unavailable."}
                  </p>
                ) : (
                  <dl className="space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-stone-500">Name</dt>
                      <dd className="text-stone-900">{customer360.data.user.name}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-stone-500">Email</dt>
                      <dd className="text-stone-900">{customer360.data.user.email ?? "—"}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-stone-500">Orders</dt>
                      <dd className="text-stone-900">{customer360.data.orders?.total ?? "—"}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-stone-500">Rider trips</dt>
                      <dd className="text-stone-900">{customer360.data.riderTrips?.total ?? "—"}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-stone-500">Open / in-progress cases</dt>
                      <dd className="text-stone-900">
                        {customer360.data.tickets
                          ? `${customer360.data.tickets.open} / ${customer360.data.tickets.inProgress}`
                          : "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-stone-500">Membership</dt>
                      <dd className="text-stone-900">
                        {customer360.data.membership
                          ? `${customer360.data.membership.planName ?? "plan"} (${customer360.data.membership.status})`
                          : "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-stone-500">Wallet</dt>
                      <dd className="text-stone-900">
                        {customer360.data.wallet
                          ? `${customer360.data.wallet.balance} ${customer360.data.wallet.currency}`
                          : "—"}
                      </dd>
                    </div>
                    {customer360.data.longcatMemory ? (
                      <p className="mt-2 rounded-lg bg-stone-50 px-3 py-2 text-xs leading-5 text-stone-600">
                        {customer360.data.longcatMemory.memorySummary}
                      </p>
                    ) : null}
                  </dl>
                )}
              </div>
            ) : null}
          </section>
        </div>

        {/* Trip support cases */}
        <section className="rounded-2xl border border-stone-200 bg-white">
          <h2 className="border-b border-stone-100 px-4 py-3 text-sm font-semibold text-stone-900">
            Trip support cases{tripCases.data ? ` (${tripCases.data.total})` : ""}
          </h2>
          {tripCases.isLoading ? (
            <p className="px-4 py-6 text-sm text-stone-500">Loading…</p>
          ) : tripCases.isError ? (
            <p className="px-4 py-6 text-sm text-red-600">{tripCases.error.message}</p>
          ) : !tripCases.data || tripCases.data.cases.length === 0 ? (
            <p className="px-4 py-6 text-sm text-stone-500">No trip support cases.</p>
          ) : (
            <ul className="divide-y divide-stone-100">
              {tripCases.data.cases.map((tripCase) => (
                <li
                  key={tripCase.caseId}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-stone-900">
                      {tripCase.subject}
                    </p>
                    <p className="mt-0.5 text-xs text-stone-500">
                      {tripCase.requesterName ?? "Unknown"} ·{" "}
                      {tripCase.caseType.replace(/_/g, " ")} ·{" "}
                      {dateLabel(tripCase.openedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {statusBadge(tripCase.state)}
                    <select
                      className="rounded-lg border border-stone-300 px-2 py-1 text-sm"
                      value=""
                      disabled={tripActionMutation.isPending}
                      onChange={(event) => {
                        const action = event.target.value;
                        event.target.value = "";
                        if (!action) return;
                        const note =
                          action === "resolve" || action === "request_information"
                            ? window.prompt("Note for this action:") ?? ""
                            : null;
                        tripActionMutation.mutate({
                          caseId: tripCase.caseId,
                          action: action as (typeof TRIP_ACTIONS)[number]["value"],
                          note,
                          idempotencyKey: tripActionKey,
                        });
                      }}
                    >
                      <option value="">Action…</option>
                      {TRIP_ACTIONS.map((action) => (
                        <option key={action.value} value={action.value}>
                          {action.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </DashboardLayout>
  );
}
