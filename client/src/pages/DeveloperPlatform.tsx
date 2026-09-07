import { FormEvent, useEffect, useState } from "react";
import { KeyRound, Webhook } from "lucide-react";
import DashboardLayout from "@/components/DashboardLayout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const EVENT_TYPES = [
  "field_service.work_order.created",
  "field_service.work_order.scheduled",
  "field_service.work_order.assigned",
  "field_service.work_order.en_route",
  "field_service.work_order.arrived",
  "field_service.work_order.completed",
  "field_service.work_order.cancelled",
] as const;
type FieldServiceWebhookEvent = (typeof EVENT_TYPES)[number];

export default function DeveloperPlatform() {
  const clients = trpc.developerPlatform.listClients.useQuery();
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [clientForm, setClientForm] = useState({
    providerId: "",
    displayName: "",
  });
  const [keyScopes, setKeyScopes] = useState<string[]>(["field_service:read"]);
  const [keyExpiry, setKeyExpiry] = useState("");
  const [webhook, setWebhook] = useState<{
    url: string;
    signingSecretRef: string;
    eventTypes: FieldServiceWebhookEvent[];
  }>({
    url: "",
    signingSecretRef: "",
    eventTypes: ["field_service.work_order.completed"],
  });
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const utils = trpc.useUtils();

  useEffect(() => {
    if (!selectedClientId && clients.data?.[0]?.id)
      setSelectedClientId(clients.data[0].id);
  }, [clients.data, selectedClientId]);

  const keys = trpc.developerPlatform.listKeys.useQuery(
    { apiClientId: selectedClientId ?? "00000000-0000-0000-0000-000000000000" },
    { enabled: Boolean(selectedClientId) },
  );
  const endpoints = trpc.developerPlatform.listWebhookEndpoints.useQuery(
    { apiClientId: selectedClientId ?? "00000000-0000-0000-0000-000000000000" },
    { enabled: Boolean(selectedClientId) },
  );
  const refresh = async (message: string) => {
    await Promise.all([
      utils.developerPlatform.listClients.invalidate(),
      utils.developerPlatform.listKeys.invalidate(),
      utils.developerPlatform.listWebhookEndpoints.invalidate(),
    ]);
    setNotice(message);
  };

  const createClient = trpc.developerPlatform.createClient.useMutation({
    onSuccess: async (id) => {
      setSelectedClientId(id);
      await refresh("API client created.");
    },
    onError: (error) => setNotice(error.message),
  });
  const createKey = trpc.developerPlatform.createKey.useMutation({
    onSuccess: async (result) => {
      setIssuedKey(result.key);
      await refresh("Copy the new API key now. It cannot be retrieved again.");
    },
    onError: (error) => setNotice(error.message),
  });
  const revokeKey = trpc.developerPlatform.revokeKey.useMutation({
    onSuccess: () => refresh("API key revoked."),
    onError: (error) => setNotice(error.message),
  });
  const createEndpoint =
    trpc.developerPlatform.createWebhookEndpoint.useMutation({
      onSuccess: () => refresh("Webhook endpoint registered."),
      onError: (error) => setNotice(error.message),
    });

  const submitClient = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    createClient.mutate({
      providerId: Number(clientForm.providerId),
      displayName: clientForm.displayName,
    });
  };
  const submitKey = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedClientId)
      createKey.mutate({
        apiClientId: selectedClientId,
        scopes: keyScopes as (
          | "field_service:read"
          | "field_service:write"
          | "webhook:manage"
        )[],
        expiresAt: keyExpiry ? new Date(keyExpiry).toISOString() : null,
      });
  };
  const submitEndpoint = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedClientId)
      createEndpoint.mutate({ apiClientId: selectedClientId, ...webhook });
  };
  const toggle = (value: string) =>
    setKeyScopes((current) =>
      current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value],
    );

  return (
    <DashboardLayout>
      <div className="space-y-7">
        <section className="border-b border-slate-800 pb-7">
          <div className="flex items-center gap-2 text-sm font-medium uppercase tracking-[0.22em] text-cyan-300">
            <KeyRound className="h-4 w-4" /> Developer platform
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-white">
            External API access and webhooks
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400">
            Create provider-scoped API clients, issue keys shown exactly once,
            and register HTTPS webhook endpoints backed by durable, retryable
            delivery evidence. Raw key values and signing secrets are never
            stored in the operator database.
          </p>
        </section>
        {notice ? (
          <div className="border border-cyan-400/30 bg-cyan-500/10 px-4 py-3 text-sm text-cyan-100">
            {notice}
          </div>
        ) : null}
        {issuedKey ? (
          <Card className="border-amber-400/40">
            <CardHeader>
              <CardTitle className="text-amber-200">
                Copy this API key now
              </CardTitle>
              <CardDescription>
                Only its SHA-256 digest is retained after this view is
                dismissed.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <code className="block break-all border border-amber-400/30 bg-slate-950 p-3 text-sm text-amber-100">
                {issuedKey}
              </code>
              <button
                className="mt-3 rounded-md border border-slate-600 px-4 py-2 text-sm text-slate-100"
                onClick={() => setIssuedKey(null)}
              >
                I stored it securely
              </button>
            </CardContent>
          </Card>
        ) : null}
        <section className="grid gap-5 xl:grid-cols-[0.9fr_1.1fr]">
          <Card>
            <CardHeader>
              <CardTitle>API clients</CardTitle>
              <CardDescription>
                Each client is limited to one active service provider.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <form className="space-y-3" onSubmit={submitClient}>
                <label className="block text-sm text-slate-300">
                  Provider ID
                  <input
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                    inputMode="numeric"
                    value={clientForm.providerId}
                    onChange={(event) =>
                      setClientForm({
                        ...clientForm,
                        providerId: event.target.value,
                      })
                    }
                    required
                  />
                </label>
                <label className="block text-sm text-slate-300">
                  Client display name
                  <input
                    className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                    value={clientForm.displayName}
                    onChange={(event) =>
                      setClientForm({
                        ...clientForm,
                        displayName: event.target.value,
                      })
                    }
                    required
                  />
                </label>
                <button
                  className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-60"
                  disabled={createClient.isPending}
                  type="submit"
                >
                  Create API client
                </button>
              </form>
              <div className="space-y-2">
                {clients.data?.map((client) => (
                  <button
                    key={client.id}
                    className={`w-full border p-3 text-left ${client.id === selectedClientId ? "border-cyan-400/70 bg-cyan-500/10" : "border-slate-800"}`}
                    onClick={() => setSelectedClientId(client.id)}
                  >
                    <p className="font-medium text-slate-100">
                      {client.displayName}
                    </p>
                    <p className="font-mono text-xs text-slate-500">
                      {client.id}
                    </p>
                    <p className="mt-1 text-xs text-slate-400">
                      Provider {client.providerId} · {client.state}
                    </p>
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
          <div className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle>Issue an API key</CardTitle>
                <CardDescription>
                  Keys are provider-scoped and returned once.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-3" onSubmit={submitKey}>
                  <fieldset className="space-y-2">
                    <legend className="text-sm text-slate-300">Scopes</legend>
                    {[
                      "field_service:read",
                      "field_service:write",
                      "webhook:manage",
                    ].map((scope) => (
                      <label
                        key={scope}
                        className="mr-4 inline-flex items-center gap-2 text-sm text-slate-300"
                      >
                        <input
                          type="checkbox"
                          checked={keyScopes.includes(scope)}
                          onChange={() => toggle(scope)}
                        />
                        {scope}
                      </label>
                    ))}
                  </fieldset>
                  <label className="block text-sm text-slate-300">
                    Expiry (optional)
                    <input
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                      type="datetime-local"
                      value={keyExpiry}
                      onChange={(event) => setKeyExpiry(event.target.value)}
                    />
                  </label>
                  <button
                    className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-60"
                    disabled={
                      !selectedClientId ||
                      createKey.isPending ||
                      keyScopes.length === 0
                    }
                    type="submit"
                  >
                    Issue key
                  </button>
                </form>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Webhook endpoint</CardTitle>
                <CardDescription>
                  Endpoint secrets remain in the configured secret manager;
                  record only its reference here.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form className="space-y-3" onSubmit={submitEndpoint}>
                  <label className="block text-sm text-slate-300">
                    HTTPS URL
                    <input
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                      type="url"
                      value={webhook.url}
                      onChange={(event) =>
                        setWebhook({ ...webhook, url: event.target.value })
                      }
                      required
                    />
                  </label>
                  <label className="block text-sm text-slate-300">
                    Signing-secret reference
                    <input
                      className="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                      value={webhook.signingSecretRef}
                      onChange={(event) =>
                        setWebhook({
                          ...webhook,
                          signingSecretRef: event.target.value,
                        })
                      }
                      required
                    />
                  </label>
                  <fieldset className="space-y-2">
                    <legend className="text-sm text-slate-300">Events</legend>
                    {EVENT_TYPES.map((eventType) => (
                      <label
                        key={eventType}
                        className="mr-4 inline-flex items-center gap-2 text-xs text-slate-300"
                      >
                        <input
                          type="checkbox"
                          checked={webhook.eventTypes.includes(eventType)}
                          onChange={() =>
                            setWebhook((current) => ({
                              ...current,
                              eventTypes: current.eventTypes.includes(eventType)
                                ? current.eventTypes.filter(
                                    (value) => value !== eventType,
                                  )
                                : [...current.eventTypes, eventType],
                            }))
                          }
                        />
                        {eventType}
                      </label>
                    ))}
                  </fieldset>
                  <button
                    className="rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-60"
                    disabled={
                      !selectedClientId ||
                      createEndpoint.isPending ||
                      webhook.eventTypes.length === 0
                    }
                    type="submit"
                  >
                    <Webhook className="mr-2 inline h-4 w-4" />
                    Register webhook
                  </button>
                </form>
              </CardContent>
            </Card>
          </div>
        </section>
        <section className="grid gap-5 xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Issued key metadata</CardTitle>
              <CardDescription>
                Digests and raw key material are intentionally absent.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {keys.data?.map((key) => (
                <div key={key.id} className="border border-slate-800 p-3">
                  <p className="font-mono text-sm text-slate-100">
                    {key.keyPrefix}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    {key.scopes.join(", ")} ·{" "}
                    {key.revokedAt ? "revoked" : "active"}
                  </p>
                  {!key.revokedAt ? (
                    <button
                      className="mt-2 text-xs text-rose-300"
                      onClick={() => revokeKey.mutate({ apiKeyId: key.id })}
                    >
                      Revoke key
                    </button>
                  ) : null}
                </div>
              )) ?? (
                <p className="text-sm text-slate-400">
                  Select an API client to inspect keys.
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Webhook metadata</CardTitle>
              <CardDescription>
                Delivery attempts are durable and bounded; signing values are
                referenced, not displayed.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {endpoints.data?.map((endpoint) => (
                <div key={endpoint.id} className="border border-slate-800 p-3">
                  <p className="break-all text-sm text-slate-100">
                    {endpoint.url}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    {endpoint.eventTypes.join(", ")} ·{" "}
                    {endpoint.active ? "active" : "disabled"}
                  </p>
                </div>
              )) ?? (
                <p className="text-sm text-slate-400">
                  Select an API client to inspect webhook endpoints.
                </p>
              )}
            </CardContent>
          </Card>
        </section>
      </div>
    </DashboardLayout>
  );
}
