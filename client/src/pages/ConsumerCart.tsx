import { useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, CloudOff, Minus, Plus, Trash2 } from "lucide-react";

import { ConsumerLayout } from "@/components/ConsumerLayout";
import { EmptyState, QueryErrorState } from "@/components/QueryState";
import {
  enqueueConsumerCartDraft,
  isOfflineMutationError,
  registerConsumerOutboxSync,
  useConsumerOutbox,
} from "@/lib/consumerOfflineQueue";
import { useSessionProfile } from "@/lib/sessionProfile";
import { trpc } from "@/lib/trpc";
import {
  cartSubtotalMinor,
  computeFeeBreakdown,
  formatNairaMinor,
  getOrCreateCheckoutKey,
  cartVersion,
  normalizeCartPayload,
  type ConsumerCartItemView,
} from "@/lib/consumerWire";

function ModifierList({ modifiers }: { modifiers: Array<Record<string, unknown>> }) {
  if (modifiers.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {modifiers.map((modifier, index) => (
        <li key={index} className="text-xs text-stone-400">
          {Object.entries(modifier)
            .map(([key, value]) => `${key}: ${String(value)}`)
            .join(" · ")}
        </li>
      ))}
    </ul>
  );
}

/**
 * /shop/cart — line items with quantity steppers and modifiers, an exact ₦
 * fee breakdown, and the idempotency-keyed checkout handoff.
 *
 * Subtotal is computed with integer minor-unit math from myCart. Platform
 * and delivery fees come from the server-published fee config
 * (consumerCatalog.consumerFeeConfig), so the projection is identical to
 * what consumer.checkout will compute; while the config is unavailable the
 * fee rows are labeled "calculated at checkout" instead of guessing.
 *
 * The checkout key is generated per cart VERSION (cart.updatedAt) and
 * cached (getOrCreateCheckoutKey), so edits rotate the key and retries of
 * the same cart version replay the same server-side session.
 */
export default function ConsumerCart() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const cartQuery = trpc.consumer.myCart.useQuery();
  const feeConfigQuery = trpc.consumerCatalog.consumerFeeConfig.useQuery();
  const [actionError, setActionError] = useState<string | null>(null);

  const payload = normalizeCartPayload(cartQuery.data);
  const cart = payload && payload.cart.status === "active" ? payload.cart : null;
  const items = cart ? payload!.items : [];

  // Offline outbox (P5-OFFLINE): a stepper/remove that fails because the
  // device is offline is queued (latest edit per line wins) and replayed
  // via the same tRPC mutations when connectivity returns. Success paths
  // and money math are untouched.
  const sessionProfile = useSessionProfile();
  const accountId = sessionProfile.data ? String(sessionProfile.data.id) : null;
  const replayUpdate = trpc.consumer.updateCartItem.useMutation({
    onSuccess: () => utils.consumer.myCart.invalidate(),
  });
  const replayRemove = trpc.consumer.removeCartItem.useMutation({
    onSuccess: () => utils.consumer.myCart.invalidate(),
  });
  const outbox = useConsumerOutbox(accountId, {
    updateCartItem: (input) => replayUpdate.mutateAsync(input),
    removeCartItem: (input) => replayRemove.mutateAsync(input),
  });

  const queueCartDraft = (draft: Parameters<typeof enqueueConsumerCartDraft>[1]) => {
    if (!accountId) return;
    void (async () => {
      const result = await enqueueConsumerCartDraft(accountId, draft);
      if (result === "enqueued") void registerConsumerOutboxSync();
      await outbox.refresh();
    })();
  };

  const updateItem = trpc.consumer.updateCartItem.useMutation({
    onSuccess: () => utils.consumer.myCart.invalidate(),
    onError: (error, variables) => {
      if (accountId && variables && isOfflineMutationError(error)) {
        queueCartDraft({
          kind: "updateCartItem",
          cartId: variables.cartId,
          itemId: variables.itemId,
          quantity: variables.quantity,
        });
        setActionError(null);
        return;
      }
      setActionError(error.message);
    },
  });
  const removeItem = trpc.consumer.removeCartItem.useMutation({
    onSuccess: () => utils.consumer.myCart.invalidate(),
    onError: (error, variables) => {
      if (accountId && variables && isOfflineMutationError(error)) {
        queueCartDraft({
          kind: "removeCartItem",
          cartId: variables.cartId,
          itemId: variables.itemId,
        });
        setActionError(null);
        return;
      }
      setActionError(error.message);
    },
  });
  const busy = updateItem.isPending || removeItem.isPending;

  const setQuantity = (item: ConsumerCartItemView, quantity: number) => {
    if (!cart) return;
    setActionError(null);
    if (quantity <= 0) {
      removeItem.mutate({ cartId: cart.id, itemId: item.id });
    } else {
      updateItem.mutate({ cartId: cart.id, itemId: item.id, quantity });
    }
  };

  const goToCheckout = () => {
    if (!cart || items.length === 0) return;
    // Generate (or reuse) the per-cart-version key now so the checkout page
    // submits with a stable, regex-conformant idempotency key.
    getOrCreateCheckoutKey(cart.id, cartVersion(cart));
    navigate("/shop/checkout");
  };

  const subtotalMinor = items.length > 0 ? cartSubtotalMinor(items) : 0;
  const feeConfig = feeConfigQuery.data ?? null;
  const breakdown = feeConfig
    ? computeFeeBreakdown(
        subtotalMinor,
        feeConfig.platformFeeBps,
        feeConfig.deliveryFeeMinor,
      )
    : null;

  return (
    <ConsumerLayout
      title="Your cart"
      description="Review items, adjust quantities, and check out with an exact fee breakdown in naira."
    >
      <div className="mb-6">
        <Link href="/shop">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-800 hover:text-amber-900">
            <ArrowLeft className="h-4 w-4" />
            Continue shopping
          </span>
        </Link>
      </div>

      {outbox.queuedCount > 0 ? (
        <p
          className="mb-6 inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800"
          role="status"
          aria-live="polite"
          title="You are offline. Changes are stored on this device and will sync when you are back online."
        >
          <CloudOff className="h-3.5 w-3.5" />
          Offline — {outbox.queuedCount} cart change
          {outbox.queuedCount === 1 ? "" : "s"} queued; they will sync when
          you are back online.
        </p>
      ) : null}

      {actionError ? (
        <p
          className="mb-6 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
          role="alert"
        >
          {actionError}
        </p>
      ) : null}

      {cartQuery.isError ? (
        <QueryErrorState
          resource="your cart"
          message={cartQuery.error.message}
          onRetry={() => cartQuery.refetch()}
          retrying={cartQuery.isRefetching}
        />
      ) : cartQuery.isLoading ? (
        <p className="text-sm text-stone-500">Loading your cart…</p>
      ) : !cart || items.length === 0 ? (
        <EmptyState
          title="Your cart is empty"
          description="Browse the marketplace and add items — they will appear here with an exact fee breakdown."
        />
      ) : (
        <div className="space-y-8">
          <ul className="divide-y divide-stone-200 rounded-2xl border border-stone-200 bg-white">
            {items.map((item) => (
              <li key={item.id} className="flex items-start gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-stone-900">{item.name}</p>
                  <p className="mt-0.5 text-sm text-stone-500">
                    {formatNairaMinor(item.unitPriceMinor)} each
                  </p>
                  <ModifierList modifiers={item.modifiers} />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={`Decrease quantity of ${item.name}`}
                    disabled={busy}
                    onClick={() => setQuantity(item, item.quantity - 1)}
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-200 text-stone-600 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Minus className="h-4 w-4" />
                  </button>
                  <span className="w-8 text-center text-sm font-medium text-stone-900">
                    {item.quantity}
                  </span>
                  <button
                    type="button"
                    aria-label={`Increase quantity of ${item.name}`}
                    disabled={busy || item.quantity >= 999}
                    onClick={() => setQuantity(item, item.quantity + 1)}
                    className="flex h-8 w-8 items-center justify-center rounded-full border border-stone-200 text-stone-600 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
                <div className="w-24 text-right">
                  <p className="font-semibold text-stone-900">
                    {formatNairaMinor(item.unitPriceMinor * item.quantity)}
                  </p>
                  <button
                    type="button"
                    aria-label={`Remove ${item.name}`}
                    disabled={busy}
                    onClick={() => setQuantity(item, 0)}
                    className="mt-1 inline-flex items-center gap-1 text-xs text-stone-400 transition hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>

          <section className="rounded-2xl border border-stone-200 bg-white p-6">
            <h2 className="mb-4 text-base font-semibold text-stone-900">
              Fee breakdown
            </h2>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-stone-500">Subtotal</dt>
                <dd className="font-medium text-stone-900">
                  {formatNairaMinor(subtotalMinor)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-stone-500">Platform fee</dt>
                <dd className="font-medium text-stone-900">
                  {breakdown
                    ? formatNairaMinor(breakdown.platformFeeMinor)
                    : "Calculated at checkout"}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-stone-500">Delivery fee</dt>
                <dd className="font-medium text-stone-900">
                  {breakdown
                    ? formatNairaMinor(breakdown.deliveryFeeMinor)
                    : "Calculated at checkout"}
                </dd>
              </div>
              <div className="flex justify-between border-t border-stone-200 pt-2">
                <dt className="font-semibold text-stone-900">Total</dt>
                <dd className="font-semibold text-stone-900">
                  {breakdown
                    ? formatNairaMinor(breakdown.totalMinor)
                    : formatNairaMinor(subtotalMinor)}
                </dd>
              </div>
            </dl>
            <button
              type="button"
              disabled={busy || items.length === 0}
              onClick={goToCheckout}
              className="mt-6 w-full rounded-full bg-amber-700 px-5 py-3 text-sm font-medium text-white transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Proceed to checkout
            </button>
          </section>
        </div>
      )}
    </ConsumerLayout>
  );
}
