import { useState } from "react";

import DashboardLayout from "@/components/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { trpc } from "@/lib/trpc";

const newKey = (scope: string) =>
  `${scope}-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;

export default function MerchantCommercePortal() {
  const [providerId, setProviderId] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const profile = trpc.merchantCommerce.profile.useQuery(
    { providerId: Number(providerId) },
    { enabled: Number.isInteger(Number(providerId)) && Number(providerId) > 0 },
  );
  const onboarding = trpc.merchantCommerce.beginOnboarding.useMutation({
    onSuccess: (result) => setNotice(`Onboarding is ${result.state}. Complete merchant verification before catalog or payments are activated.`),
    onError: (error) => setNotice(error.message),
  });
  const product = trpc.merchantCommerce.createProduct.useMutation({
    onSuccess: (result) => { setNotice(`Product ${result.handle} was created in Medusa as ${result.state}.`); void profile.refetch(); },
    onError: (error) => setNotice(error.message),
  });
  const payment = trpc.merchantCommerce.configurePayments.useMutation({
    onSuccess: (result) => { setNotice(`DeliveryPlatform payments are ${result.enabled ? "configured" : "disabled"} for ${result.currencyCode}.`); void profile.refetch(); },
    onError: (error) => setNotice(error.message),
  });
  const inventory = trpc.merchantCommerce.updateInventory.useMutation({
    onSuccess: (result) => setNotice(`Medusa inventory item ${result.inventoryItemId} was updated. The authenticated inventory snapshot will reconcile through the outbox.`),
    onError: (error) => setNotice(error.message),
  });

  const currentProviderId = () => Number(providerId);

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
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-900/40 bg-amber-500/5 px-4 py-3">
                  <span className="text-amber-100">
                    Merchant profile could not be loaded: {profile.error.message}
                  </span>
                  <button
                    type="button"
                    onClick={() => void profile.refetch()}
                    disabled={profile.isRefetching}
                    className="rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-100 transition hover:bg-amber-500/20 disabled:opacity-60"
                  >
                    {profile.isRefetching ? "Retrying…" : "Retry"}
                  </button>
                </div>
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

        <div className="grid gap-4 xl:grid-cols-2">
          <MerchantForm title="1. Start merchant onboarding" description="A platform operator must activate the portal only after the required merchant verification case is verified." submit="Submit onboarding" busy={onboarding.isPending} onSubmit={(form) => onboarding.mutate({ providerId: currentProviderId(), legalName: form.get("legalName") as string, displayName: form.get("displayName") as string, medusaStoreId: form.get("medusaStoreId") as string, idempotencyKey: newKey("merchant-onboard") })}>
            <FormInput name="legalName" label="Legal business name" required />
            <FormInput name="displayName" label="Store display name" required />
            <FormInput name="medusaStoreId" label="Medusa store ID" pattern="[A-Za-z0-9._:-]+" required />
          </MerchantForm>

          <MerchantForm title="2. Publish an item" description="Product creation uses the server-side Medusa Admin API token. Your browser never receives that credential." submit="Create product" busy={product.isPending} onSubmit={(form) => product.mutate({ providerId: currentProviderId(), title: form.get("title") as string, handle: form.get("handle") as string, description: form.get("description") as string, status: form.get("status") as "draft" | "published", currencyCode: form.get("currencyCode") as string, priceMinor: Number(form.get("priceMinor")), sku: form.get("sku") as string, imageUrls: `${form.get("imageUrls") ?? ""}`.split("\n").map((url) => url.trim()).filter(Boolean), idempotencyKey: newKey("merchant-product") })}>
            <FormInput name="title" label="Product title" required />
            <FormInput name="handle" label="URL handle" pattern="[a-z0-9-]+" required />
            <label className="space-y-1 text-sm text-slate-300">Description<textarea name="description" required rows={3} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100" /></label>
            <div className="grid grid-cols-2 gap-3"><FormInput name="sku" label="SKU" required /><FormInput name="priceMinor" label="Price (minor units)" type="number" min="1" required /></div>
            <div className="grid grid-cols-2 gap-3"><FormInput name="currencyCode" label="Currency" defaultValue="NGN" pattern="[A-Z]{3}" required /><label className="space-y-1 text-sm text-slate-300">Status<select name="status" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"><option value="draft">Draft</option><option value="published">Published</option></select></label></div>
            <label className="space-y-1 text-sm text-slate-300">Image URLs (one HTTPS URL per line)<textarea name="imageUrls" rows={2} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100" /></label>
          </MerchantForm>

          <MerchantForm title="3. Configure platform payments" description="This registers an encrypted-reference settlement destination. It does not capture customer money or automatically settle funds." submit="Save payment configuration" busy={payment.isPending} onSubmit={(form) => payment.mutate({ providerId: currentProviderId(), settlementFspAlias: form.get("settlementFspAlias") as string, payoutReference: form.get("payoutReference") as string, currencyCode: form.get("currencyCode") as string, enabled: form.get("enabled") === "on", idempotencyKey: newKey("merchant-payment") })}>
            <FormInput name="settlementFspAlias" label="Settlement FSP alias" required />
            <FormInput name="payoutReference" label="Merchant payout reference" required />
            <FormInput name="currencyCode" label="Settlement currency" defaultValue="NGN" pattern="[A-Z]{3}" required />
            <label className="flex gap-2 text-sm text-slate-300"><input name="enabled" type="checkbox" />Enable only after independent payment-provider and settlement approval</label>
          </MerchantForm>

          <MerchantForm title="4. Update inventory" description="Stock is updated through Medusa’s inventory workflow. The committed change emits an authenticated snapshot to the fenced inventory outbox; it does not directly overwrite platform reservations." submit="Update inventory" busy={inventory.isPending} onSubmit={(form) => inventory.mutate({ providerId: currentProviderId(), inventoryItemId: form.get("inventoryItemId") as string, locationId: form.get("locationId") as string, inventoryLevelId: (form.get("inventoryLevelId") as string) || undefined, stockedQuantity: Number(form.get("stockedQuantity")), incomingQuantity: Number(form.get("incomingQuantity")), idempotencyKey: newKey("merchant-inventory") })}>
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

function MerchantForm({ title, description, submit, busy, onSubmit, children }: { title: string; description: string; submit: string; busy: boolean; onSubmit: (form: FormData) => void; children: React.ReactNode }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent><form className="space-y-3" onSubmit={(event) => { event.preventDefault(); onSubmit(new FormData(event.currentTarget)); }}><fieldset disabled={busy} className="space-y-3">{children}<button type="submit" className="rounded-full bg-cyan-500 px-4 py-2 text-sm font-medium text-slate-950 disabled:opacity-60">{busy ? "Saving…" : submit}</button></fieldset></form></CardContent></Card>;
}

function FormInput({ name, label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { name: string; label: string }) {
  return <label className="block space-y-1 text-sm text-slate-300">{label}<input name={name} {...props} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100" /></label>;
}
