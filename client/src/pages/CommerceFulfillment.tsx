import { FormEvent, useState } from "react";
import { PackageCheck, Store } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const actionsFor = (state: string) =>
  state === "requested"
    ? ["accept", "cancel", "fail"]
    : state === "accepted"
      ? ["assign", "cancel", "fail"]
      : state === "assigned"
        ? ["dispatch", "fail"]
        : state === "out_for_delivery"
          ? ["deliver"]
          : [];

export default function CommerceFulfillment() {
  const requests = trpc.commerceFulfillment.list.useQuery({ limit: 50 });
  const utils = trpc.useUtils();
  const [notice, setNotice] = useState<string | null>(null);
  const [connection, setConnection] = useState({
    providerId: "",
    medusaStoreId: "",
    baseUrl: "",
    webhookSecretRef: "",
  });
  const configure = trpc.commerceFulfillment.upsertMedusaStore.useMutation({
    onSuccess: () =>
      setNotice(
        "Medusa store connection saved. Enable signed ingress only after configuring the matching secret reference.",
      ),
    onError: (error) => setNotice(error.message),
  });
  const transition = trpc.commerceFulfillment.transition.useMutation({
    onSuccess: async () => {
      await utils.commerceFulfillment.list.invalidate();
      setNotice("Fulfillment transition recorded with immutable evidence.");
    },
    onError: (error) => setNotice(error.message),
  });
  const submitConnection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    configure.mutate({
      providerId: Number(connection.providerId),
      medusaStoreId: connection.medusaStoreId,
      baseUrl: connection.baseUrl,
      webhookSecretRef: connection.webhookSecretRef,
      active: true,
    });
  };
  const advance = (id: string, action: string) => {
    const detail =
      action === "assign"
        ? {
            delivery_reference:
              window
                .prompt("Existing DeliveryPlatform delivery reference")
                ?.trim() ?? "",
          }
        : action === "fail"
          ? { reason: window.prompt("Failure reason")?.trim() ?? "" }
          : {};
    transition.mutate({
      fulfillmentId: id,
      action: action as
        | "accept"
        | "assign"
        | "dispatch"
        | "deliver"
        | "cancel"
        | "fail",
      detail,
      idempotencyKey: `commerce-${action}-${id.slice(0, 8)}-${Date.now()}`,
    });
  };
  return (
    <DashboardLayout>
      <div className="space-y-7">
        <section className="border-b border-slate-800 pb-7">
          <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-[0.22em] text-cyan-300">
            <Store className="h-4 w-4" /> Retail and food fulfillment
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">
            Medusa commerce handoff
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400">
            Signed Medusa order events create durable fulfillment requests.
            Commerce order processing remains in Medusa; DeliveryPlatform
            records the delivery handoff and lifecycle evidence in PostgreSQL.
          </p>
        </section>
        {notice ? (
          <div className="border border-cyan-400/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
            {notice}
          </div>
        ) : null}
        <section className="grid gap-5 xl:grid-cols-[0.82fr_1.18fr]">
          <Card>
            <CardHeader>
              <CardTitle>Connect a Medusa store</CardTitle>
              <CardDescription>
                The webhook secret is stored outside the database. Enter only
                its approved reference.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form className="space-y-3" onSubmit={submitConnection}>
                <label className="block text-sm text-slate-300">
                  Provider ID
                  <input
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                    inputMode="numeric"
                    value={connection.providerId}
                    onChange={(event) =>
                      setConnection({
                        ...connection,
                        providerId: event.target.value,
                      })
                    }
                    required
                  />
                </label>
                <label className="block text-sm text-slate-300">
                  Medusa store ID
                  <input
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                    value={connection.medusaStoreId}
                    onChange={(event) =>
                      setConnection({
                        ...connection,
                        medusaStoreId: event.target.value,
                      })
                    }
                    required
                  />
                </label>
                <label className="block text-sm text-slate-300">
                  Medusa base URL
                  <input
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                    type="url"
                    value={connection.baseUrl}
                    onChange={(event) =>
                      setConnection({
                        ...connection,
                        baseUrl: event.target.value,
                      })
                    }
                    required
                  />
                </label>
                <label className="block text-sm text-slate-300">
                  Webhook-secret reference
                  <input
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                    value={connection.webhookSecretRef}
                    onChange={(event) =>
                      setConnection({
                        ...connection,
                        webhookSecretRef: event.target.value,
                      })
                    }
                    required
                  />
                </label>
                <button
                  className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-60"
                  disabled={configure.isPending}
                  type="submit"
                >
                  Save connection
                </button>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Fulfillment queue</CardTitle>
              <CardDescription>
                Accepted requests need a verified DeliveryPlatform delivery
                reference before dispatch.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {requests.isLoading ? (
                <p className="text-sm text-slate-400">
                  Loading durable fulfillment requests…
                </p>
              ) : requests.data?.length ? (
                requests.data.map((request) => (
                  <div key={request.id} className="border border-slate-800 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-medium text-slate-100">
                          Medusa order {request.medusaOrderId}
                        </p>
                        <p className="font-mono text-xs text-slate-500">
                          {request.id}
                        </p>
                      </div>
                      <span className="border border-cyan-400/30 px-2 py-1 text-xs text-cyan-200">
                        {request.state}
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-slate-400">
                      Provider {request.providerId}
                      {request.deliveryReference
                        ? ` · Delivery ${request.deliveryReference}`
                        : ""}
                    </p>
                    {request.failureReason ? (
                      <p className="mt-2 text-xs text-rose-300">
                        {request.failureReason}
                      </p>
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      {actionsFor(request.state).map((action) => (
                        <button
                          key={action}
                          className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-100 disabled:opacity-60"
                          disabled={transition.isPending}
                          onClick={() => advance(request.id, action)}
                        >
                          {action}
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <div className="border border-dashed border-slate-700 p-6 text-center text-sm text-slate-400">
                  <PackageCheck className="mx-auto mb-2 h-5 w-5" />
                  No Medusa fulfillment requests have been ingested.
                </div>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </DashboardLayout>
  );
}
