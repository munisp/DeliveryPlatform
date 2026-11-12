import { useState } from "react";
import { Link, useLocation } from "wouter";
import { ClipboardList, Store, Wallet } from "lucide-react";

import { EmptyState, QueryErrorState } from "@/components/QueryState";
import { trpc } from "@/lib/trpc";

/**
 * /merchant-signup — greenfield merchant intake (P3-M).
 *
 * One form → merchantSelfServe.merchantSignup: creates the service_providers
 * row (pending/pending) and opens the commerce merchant portal in a single
 * transaction, idempotent per actor (replays return the existing portal).
 * After signup the existing merchantCommerce.onboardingProgress checklist is
 * rendered so the merchant sees exactly what verification/catalog/payments
 * steps remain. Follows the Consumer* styling conventions (low-saturation,
 * warm stone/amber on white, generous whitespace).
 */

const newKey = (scope: string) =>
  `${scope}-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

const merchantNavItems = [
  { href: "/merchant-commerce", label: "Portal", icon: Store },
  { href: "/merchant-orders", label: "Orders", icon: ClipboardList },
  { href: "/merchant-earnings", label: "Earnings", icon: Wallet },
];

/**
 * Lightweight merchant self-serve layout — deliberately NOT the operator
 * DashboardLayout (ConsumerLayout precedent): simple header, merchant nav,
 * single column, warm palette. Shared by the /merchant-* self-serve pages.
 */
export function MerchantSelfServeLayout({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const [location] = useLocation();
  return (
    <div className="min-h-screen bg-stone-50 text-stone-900">
      <header className="border-b border-stone-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-4xl flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <Link href="/merchant-commerce">
            <span className="text-lg font-semibold tracking-tight text-stone-900">
              DeliveryPlatform
              <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
                Merchant
              </span>
            </span>
          </Link>
          <nav aria-label="Merchant" className="flex items-center gap-1">
            {merchantNavItems.map((item) => {
              const active =
                location === item.href || location.startsWith(`${item.href}/`);
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href}>
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition ${
                      active
                        ? "bg-amber-100 text-amber-900"
                        : "text-stone-500 hover:bg-stone-100 hover:text-stone-800"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {item.label}
                  </span>
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-5 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-semibold tracking-tight text-stone-900">
            {title}
          </h1>
          {description ? (
            <p className="mt-1 max-w-2xl text-sm leading-6 text-stone-500">
              {description}
            </p>
          ) : null}
        </div>
        {children}
      </main>
    </div>
  );
}

type SignupResult = {
  providerId: number;
  onboardingState: string;
  medusaStoreId: string;
  replayed: boolean;
  existingPortal: boolean;
};

type ChecklistData = {
  items: Array<{
    key: string;
    label: string;
    description: string;
    status: "done" | "pending";
    href: string;
  }>;
  completedCount: number;
  totalCount: number;
  complete: boolean;
  onboardingCompletedAt: string | null;
};

function SignupChecklist({ data }: { data: ChecklistData }) {
  return (
    <section
      data-testid="signup-onboarding-checklist"
      className="rounded-2xl border border-stone-200 bg-white p-5"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-stone-900">
          Onboarding checklist
        </h2>
        <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-600">
          {data.complete
            ? "Onboarding complete"
            : `${data.completedCount} of ${data.totalCount} complete`}
        </span>
      </div>
      <ul className="divide-y divide-stone-100">
        {data.items.map((item) => (
          <li key={item.key} className="flex items-start gap-3 py-3">
            <span
              aria-hidden
              className={`mt-1.5 inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
                item.status === "done" ? "bg-emerald-500" : "bg-amber-400"
              }`}
            />
            <div>
              <p className="text-sm font-medium text-stone-900">
                {item.label}{" "}
                <span
                  className={`ml-1 text-xs font-semibold uppercase tracking-wide ${
                    item.status === "done" ? "text-emerald-700" : "text-amber-700"
                  }`}
                >
                  {item.status === "done" ? "Done" : "Pending"}
                </span>
              </p>
              <p className="mt-0.5 text-sm leading-6 text-stone-500">
                {item.description}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-stone-500">
        Continue in the{" "}
        <Link href="/merchant-commerce">
          <span className="font-medium text-amber-800 underline-offset-4 hover:underline">
            merchant portal
          </span>
        </Link>{" "}
        to finish catalog, payments, and verification.
      </p>
    </section>
  );
}

export default function MerchantSignup() {
  const [result, setResult] = useState<SignupResult | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const checklistQuery = trpc.merchantCommerce.onboardingProgress.useQuery(
    { providerId: result?.providerId ?? 0 },
    { enabled: result !== null, refetchOnWindowFocus: false },
  );

  const signup = trpc.merchantSelfServe.merchantSignup.useMutation({
    onSuccess: (data) => {
      setResult(data as SignupResult);
      setActionError(null);
    },
    onError: (error) => {
      setActionError(error.message);
    },
  });

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const latitude = String(form.get("latitude") ?? "").trim();
    const longitude = String(form.get("longitude") ?? "").trim();
    const verticalId = String(form.get("verticalId") ?? "").trim();
    const contactEmail = String(form.get("contactEmail") ?? "").trim();
    const contactPhone = String(form.get("contactPhone") ?? "").trim();
    const medusaStoreId = String(form.get("medusaStoreId") ?? "").trim();
    signup.mutate({
      legalName: String(form.get("legalName") ?? ""),
      displayName: String(form.get("displayName") ?? ""),
      address: String(form.get("address") ?? ""),
      latitude: latitude === "" ? undefined : Number(latitude),
      longitude: longitude === "" ? undefined : Number(longitude),
      verticalId: verticalId === "" ? undefined : Number(verticalId),
      contactEmail: contactEmail === "" ? undefined : contactEmail,
      contactPhone: contactPhone === "" ? undefined : contactPhone,
      medusaStoreId: medusaStoreId === "" ? undefined : medusaStoreId,
      idempotencyKey: newKey("merchant-signup"),
    });
  };

  return (
    <MerchantSelfServeLayout
      title="Become a merchant"
      description="Register your business once. Verification, catalog publishing, and payment setup continue in the merchant portal after signup."
    >
      {actionError ? (
        <p
          className="mb-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          role="alert"
        >
          {actionError}
        </p>
      ) : null}

      {result ? (
        <div className="space-y-6">
          <p className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {result.replayed
              ? result.existingPortal
                ? `You already run a merchant portal — showing provider #${result.providerId} (${result.onboardingState.replace(/_/g, " ")}).`
                : `This signup was already submitted — provider #${result.providerId} is ${result.onboardingState.replace(/_/g, " ")}.`
              : `Signup received. Provider #${result.providerId} is ${result.onboardingState.replace(/_/g, " ")} — an operator verifies your business before the storefront goes live.`}
          </p>
          {checklistQuery.isError ? (
            <QueryErrorState
              resource="onboarding progress"
              message={checklistQuery.error.message}
              onRetry={() => checklistQuery.refetch()}
              retrying={checklistQuery.isRefetching}
            />
          ) : checklistQuery.data ? (
            <SignupChecklist data={checklistQuery.data as ChecklistData} />
          ) : (
            <p className="text-sm text-stone-500">Loading onboarding progress…</p>
          )}
        </div>
      ) : (
        <form
          onSubmit={onSubmit}
          className="space-y-4 rounded-2xl border border-stone-200 bg-white p-5"
        >
          <fieldset disabled={signup.isPending} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1 text-sm text-stone-700">
                Legal business name
                <input
                  name="legalName"
                  required
                  minLength={2}
                  maxLength={255}
                  className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900"
                  placeholder="Mama Put Ventures Ltd"
                />
              </label>
              <label className="block space-y-1 text-sm text-stone-700">
                Store display name
                <input
                  name="displayName"
                  required
                  minLength={2}
                  maxLength={160}
                  className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900"
                  placeholder="Mama Put Kitchen"
                />
              </label>
            </div>
            <label className="block space-y-1 text-sm text-stone-700">
              Store address
              <input
                name="address"
                required
                minLength={3}
                maxLength={1000}
                className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900"
                placeholder="12 Marina Road, Lagos"
              />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1 text-sm text-stone-700">
                Latitude (optional)
                <input
                  name="latitude"
                  type="number"
                  step="any"
                  min={-90}
                  max={90}
                  className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900"
                />
              </label>
              <label className="block space-y-1 text-sm text-stone-700">
                Longitude (optional)
                <input
                  name="longitude"
                  type="number"
                  step="any"
                  min={-180}
                  max={180}
                  className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900"
                />
              </label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1 text-sm text-stone-700">
                Contact email (defaults to your account email)
                <input
                  name="contactEmail"
                  type="email"
                  maxLength={320}
                  className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900"
                />
              </label>
              <label className="block space-y-1 text-sm text-stone-700">
                Contact phone (defaults to your account phone)
                <input
                  name="contactPhone"
                  maxLength={20}
                  className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900"
                />
              </label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block space-y-1 text-sm text-stone-700">
                Vertical ID (optional — your market category)
                <input
                  name="verticalId"
                  inputMode="numeric"
                  className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900"
                />
              </label>
              <label className="block space-y-1 text-sm text-stone-700">
                Medusa store ID (optional — can be set later)
                <input
                  name="medusaStoreId"
                  pattern="[A-Za-z0-9][A-Za-z0-9._:-]{2,159}"
                  className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-stone-900"
                />
              </label>
            </div>
            <button
              type="submit"
              disabled={signup.isPending}
              className="rounded-full bg-amber-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {signup.isPending ? "Submitting…" : "Submit merchant application"}
            </button>
          </fieldset>
        </form>
      )}

      {!result ? (
        <div className="mt-6">
          <EmptyState
            title="One merchant account per user"
            description="If you already signed up, submitting again safely returns your existing application — nothing is duplicated."
          />
        </div>
      ) : null}
    </MerchantSelfServeLayout>
  );
}
