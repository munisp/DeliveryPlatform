/**
 * Consumer cart + checkout (P2-C).
 *
 * OFFLINE BOUNDARY: this screen is ONLINE-ONLY. Cart mutations
 * (updateCartItem / removeCartItem) and checkout (idempotency-keyed,
 * crypto-UUID-shaped key generated once per cart load) are disabled while
 * disconnected, with a clear "requires connection" state. Money display uses
 * lib/money.ts formatMinor on integer kobo (carts/sessions are MINOR units);
 * the subtotal is summed with integer math only (cartSubtotalMinor).
 */
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
} from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import {
  cartSubtotalMinor,
  checkoutSessionStatusLabel,
  useCheckout,
  useCheckoutIdempotencyKey,
  useMyCart,
  useMyCheckoutSession,
  useRemoveCartItem,
  useUpdateCartItem,
  validateCheckoutForm,
  type ConsumerCheckoutResult,
} from "@/lib/consumer";
import { useConsumerDataMode } from "@/lib/consumerOffline";
import { formatMinor } from "@/lib/money";

export default function ConsumerCartScreen() {
  const { isAuthenticated } = useAuth();
  const { connected } = useConsumerDataMode();
  const cartQuery = useMyCart();
  const updateItem = useUpdateCartItem();
  const removeItem = useRemoveCartItem();
  const checkout = useCheckout();

  const cart = cartQuery.data?.cart ?? null;
  const items = cartQuery.data?.items ?? [];
  const cartId = cart?.id ?? null;
  const checkoutKey = useCheckoutIdempotencyKey(cartId);

  const [address, setAddress] = useState("");
  const [latText, setLatText] = useState("");
  const [lngText, setLngText] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [session, setSession] = useState<ConsumerCheckoutResult | null>(null);

  const polling =
    session?.status === "open" || session?.status === "payment_pending"
      ? 4_000
      : undefined;
  const sessionQuery = useMyCheckoutSession(session?.checkoutSessionId ?? null, polling);
  useEffect(() => {
    if (sessionQuery.data) setSession(sessionQuery.data);
  }, [sessionQuery.data]);

  const subtotal = cartSubtotalMinor(items);
  const writesBlocked = !connected || !isAuthenticated;

  const changeQuantity = async (itemId: string, quantity: number) => {
    if (!cartId || writesBlocked) return;
    if (quantity < 1) return;
    await updateItem.mutateAsync({ cartId, itemId, quantity });
    await cartQuery.refetch();
  };

  const remove = async (itemId: string) => {
    if (!cartId || writesBlocked) return;
    await removeItem.mutateAsync({ cartId, itemId });
    await cartQuery.refetch();
  };

  const submitCheckout = async () => {
    if (!cartId || !checkoutKey || writesBlocked) return;
    const lat = Number(latText);
    const lng = Number(lngText);
    const error = validateCheckoutForm({
      deliveryAddress: address,
      deliveryLat: lat,
      deliveryLng: lng,
      notes: notes.trim() ? notes.trim() : undefined,
    });
    setFormError(error);
    if (error) return;
    try {
      const result = await checkout.mutateAsync({
        cartId,
        idempotencyKey: checkoutKey,
        deliveryAddress: address.trim(),
        deliveryLat: lat,
        deliveryLng: lng,
        notes: notes.trim() ? notes.trim() : null,
      });
      setSession(result);
      await cartQuery.refetch();
    } catch (mutationError) {
      setFormError(
        mutationError instanceof Error ? mutationError.message : "Checkout failed",
      );
    }
  };

  if (!isAuthenticated) {
    return (
      <ScreenContainer className="px-4 pb-6">
        <View className="pt-10">
          <EmptyState
            title="Sign in to use the cart"
            body="Carts and checkout require an authenticated consumer session."
          />
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}>
        <View>
          <Text className="text-3xl font-bold text-foreground">Cart & Checkout</Text>
          <Text className="mt-2 text-sm leading-6 text-muted">
            Review items, then check out with an idempotency-protected request.
            All actions on this screen require a connection.
          </Text>
        </View>

        {!connected ? (
          <View className="rounded-[20px] border border-warning/40 bg-warning/10 px-4 py-3">
            <Text className="text-sm font-semibold text-warning">Offline</Text>
            <Text className="mt-1 text-sm leading-6 text-muted">
              Cart changes and checkout require connection. Your last synced
              catalog remains browsable from the Shop screen.
            </Text>
          </View>
        ) : null}

        <SectionCard
          title="Items"
          subtitle={cart ? `Cart ${cart.id.slice(0, 8)}… · ${cart.status}` : "No active cart"}
        >
          {cartQuery.isLoading ? (
            <LoadingSkeleton rows={3} />
          ) : items.length === 0 ? (
            <EmptyState
              title="Cart is empty"
              body="Add items from the Shop screen; they appear here immediately."
            />
          ) : (
            <View className="gap-3">
              {items.map((item) => (
                <View
                  key={item.id}
                  className="rounded-[20px] border border-border bg-background/70 px-4 py-3"
                >
                  <View className="flex-row items-center justify-between gap-3">
                    <View className="flex-1">
                      <Text className="text-sm font-semibold text-foreground">
                        {item.name}
                      </Text>
                      <Text className="mt-1 text-xs text-muted">
                        {formatMinor(Number(item.unitPriceMinor))} each
                      </Text>
                    </View>
                    {writesBlocked ? (
                      <Text className="text-xs font-semibold text-muted">
                        ×{item.quantity}
                      </Text>
                    ) : (
                      <View className="flex-row items-center gap-2">
                        <Pressable
                          onPress={() => void changeQuantity(item.id, item.quantity - 1)}
                          className="rounded-full bg-background px-3 py-2"
                        >
                          <Text className="text-xs font-semibold text-foreground">−</Text>
                        </Pressable>
                        <Text className="text-sm font-semibold text-foreground">
                          {item.quantity}
                        </Text>
                        <Pressable
                          onPress={() => void changeQuantity(item.id, item.quantity + 1)}
                          className="rounded-full bg-background px-3 py-2"
                        >
                          <Text className="text-xs font-semibold text-foreground">+</Text>
                        </Pressable>
                      </View>
                    )}
                  </View>
                  {!writesBlocked ? (
                    <Pressable onPress={() => void remove(item.id)} className="mt-2 self-start">
                      <Text className="text-xs font-semibold text-error">Remove</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
              <View className="flex-row items-center justify-between rounded-[20px] border border-border bg-background px-4 py-3">
                <Text className="text-sm font-semibold text-foreground">Subtotal</Text>
                <Text className="text-sm font-semibold text-foreground">
                  {formatMinor(subtotal)}
                </Text>
              </View>
            </View>
          )}
        </SectionCard>

        {session ? (
          <SectionCard
            title="Checkout session"
            subtitle={`${session.orderNumber} · ${checkoutSessionStatusLabel(session.status)}`}
          >
            <View className="gap-3 rounded-[20px] border border-border bg-background/70 px-4 py-3">
              <Row label="Status" value={checkoutSessionStatusLabel(session.status)} />
              <Row label="Subtotal" value={formatMinor(session.subtotalMinor, session.currency)} />
              <Row label="Platform fee" value={formatMinor(session.platformFeeMinor, session.currency)} />
              <Row label="Delivery fee" value={formatMinor(session.deliveryFeeMinor, session.currency)} />
              <Row label="Total" value={formatMinor(session.totalMinor, session.currency)} />
              {session.paymentReference ? (
                <Row label="Payment ref" value={session.paymentReference} />
              ) : null}
              {session.replayed ? (
                <Text className="text-xs text-muted">
                  Idempotent replay — this order was already created for this key.
                </Text>
              ) : null}
            </View>
          </SectionCard>
        ) : items.length > 0 ? (
          <SectionCard
            title="Delivery & payment"
            subtitle="Checkout creates the order and a payment session in one idempotent call."
          >
            <View className="gap-3">
              <Field label="Delivery address" value={address} onChangeText={setAddress} />
              <View className="flex-row gap-3">
                <View className="flex-1">
                  <Field label="Latitude" value={latText} onChangeText={setLatText} keyboard="decimal-pad" />
                </View>
                <View className="flex-1">
                  <Field label="Longitude" value={lngText} onChangeText={setLngText} keyboard="decimal-pad" />
                </View>
              </View>
              <Field label="Notes (optional)" value={notes} onChangeText={setNotes} />
            </View>
            {formError ? (
              <Text className="text-xs font-semibold text-error">{formError}</Text>
            ) : null}
            {writesBlocked ? (
              <Text className="text-xs font-semibold text-muted">
                Requires connection to check out
              </Text>
            ) : (
              <Pressable
                onPress={() => void submitCheckout()}
                disabled={checkout.isPending}
                className="rounded-full bg-primary px-4 py-3"
              >
                <Text className="text-center text-xs font-semibold text-white">
                  {checkout.isPending
                    ? "Checking out…"
                    : `Checkout · ${formatMinor(subtotal)}`}
                </Text>
              </Pressable>
            )}
          </SectionCard>
        ) : null}
      </ScrollView>
    </ScreenContainer>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View className="flex-row items-center justify-between gap-3">
      <Text className="text-sm text-muted">{label}</Text>
      <Text className="text-sm font-semibold text-foreground">{value}</Text>
    </View>
  );
}

function Field({
  label,
  value,
  onChangeText,
  keyboard,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  keyboard?: "default" | "decimal-pad";
}) {
  return (
    <View>
      <Text className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
        {label}
      </Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        autoCapitalize="none"
        keyboardType={keyboard ?? "default"}
        placeholder={label}
        placeholderTextColor="#6B7F97"
        className="rounded-2xl border border-border bg-background px-4 py-3 text-sm text-foreground"
      />
    </View>
  );
}
