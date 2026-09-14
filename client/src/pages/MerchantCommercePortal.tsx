import { useState } from "react";
import { Link } from "wouter";

import DashboardLayout from "@/components/DashboardLayout";
import { EmptyState, QueryErrorState } from "@/components/QueryState";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const newKey = (scope: string) =>
  `${scope}-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

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

function ChecklistLink({ item, children }: { item: ChecklistData["items"][number]; children: React.ReactNode }) {
  const className =
    "text-sm font-medium text-cyan-300 underline-offset-4 transition hover:text-cyan-200 hover:underline";
  if (item.href.startsWith("#")) {
    return (
      <a href={item.href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link href={item.href} className={className}>
      {children}
    </Link>
  );
}

function OnboardingChecklistCard({ data }: { data: ChecklistData }) {
  const percent = Math.round((data.completedCount / data.totalCount) * 100);

  return (
    <Card data-testid="onboarding-checklist">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>Onboarding checklist</CardTitle>
            <CardDescription>
              Real progress derived from your merchant profile, payment configuration, catalog,
              inventory bindings, and storefront connections — never assumed.
            </CardDescription>
          </div>
          <Badge className={data.complete ? "border-emerald-500/40 text-emerald-200" : ""}>
            {data.complete ? "Onboarding complete" : `${data.completedCount} of ${data.totalCount} complete`}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <>
            <div
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Onboarding progress"
              className="h-2 overflow-hidden rounded-full bg-slate-800"
            >
              <div
                className={`h-full rounded-full transition-all ${data.complete ? "bg-emerald-400" : "bg-cyan-400"}`}
                style={{ width: `${percent}%` }}
              />
            </div>
            <ul className="divide-y divide-slate-800/80">
              {data.items.map((item) => (
                <li key={item.key} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="flex items-start gap-3">
                    <span
                      aria-hidden
                      className={`mt-1 inline-block h-2.5 w-2.5 rounded-full ${
                        item.status === "done" ? "bg-emerald-400" : "bg-amber-400"
                      }`}
                    />
                    <div>
                      <p className="text-sm font-medium text-slate-100">
                        {item.label}{" "}
                        <span
                          className={`ml-1 text-xs font-semibold uppercase tracking-wide ${
                            item.status === "done" ? "text-emerald-300" : "text-amber-300"
                          }`}
                        >
                          {item.status === "done" ? "Done" : "Pending"}
                        </span>
                      </p>
                      <p className="mt-0.5 max-w-xl text-sm leading-6 text-slate-400">{item.description}</p>
                    </div>
                  </div>
                  {item.status === "pending" ? (
                    <ChecklistLink item={item}>Go to section</ChecklistLink>
                  ) : null}
                </li>
              ))}
            </ul>
            {data.complete && data.onboardingCompletedAt ? (
              <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-100">
                Onboarding completed at {new Date(data.onboardingCompletedAt).toLocaleString()}. Your
                storefront is ready for GA traffic.
              </p>
            ) : null}
          </>
      </CardContent>
    </Card>
  );
}

function GuidedEmptyState({
  title,
  description,
  cta,
  href,
}: {
  title: string;
  description: string;
  cta: string;
  href: string;
}) {
  return (
    <div className="space-y-3">
      <EmptyState title={title} description={description} />
      <div className="text-center">
        <a
          href={href}
          className="inline-flex items-center rounded-full border border-cyan-500/40 bg-cyan-500/10 px-4 py-2 text-sm font-medium text-cyan-100 transition hover:bg-cyan-500/20"
        >
          {cta}
        </a>
      </div>
    </div>
  );
}

export default function MerchantCommercePortal() {
  const [providerId, setProviderId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const providerIdNumber = Number(providerId);
  const providerSelected = Number.isInteger(providerIdNumber) && providerIdNumber > 0;

  const profile = trpc.merchantCommerce.profile.useQuery(
    { providerId: providerIdNumber },
    { enabled: providerSelected },
  );
  const checklist = trpc.merchantCommerce.onboardingProgress.useQuery(
    { providerId: providerIdNumber },
    { enabled: providerSelected, refetchOnWindowFocus: false },
  );
  const refetchProgress = () => {
    void profile.refetch();
    void checklist.refetch();
  };

  const onboarding = trpc.merchantCommerce.beginOnboarding.useMutation({
    onSuccess: (result) => { setNotice(`Onboarding is ${result.state}. Complete merchant verification before catalog or payments are activated.`); refetchProgress(); },
    onError: (error) => setNotice(error.message),
  });
  const product = trpc.merchantCommerce.createProduct.useMutation({
    onSuccess: (result) => { setNotice(`Product ${result.handle} was created in Medusa as ${result.state}.`); refetchProgress(); },
    onError: (error) => setNotice(error.message),
  });
  const payment = trpc.merchantCommerce.configurePayments.useMutation({
    onSuccess: (result) => { setNotice(`DeliveryPlatform payments are ${result.enabled ? "configured" : "disabled"} for ${result.currencyCode}.`); refetchProgress(); },
    onError: (error) => setNotice(error.message),
  });
  const inventory = trpc.merchantCommerce.updateInventory.useMutation({
    onSuccess: (result) => { setNotice(`Medusa inventory item ${result.inventoryItemId} was updated. The authenticated inventory snapshot will reconcile through the outbox.`); refetchProgress(); },
    onError: (error) => setNotice(error.message),
  });

  const currentProviderId = () => providerIdNumber;
  const itemStatus = (key: string) =>
    checklist.data?.items.find((item) => item.key === key)?.status;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="space-y-3">
          <Badge>Merchant commerce</Badge>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">Merchant store operations</h1>
            <p className="mt-2 max-w-3xl text-slate-400">Onboard a verified business, publish owned catalog items in Medusa, configure the platform settlement destination, and update location-specific stock through one access-controlled workspace.</p>
          </div>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Merchant account</CardTitle>
            <CardDescription>Enter the platform provider identifier assigned during your merchant application. Access is checked by PostgreSQL for every action.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-[280px_auto]">
            <label className="space-y-1 text-sm text-slate-300">Provider ID
              <input value={providerId} onChange={(event) => setProviderId(event.target.value.replace(/\D/g, ""))} inputMode="numeric" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100" placeholder="e.g. 42" />
            </label>
            <div className="self-end text-sm text-slate-300">
              {profile.isError ? (
                <QueryErrorState
                  resource="merchant profile"
                  message={profile.error.message}
                  onRetry={() => void profile.refetch()}
                  retrying={profile.isRefetching}
                />
              ) : profile.isLoading ? (
                "Loading authorized merchant profile…"
              ) : profile.data ? (
                `${profile.data.display_name}: ${profile.data.state}; ${profile.data.productCount} catalog items`
              ) : (
                "Select a provider to load your authorized merchant profile."
              )}
            </div>
          </CardContent>
        </Card>

        {providerSelected ? (
          checklist.isError ? (
            <QueryErrorState
              resource="onboarding checklist"
              message={checklist.error.message}
              onRetry={() => void checklist.refetch()}
              retrying={checklist.isRefetching}
            />
          ) : checklist.data ? (
            <OnboardingChecklistCard data={checklist.data} />
          ) : (
            <Card>
              <CardContent className="py-6 text-sm text-slate-400">
                Loading onboarding progress…
              </CardContent>
            </Card>
          )
        ) : null}

        {providerSelected && checklist.data ? (
          <div className="grid gap-4 lg:grid-cols-3">
            {itemStatus("product") === "pending" ? (
              <GuidedEmptyState
                title="No products yet"
                description="Your catalog is empty. Publish your first item in Medusa to start selling."
                cta="Create your first product"
                href="#merchant-product-form"
              />
            ) : null}
            {itemStatus("payments") === "pending" ? (
              <GuidedEmptyState
                title="Payments not configured"
                description="No settlement destination is recorded for this merchant yet."
                cta="Configure payments"
                href="#merchant-payments-form"
              />
            ) : null}
            {itemStatus("inventory") === "pending" ? (
              <GuidedEmptyState
                title="Inventory not linked"
                description="No Medusa inventory bindings exist for your stock locations yet."
                cta="Set up inventory"
                href="#merchant-inventory-form"
              />
            ) : null}
          </div>
        ) : null}

        <div className="grid gap-4 xl:grid-cols-2">
          <MerchantForm id="merchant-onboarding-form" title="1. Start merchant onboarding" description="A platform operator must activate the portal only after the required merchant verification case is verified." submit="Submit onboarding" busy={onboarding.isPending} onSubmit={(form) => onboarding.mutate({ providerId: currentProviderId(), legalName: form.get("legalName") as string, displayName: form.get("displayName") as string, medusaStoreId: form.get("medusaStoreId") as string, idempotencyKey: newKey("merchant-onboard") })}>
            <FormInput name="legalName" label="Legal business name" required />
            <FormInput name="displayName" label="Store display name" required />
            <FormInput name="medusaStoreId" label="Medusa store ID" pattern="[A-Za-z0-9._:-]+" required />
          </MerchantForm>

          <MerchantForm id="merchant-product-form" title="2. Publish an item" description="Product creation uses the server-side Medusa Admin API token. Your browser never receives that credential." submit="Create product" busy={product.isPending} onSubmit={(form) => product.mutate({ providerId: currentProviderId(), title: form.get("title") as string, handle: form.get("handle") as string, description: form.get("description") as string, status: form.get("status") as "draft" | "published", currencyCode: form.get("currencyCode") as string, priceMinor: Number(form.get("priceMinor")), sku: form.get("sku") as string, imageUrls: `${form.get("imageUrls") ?? ""}`.split("\n").map((url) => url.trim()).filter(Boolean), idempotencyKey: newKey("merchant-product") })}>
            <FormInput name="title" label="Product title" required />
            <FormInput name="handle" label="URL handle" pattern="[a-z0-9-]+" required />
            <label className="space-y-1 text-sm text-slate-300">Description<textarea name="description" required rows={3} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100" /></label>
            <div className="grid grid-cols-2 gap-3"><FormInput name="sku" label="SKU" required /><FormInput name="priceMinor" label="Price (minor units)" type="number" min="1" required /></div>
            <div className="grid grid-cols-2 gap-3"><FormInput name="currencyCode" label="Currency" defaultValue="NGN" pattern="[A-Z]{3}" required /><label className="space-y-1 text-sm text-slate-300">Status<select name="status" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"><option value="draft">Draft</option><option value="published">Published</option></select></label></div>
            <label className="space-y-1 text-sm text-slate-300">Image URLs (one HTTPS URL per line)<textarea name="imageUrls" rows={2} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100" /></label>
          </MerchantForm>

          <MerchantForm id="merchant-payments-form" title="3. Configure platform payments" description="This registers an encrypted-reference settlement destination. It does not capture customer money or automatically settle funds." submit="Save payment configuration" busy={payment.isPending} onSubmit={(form) => payment.mutate({ providerId: currentProviderId(), settlementFspAlias: form.get("settlementFspAlias") as string, payoutReference: form.get("payoutReference") as string, currencyCode: form.get("currencyCode") as string, enabled: form.get("enabled") === "on", idempotencyKey: newKey("merchant-payment") })}>
            <FormInput name="settlementFspAlias" label="Settlement FSP alias" required />
            <FormInput name="payoutReference" label="Merchant payout reference" required />
            <FormInput name="currencyCode" label="Settlement currency" defaultValue="NGN" pattern="[A-Z]{3}" required />
            <label className="flex gap-2 text-sm text-slate-300"><input name="enabled" type="checkbox" />Enable only after independent payment-provider and settlement approval</label>
          </MerchantForm>

          <MerchantForm id="merchant-inventory-form" title="4. Update inventory" description="Stock is updated through Medusa’s inventory workflow. The committed change emits an authenticated snapshot to the fenced inventory outbox; it does not directly overwrite platform reservations." submit="Update inventory" busy={inventory.isPending} onSubmit={(form) => inventory.mutate({ providerId: currentProviderId(), inventoryItemId: form.get("inventoryItemId") as string, locationId: form.get("locationId") as string, inventoryLevelId: (form.get("inventoryLevelId") as string) || undefined, stockedQuantity: Number(form.get("stockedQuantity")), incomingQuantity: Number(form.get("incomingQuantity")), idempotencyKey: newKey("merchant-inventory") })}>
            <FormInput name="inventoryItemId" label="Medusa inventory item ID" required />
            <FormInput name="locationId" label="Medusa stock location ID" required />
            <FormInput name="inventoryLevelId" label="Existing inventory level ID (optional)" />
            <div className="grid grid-cols-2 gap-3"><FormInput name="stockedQuantity" label="Stocked quantity" type="number" min="0" defaultValue="0" required /><FormInput name="incomingQuantity" label="Incoming quantity" type="number" min="0" defaultValue="0" required /></div>
          </MerchantForm>
        </div>
        {notice ? <p role="status" className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-3 text-sm text-cyan-100">{notice}</p> : null}
      </div>
    </DashboardLayout>
  );
}

function MerchantForm({ id, title, description, submit, busy, onSubmit, children }: { id: string; title: string; description: string; submit: string; busy: boolean; onSubmit: (form: FormData) => void; children: React.ReactNode }) {
  return <Card id={id} className="scroll-mt-24"><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); onSubmit(new FormData(event.currentTarget)); }}><fieldset disabled={busy} className="space-y-3">{children}<button type="submit" className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-60">{busy ? "Saving…" : submit}</button></fieldset></form></CardContent></Card>;
}

function FormInput({ name, label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { name: string; label: string }) {
  return <label className="block space-y-1 text-sm text-slate-300">{label}<input name={name} {...props} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100" /></label>;
}
