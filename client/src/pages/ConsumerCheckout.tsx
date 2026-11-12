import { FormEvent, useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, CheckCircle2, MapPin, XCircle } from "lucide-react";

import { ConsumerLayout } from "@/components/ConsumerLayout";
import { EmptyState, QueryErrorState } from "@/components/QueryState";
import { trpc } from "@/lib/trpc";
import {
  cartSubtotalMinor,
  cartVersion,
  formatNairaMinor,
  getOrCreateCheckoutKey,
  isTerminalCheckoutStatus,
  normalizeCartPayload,
  normalizeCheckoutResult,
} from "@/lib/consumerWire";

/**
 * /shop/checkout — delivery details + idempotent checkout.
 *
 * No PlaceSearchField component exists on main, so the address form is
 * manual: free-text address plus latitude/longitude entry (paste from a map
 * app), per the approved fallback.
 *
 * The idempotency key comes from getOrCreateCheckoutKey(cartId,
 * cart.updatedAt): stable across remounts and retries of the SAME cart
 * version (server replays the stored session on payment_initiation_failed),
 * rotated whenever the cart changes. After checkout the page renders the
 * payment_pending state with the payment reference and polls
 * consumer.myCheckoutSession until the session reaches a terminal status
 * (paid | failed | expired).
 */
export default function ConsumerCheckout() {
  const cartQuery = trpc.consumer.myCart.useQuery(undefined, {
    // The checkout page must reflect the cart as it is right now.
    refetchOnMount: "always",
  });
  const payload = normalizeCartPayload(cartQuery.data);
  const cart = payload ? payload.cart : null;
  const items = payload ? payload.items : [];

  const [address, setAddress] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [checkoutResult, setCheckoutResult] = useState<ReturnType<
    typeof normalizeCheckoutResult
  > | null>(null);

  const checkout = trpc.consumer.checkout.useMutation({
    onSuccess: (result) => {
      const normalized = normalizeCheckoutResult(result);
      setCheckoutResult(normalized);
      setSessionId(normalized?.checkoutSessionId ?? null);
      setFormError(null);
    },
    onError: (error) => setFormError(error.message),
  });

  const sessionQuery = trpc.consumer.myCheckoutSession.useQuery(
    { checkoutSessionId: sessionId ?? "" },
    {
      enabled: sessionId !== null,
      refetchInterval: (query) => {
        const data = normalizeCheckoutResult(query.state.data);
        return data && isTerminalCheckoutStatus(data.status) ? false : 4000;
      },
    },
  );

  const session = useMemo(
    () => normalizeCheckoutResult(sessionQuery.data) ?? checkoutResult,
    [sessionQuery.data, checkoutResult],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (!cart) {
      setFormError("Your cart is not available. Return to the cart page.");
      return;
    }
    const parsedLat = Number(lat);
    const parsedLng = Number(lng);
    if (address.trim().length < 3) {
      setFormError("Enter a delivery address (at least 3 characters).");
      return;
    }
    if (
      !Number.isFinite(parsedLat) ||
      parsedLat < -90 ||
      parsedLat > 90 ||
      !Number.isFinite(parsedLng) ||
      parsedLng < -180 ||
      parsedLng > 180
    ) {
      setFormError(
        "Enter valid coordinates — latitude between -90 and 90, longitude between -180 and 180.",
      );
      return;
    }
    checkout.mutate({
      cartId: cart.id,
      idempotencyKey: getOrCreateCheckoutKey(cart.id, cartVersion(cart)),
      deliveryAddress: address.trim(),
      deliveryLat: parsedLat,
      deliveryLng: parsedLng,
      notes: notes.trim() === "" ? undefined : notes.trim(),
    });
  };

  const subtotalMinor = items.length > 0 ? cartSubtotalMinor(items) : 0;

  return (
    <ConsumerLayout
      title="Checkout"
      description="Confirm your delivery details and pay. Your checkout is idempotent — retries never double-charge."
    >
      <div className="mb-6">
        <Link href="/shop/cart">
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-800 hover:text-amber-900">
            <ArrowLeft className="h-4 w-4" />
            Back to cart
          </span>
        </Link>
      </div>

      {cartQuery.isError ? (
        <QueryErrorState
          resource="your cart"
          message={cartQuery.error.message}
          onRetry={() => cartQuery.refetch()}
          retrying={cartQuery.isRefetching}
        />
      ) : cartQuery.isLoading ? (
        <p className="text-sm text-stone-500">Loading checkout…</p>
      ) : !cart || items.length === 0 ? (
        <EmptyState
          title="Nothing to check out"
          description="Your cart is empty. Add items from the marketplace first."
        />
      ) : session ? (
        <section className="rounded-2xl border border-stone-200 bg-white p-6">
          {session.status === "paid" ? (
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 text-emerald-600" />
              <div>
                <h2 className="text-base font-semibold text-stone-900">
                  Payment confirmed
                </h2>
                <p className="mt-1 text-sm text-stone-500">
                  Order {session.orderNumber} is paid. Track it from your
                  orders page.
                </p>
                <Link href={`/account/orders/${session.orderId}`}>
                  <span className="mt-3 inline-flex rounded-full bg-amber-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-amber-800">
                    View order
                  </span>
                </Link>
              </div>
            </div>
          ) : session.status === "failed" || session.status === "expired" ? (
            <div className="flex items-start gap-3">
              <XCircle className="mt-0.5 h-5 w-5 text-rose-600" />
              <div>
                <h2 className="text-base font-semibold text-stone-900">
                  Payment {session.status}
                </h2>
                <p className="mt-1 text-sm text-stone-500">
                  This checkout session {session.status}. Your cart and order
                  are preserved — start a new checkout from the cart page.
                </p>
                <Link href="/shop/cart">
                  <span className="mt-3 inline-flex rounded-full border border-stone-200 px-4 py-2 text-sm font-medium text-stone-700 transition hover:bg-stone-50">
                    Return to cart
                  </span>
                </Link>
              </div>
            </div>
          ) : (
            <div>
              <h2 className="text-base font-semibold text-stone-900">
                Awaiting payment
              </h2>
              <p className="mt-1 text-sm text-stone-500">
                Complete the transfer with the reference below. This page
                updates automatically when the payment lands.
              </p>
              <dl className="mt-4 space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-stone-500">Payment reference</dt>
                  <dd className="font-mono font-medium text-stone-900">
                    {session.paymentReference ?? "pending"}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-stone-500">Order</dt>
                  <dd className="font-medium text-stone-900">
                    {session.orderNumber}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-stone-500">Subtotal</dt>
                  <dd className="font-medium text-stone-900">
                    {formatNairaMinor(session.subtotalMinor)}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-stone-500">Platform fee</dt>
                  <dd className="font-medium text-stone-900">
                    {formatNairaMinor(session.platformFeeMinor)}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-stone-500">Delivery fee</dt>
                  <dd className="font-medium text-stone-900">
                    {formatNairaMinor(session.deliveryFeeMinor)}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-t border-stone-200 pt-2">
                  <dt className="font-semibold text-stone-900">Total</dt>
                  <dd className="font-semibold text-stone-900">
                    {formatNairaMinor(session.totalMinor)}
                  </dd>
                </div>
                {session.expiresAt ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-stone-500">Session expires</dt>
                    <dd className="text-stone-700">
                      {new Date(session.expiresAt).toLocaleString()}
                    </dd>
                  </div>
                ) : null}
              </dl>
              <p className="mt-4 text-xs text-stone-400">
                Status: {session.status.replace(/_/g, " ")}
                {sessionQuery.isFetching ? " · refreshing…" : ""}
              </p>
            </div>
          )}
        </section>
      ) : (
        <div className="space-y-8">
          <section className="rounded-2xl border border-stone-200 bg-white p-6">
            <h2 className="mb-4 text-base font-semibold text-stone-900">
              Order summary
            </h2>
            <ul className="divide-y divide-stone-100 text-sm">
              {items.map((item) => (
                <li key={item.id} className="flex justify-between py-2">
                  <span className="text-stone-700">
                    {item.quantity} × {item.name}
                  </span>
                  <span className="font-medium text-stone-900">
                    {formatNairaMinor(item.unitPriceMinor * item.quantity)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-2 flex justify-between border-t border-stone-200 pt-2 text-sm">
              <span className="text-stone-500">Subtotal</span>
              <span className="font-semibold text-stone-900">
                {formatNairaMinor(subtotalMinor)}
              </span>
            </div>
            <p className="mt-1 text-xs text-stone-400">
              Platform and delivery fees are confirmed on the payment screen.
            </p>
          </section>

          <form
            onSubmit={submit}
            className="rounded-2xl border border-stone-200 bg-white p-6"
          >
            <h2 className="mb-4 flex items-center gap-2 text-base font-semibold text-stone-900">
              <MapPin className="h-4 w-4 text-amber-700" />
              Delivery details
            </h2>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="delivery-address"
                  className="text-sm font-medium text-stone-700"
                >
                  Delivery address
                </label>
                <textarea
                  id="delivery-address"
                  required
                  minLength={3}
                  maxLength={500}
                  rows={2}
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="Street, area, landmark"
                  className="w-full rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-900 outline-none transition focus:border-amber-500"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <label
                    htmlFor="delivery-lat"
                    className="text-sm font-medium text-stone-700"
                  >
                    Latitude
                  </label>
                  <input
                    id="delivery-lat"
                    required
                    inputMode="decimal"
                    value={lat}
                    onChange={(event) => setLat(event.target.value)}
                    placeholder="e.g. 6.5244"
                    className="w-full rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-900 outline-none transition focus:border-amber-500"
                  />
                </div>
                <div className="space-y-1.5">
                  <label
                    htmlFor="delivery-lng"
                    className="text-sm font-medium text-stone-700"
                  >
                    Longitude
                  </label>
                  <input
                    id="delivery-lng"
                    required
                    inputMode="decimal"
                    value={lng}
                    onChange={(event) => setLng(event.target.value)}
                    placeholder="e.g. 3.3792"
                    className="w-full rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-900 outline-none transition focus:border-amber-500"
                  />
                </div>
              </div>
              <p className="text-xs text-stone-400">
                No map picker is available in this wave — drop a pin in your
                map app and paste the coordinates here.
              </p>
              <div className="space-y-1.5">
                <label
                  htmlFor="delivery-notes"
                  className="text-sm font-medium text-stone-700"
                >
                  Notes for the courier (optional)
                </label>
                <input
                  id="delivery-notes"
                  maxLength={2000}
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Gate code, call on arrival…"
                  className="w-full rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-900 outline-none transition focus:border-amber-500"
                />
              </div>
            </div>
            {formError ? (
              <p
                className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700"
                role="alert"
              >
                {formError}
              </p>
            ) : null}
            <button
              type="submit"
              disabled={checkout.isPending}
              className="mt-6 w-full rounded-full bg-amber-700 px-5 py-3 text-sm font-medium text-white transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {checkout.isPending ? "Placing order…" : "Place order and pay"}
            </button>
          </form>
        </div>
      )}
    </ConsumerLayout>
  );
}
