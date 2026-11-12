import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Clock, ShoppingCart, Star, Store } from "lucide-react";

import { ConsumerLayout } from "@/components/ConsumerLayout";
import { EmptyState, QueryErrorState } from "@/components/QueryState";
import { trpc } from "@/lib/trpc";
import {
  cartItemCount,
  formatNairaMajor,
  formatNairaMinor,
  generateConsumerIdempotencyKey,
  majorToMinor,
  normalizeCartPayload,
  normalizeCatalogItems,
  normalizeProviders,
  normalizeVerticals,
  type ConsumerCatalogItem,
} from "@/lib/consumerWire";

/**
 * /shop — consumer marketplace discovery.
 *
 * Vertical selector → provider list (customer-visible providers only:
 * status 'active', enforced server-side in consumerCatalog) → provider
 * detail with a catalog grid and add-to-cart per item. ETA and delivery fee
 * are placeholders until dispatch quoting exists: the ETA is a static
 * estimate label, the delivery fee shown is the platform flat fee from
 * consumerCatalog.consumerFeeConfig.
 *
 * Add-to-cart reuses the caller's active cart when one exists, otherwise
 * creates one (idempotency-keyed) scoped to the item's provider. Prices are
 * converted from the catalog's major-unit strings to integer minor units
 * with exact string math (majorToMinor) — never float.
 */
export default function ConsumerMarketplace() {
  const utils = trpc.useUtils();

  const verticalsQuery = trpc.consumerCatalog.consumerVerticals.useQuery();
  const feeConfigQuery = trpc.consumerCatalog.consumerFeeConfig.useQuery();
  const cartQuery = trpc.consumer.myCart.useQuery();

  const [verticalId, setVerticalId] = useState<number | null>(null);
  const [providerId, setProviderId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [addedItemId, setAddedItemId] = useState<number | null>(null);

  const verticals = normalizeVerticals(verticalsQuery.data);
  const providersQuery = trpc.consumerCatalog.consumerProviders.useQuery(
    { verticalId: verticalId ?? 0 },
    { enabled: verticalId !== null },
  );
  const catalogQuery = trpc.consumerCatalog.consumerCatalog.useQuery(
    { providerId: providerId ?? 0 },
    { enabled: providerId !== null },
  );

  // Default to the first vertical once loaded.
  useEffect(() => {
    if (verticalId === null && verticals.length > 0) {
      setVerticalId(verticals[0].id);
    }
  }, [verticalId, verticals]);

  const providers = normalizeProviders(providersQuery.data);
  const catalogItems = normalizeCatalogItems(catalogQuery.data);
  const cartPayload = normalizeCartPayload(cartQuery.data);
  const cartCount = cartPayload ? cartItemCount(cartPayload.items) : 0;
  const activeCart =
    cartPayload && cartPayload.cart.status === "active"
      ? cartPayload.cart
      : null;

  const createCart = trpc.consumer.createCart.useMutation();
  const addItem = trpc.consumer.addCartItem.useMutation();
  const cartBusy = createCart.isPending || addItem.isPending;

  const addToCart = async (item: ConsumerCatalogItem) => {
    setActionError(null);
    setAddedItemId(null);
    let unitPriceMinor: number;
    try {
      unitPriceMinor = majorToMinor(item.priceMajor);
    } catch {
      setActionError(
        `"${item.itemName}" has an invalid price and cannot be added.`,
      );
      return;
    }
    try {
      let cartId = activeCart?.id ?? null;
      if (!cartId) {
        const created = await createCart.mutateAsync({
          serviceProviderId: item.providerId,
          idempotencyKey: generateConsumerIdempotencyKey(
            "cart",
            item.providerId,
          ),
        });
        cartId = created.id;
      }
      await addItem.mutateAsync({
        cartId,
        catalogItemId: item.id,
        name: item.itemName,
        unitPriceMinor,
        quantity: 1,
        modifiers: [],
      });
      setAddedItemId(item.id);
      utils.consumer.myCart.invalidate();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to update your cart.",
      );
    }
  };

  const deliveryFeeLabel = feeConfigQuery.data
    ? `${formatNairaMinor(feeConfigQuery.data.deliveryFeeMinor)} delivery`
    : "Delivery fee shown at checkout";

  return (
    <ConsumerLayout
      title="Shop the marketplace"
      description="Browse active merchants by category, add items to your cart, and check out with an exact fee breakdown."
    >
      <div className="mb-6 flex items-center justify-between gap-4">
        <Link href="/account/orders">
          <span className="text-sm font-medium text-amber-800 hover:text-amber-900">
            My account
          </span>
        </Link>
        <Link href="/shop/cart">
          <span className="inline-flex items-center gap-2 rounded-full bg-amber-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-800">
            <ShoppingCart className="h-4 w-4" />
            Cart{cartCount > 0 ? ` (${cartCount})` : ""}
          </span>
        </Link>
      </div>

      {actionError ? (
        <p
          className="mb-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          role="alert"
        >
          {actionError}
        </p>
      ) : null}

      {verticalsQuery.isError ? (
        <QueryErrorState
          resource="marketplace categories"
          message={verticalsQuery.error.message}
          onRetry={() => verticalsQuery.refetch()}
          retrying={verticalsQuery.isRefetching}
        />
      ) : verticalsQuery.isLoading ? (
        <p className="text-sm text-stone-500">Loading categories…</p>
      ) : verticals.length === 0 ? (
        <EmptyState
          title="No categories available"
          description="Marketplace categories will appear here once they are activated."
        />
      ) : (
        <div className="space-y-8">
          <section aria-label="Categories">
            <div className="flex flex-wrap gap-2">
              {verticals.map((vertical) => {
                const active = vertical.id === verticalId;
                return (
                  <button
                    key={vertical.id}
                    type="button"
                    onClick={() => {
                      setVerticalId(vertical.id);
                      setProviderId(null);
                    }}
                    className={`inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition ${
                      active
                        ? "border-amber-700 bg-amber-700 text-white"
                        : "border-stone-200 bg-white text-stone-700 hover:border-stone-300 hover:bg-stone-50"
                    }`}
                  >
                    {vertical.icon ? (
                      <span aria-hidden>{vertical.icon}</span>
                    ) : null}
                    {vertical.name}
                  </button>
                );
              })}
            </div>
          </section>

          {providerId === null ? (
            <section aria-label="Merchants">
              {providersQuery.isError ? (
                <QueryErrorState
                  resource="merchants"
                  message={providersQuery.error.message}
                  onRetry={() => providersQuery.refetch()}
                  retrying={providersQuery.isRefetching}
                />
              ) : providersQuery.isLoading || verticalId === null ? (
                <p className="text-sm text-stone-500">Loading merchants…</p>
              ) : providers.length === 0 ? (
                <EmptyState
                  title="No merchants in this category yet"
                  description="Active merchants will appear here as they join this category."
                />
              ) : (
                <ul className="grid gap-4 sm:grid-cols-2">
                  {providers.map((provider) => (
                    <li key={provider.id}>
                      <button
                        type="button"
                        onClick={() => setProviderId(provider.id)}
                        className="block w-full rounded-2xl border border-stone-200 bg-white p-5 text-left transition hover:border-amber-300 hover:bg-amber-50/40"
                      >
                        <span className="flex items-start justify-between gap-3">
                          <span className="min-w-0">
                            <span className="block truncate font-semibold text-stone-900">
                              {provider.businessName || provider.name}
                            </span>
                            {provider.address ? (
                              <span className="mt-0.5 block truncate text-sm text-stone-500">
                                {provider.address}
                              </span>
                            ) : null}
                          </span>
                          <Store className="h-5 w-5 shrink-0 text-stone-300" />
                        </span>
                        <span className="mt-3 flex flex-wrap items-center gap-3 text-xs text-stone-500">
                          <span className="inline-flex items-center gap-1">
                            <Star className="h-3.5 w-3.5 text-amber-500" />
                            {provider.rating}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <Clock className="h-3.5 w-3.5" />
                            ~25–45 min (estimate)
                          </span>
                          <span>{deliveryFeeLabel}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : (
            <section aria-label="Catalog">
              <button
                type="button"
                onClick={() => setProviderId(null)}
                className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-amber-800 hover:text-amber-900"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to merchants
              </button>
              {catalogQuery.isError ? (
                <QueryErrorState
                  resource="this merchant's catalog"
                  message={catalogQuery.error.message}
                  onRetry={() => catalogQuery.refetch()}
                  retrying={catalogQuery.isRefetching}
                />
              ) : catalogQuery.isLoading ? (
                <p className="text-sm text-stone-500">Loading catalog…</p>
              ) : catalogItems.length === 0 ? (
                <EmptyState
                  title="No items available"
                  description="This merchant has no available items right now."
                />
              ) : (
                <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {catalogItems.map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-col rounded-2xl border border-stone-200 bg-white p-5"
                    >
                      <p className="font-semibold text-stone-900">
                        {item.itemName}
                      </p>
                      {item.description ? (
                        <p className="mt-1 line-clamp-2 text-sm text-stone-500">
                          {item.description}
                        </p>
                      ) : null}
                      <div className="mt-4 flex items-center justify-between gap-2">
                        <p className="font-semibold text-stone-900">
                          {formatNairaMajor(item.priceMajor)}
                        </p>
                        <button
                          type="button"
                          disabled={cartBusy}
                          onClick={() => addToCart(item)}
                          className="rounded-full bg-amber-700 px-3.5 py-1.5 text-sm font-medium text-white transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          {addedItemId === item.id ? "Added" : "Add"}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </ConsumerLayout>
  );
}
