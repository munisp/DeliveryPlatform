import { FormEvent, useMemo, useState } from "react";
import { Link } from "wouter";

import { ConsumerLayout } from "@/components/ConsumerLayout";
import { EmptyState, QueryErrorState } from "@/components/QueryState";
import { trpc } from "@/lib/trpc";

const caseTypes = [
  ["order_issue", "Problem with an order"],
  ["refund", "Refund request"],
  ["payment", "Payment issue"],
  ["claim", "Claim"],
  ["driver", "Courier issue"],
  ["general", "Something else"],
] as const;

function newIdempotencyKey() {
  // Stable for the lifetime of the form so resubmits/replays are absorbed by
  // the server-side UNIQUE(ticket_number) guard instead of double-opening.
  return crypto.randomUUID();
}

export default function ConsumerSupport() {
  const preselectedOrderId = useMemo(() => {
    if (typeof window === "undefined") return null;
    const raw = new URLSearchParams(window.location.search).get("orderId");
    const parsed = raw ? Number(raw) : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }, []);

  const cases = trpc.consumer.mySupportCases.useQuery({ limit: 50 });
  const orders = trpc.consumer.myOrders.useQuery({ limit: 50 });
  const utils = trpc.useUtils();

  const [orderId, setOrderId] = useState<number | null>(preselectedOrderId);
  const [type, setType] = useState<(typeof caseTypes)[number][0]>("order_issue");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const [formError, setFormError] = useState<string | null>(null);
  const [openedTicket, setOpenedTicket] = useState<string | null>(null);

  const openCase = trpc.consumer.openSupportCase.useMutation({
    onSuccess: (created) => {
      setOpenedTicket(created.ticketNumber);
      setSubject("");
      setDescription("");
      setFormError(null);
      setIdempotencyKey(newIdempotencyKey());
      utils.consumer.mySupportCases.invalidate();
      utils.consumer.myOrders.invalidate();
    },
    onError: (error) => {
      setFormError(error.message);
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    setOpenedTicket(null);
    openCase.mutate({
      orderId,
      type,
      subject: subject.trim(),
      description: description.trim(),
      idempotencyKey,
    });
  };

  return (
    <ConsumerLayout
      title="Support & disputes"
      description="Open a dispute tied to an order and follow every case to resolution."
    >
      <div className="space-y-10">
        <section className="rounded-2xl border border-stone-200 bg-white p-6">
          <h2 className="mb-4 text-base font-semibold text-stone-900">
            Open a new case
          </h2>
          <form onSubmit={submit} className="space-y-4">
            <div>
              <label
                htmlFor="case-order"
                className="mb-1 block text-sm font-medium text-stone-700"
              >
                Related order (optional)
              </label>
              <select
                id="case-order"
                value={orderId ?? ""}
                onChange={(e) =>
                  setOrderId(e.target.value ? Number(e.target.value) : null)
                }
                className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 focus:border-amber-600 focus:outline-none"
              >
                <option value="">No specific order</option>
                {(orders.data ?? []).map((order) => (
                  <option key={order.id} value={order.id}>
                    {order.orderNumber} — {order.status.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="case-type"
                className="mb-1 block text-sm font-medium text-stone-700"
              >
                Case type
              </label>
              <select
                id="case-type"
                value={type}
                onChange={(e) =>
                  setType(e.target.value as (typeof caseTypes)[number][0])
                }
                className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 focus:border-amber-600 focus:outline-none"
              >
                {caseTypes.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label
                htmlFor="case-subject"
                className="mb-1 block text-sm font-medium text-stone-700"
              >
                Subject
              </label>
              <input
                id="case-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
                minLength={3}
                maxLength={255}
                placeholder="Short summary of the problem"
                className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 focus:border-amber-600 focus:outline-none"
              />
            </div>
            <div>
              <label
                htmlFor="case-description"
                className="mb-1 block text-sm font-medium text-stone-700"
              >
                Description
              </label>
              <textarea
                id="case-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                required
                minLength={3}
                maxLength={4000}
                rows={4}
                placeholder="What happened, and what would you like us to do?"
                className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 focus:border-amber-600 focus:outline-none"
              />
            </div>
            {formError ? (
              <p role="alert" className="text-sm text-rose-700">
                The case could not be opened: {formError}
              </p>
            ) : null}
            {openedTicket ? (
              <p role="status" className="text-sm text-emerald-700">
                Case {openedTicket} opened. It is listed below and will update
                as the support team works on it.
              </p>
            ) : null}
            <button
              type="submit"
              disabled={openCase.isPending}
              className="rounded-full bg-amber-700 px-5 py-2.5 text-sm font-medium text-white transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {openCase.isPending ? "Opening case…" : "Submit case"}
            </button>
          </form>
        </section>

        <section>
          <h2 className="mb-4 text-base font-semibold text-stone-900">
            Your cases
          </h2>
          {cases.isError ? (
            <QueryErrorState
              resource="your support cases"
              message={cases.error.message}
              onRetry={() => cases.refetch()}
              retrying={cases.isRefetching}
            />
          ) : cases.isLoading ? (
            <p className="text-sm text-stone-500">Loading your cases…</p>
          ) : !cases.data || cases.data.length === 0 ? (
            <EmptyState
              title="No support cases yet"
              description="Disputes and support requests you open will appear here with their live status and resolution."
            />
          ) : (
            <ul className="space-y-3">
              {cases.data.map((c) => (
                <li
                  key={c.id}
                  className="rounded-2xl border border-stone-200 bg-white p-5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-stone-900">{c.subject}</p>
                    <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-600">
                      {c.status.replace(/_/g, " ")}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-stone-400">
                    {c.ticketNumber} · {c.type.replace(/_/g, " ")} · opened{" "}
                    {new Date(c.createdAt).toLocaleString()}
                    {c.resolvedAt
                      ? ` · resolved ${new Date(c.resolvedAt).toLocaleString()}`
                      : ` · last update ${new Date(c.updatedAt).toLocaleString()}`}
                  </p>
                  {c.orderNumber ? (
                    <p className="mt-1 text-sm text-stone-500">
                      Order{" "}
                      <Link href={`/account/orders/${c.orderId}`}>
                        <span className="font-medium text-amber-800 hover:text-amber-900">
                          {c.orderNumber}
                        </span>
                      </Link>
                    </p>
                  ) : null}
                  <p className="mt-2 text-sm leading-6 text-stone-600">
                    {c.description}
                  </p>
                  {c.resolution ? (
                    <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
                      Resolution: {c.resolution}
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </ConsumerLayout>
  );
}
