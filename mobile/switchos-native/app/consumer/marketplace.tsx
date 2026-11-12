/**
 * Consumer marketplace (P2-C): verticals → providers → catalog drill-in.
 *
 * OFFLINE BOUNDARY:
 *   - READS render live via consumerCatalog.* (falling back to the PowerSync
 *     local replica when disconnected, and to demo fixtures while the
 *     consumerCatalog router is still landing — see lib/consumerCatalogSource.ts).
 *   - WRITES (createCart / addCartItem) are ONLINE-ONLY this wave. When the
 *     device is offline, the Add buttons are replaced by a "requires
 *     connection" state; nothing is queued locally for later replay.
 */
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";

import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
} from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import {
  formatMajorAmount,
  newConsumerIdempotencyKey,
  parseMajorToMinor,
  useAddCartItem,
  useCreateCart,
  useMyCart,
} from "@/lib/consumer";
import {
  useCatalogItems,
  useCatalogProviders,
  useCatalogVerticals,
  type CatalogItem,
  type CatalogSourceKind,
} from "@/lib/consumerCatalogSource";
import { useConsumerDataMode } from "@/lib/consumerOffline";

function SourceBadge({ source }: { source: CatalogSourceKind }) {
  const label =
    source === "live"
      ? "Live catalog"
      : source === "offline-replica"
        ? "Offline — synced replica"
        : "Demo catalog (live source pending)";
  return (
    <View className="self-start rounded-full bg-background px-3 py-1">
      <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted">
        {label}
      </Text>
    </View>
  );
}

export default function ConsumerMarketplaceScreen() {
  const { isAuthenticated } = useAuth();
  const { connected } = useConsumerDataMode();
  const [verticalId, setVerticalId] = useState<number | null>(null);
  const [providerId, setProviderId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const verticals = useCatalogVerticals();
  const providers = useCatalogProviders(verticalId);
  const items = useCatalogItems(providerId);

  const cart = useMyCart();
  const createCart = useCreateCart();
  const addItem = useAddCartItem();
  const [addingItemId, setAddingItemId] = useState<number | null>(null);

  // One idempotency key per mounted browse session for cart creation.
  const cartKey = useMemo(() => newConsumerIdempotencyKey("cart"), []);

  const writesBlocked = !connected || !isAuthenticated;

  const addToCart = async (item: CatalogItem) => {
    if (writesBlocked) return;
    const unitPriceMinor = parseMajorToMinor(item.priceMajor);
    if (unitPriceMinor === null || unitPriceMinor < 0) {
      setNotice(`Cannot price ${item.itemName} — invalid catalog price.`);
      return;
    }
    setAddingItemId(item.id);
    setNotice(null);
    try {
      let cartId = cart.data?.cart.id;
      if (!cartId) {
        const created = await createCart.mutateAsync({
          serviceProviderId: item.providerId,
          idempotencyKey: cartKey,
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
      await cart.refetch();
      setNotice(`${item.itemName} added to cart.`);
    } catch (error) {
      setNotice(
        `Could not add item: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      setAddingItemId(null);
    }
  };

  if (!isAuthenticated) {
    return (
      <ScreenContainer className="px-4 pb-6">
        <View className="pt-10">
          <EmptyState
            title="Sign in to shop"
            body="The consumer marketplace needs an authenticated session to read the catalog and manage a cart."
          />
        </View>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}>
        <View>
          <Text className="text-3xl font-bold text-foreground">Shop</Text>
          <Text className="mt-2 text-sm leading-6 text-muted">
            Browse verticals, pick a provider, and build a cart. Cart writes
            require a connection; offline browsing uses the synced replica.
          </Text>
        </View>

        <SourceBadge source={verticals.source} />

        {notice ? (
          <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
            <Text className="text-sm text-foreground">{notice}</Text>
          </View>
        ) : null}

        <SectionCard
          title="1. Choose a vertical"
          subtitle="Service categories synced from the platform reference data."
        >
          {verticals.loading ? (
            <LoadingSkeleton rows={3} />
          ) : verticals.rows.length === 0 ? (
            <EmptyState
              title="No verticals available"
              body="Connect once to sync the catalog reference data, then browse offline afterwards."
            />
          ) : (
            <View className="flex-row flex-wrap gap-2">
              {verticals.rows.map((vertical) => (
                <Pressable
                  key={vertical.id}
                  onPress={() => {
                    setVerticalId(vertical.id);
                    setProviderId(null);
                  }}
                  className={
                    verticalId === vertical.id
                      ? "rounded-full bg-primary px-4 py-2"
                      : "rounded-full bg-background px-4 py-2"
                  }
                >
                  <Text
                    className={
                      verticalId === vertical.id
                        ? "text-xs font-semibold text-white"
                        : "text-xs font-semibold text-foreground"
                    }
                  >
                    {vertical.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        </SectionCard>

        {verticalId !== null ? (
          <SectionCard
            title="2. Choose a provider"
            subtitle="Active providers in the selected vertical."
          >
            {providers.loading ? (
              <LoadingSkeleton rows={3} />
            ) : providers.rows.length === 0 ? (
              <EmptyState
                title="No providers here yet"
                body="Try another vertical, or reconnect to refresh the replica."
              />
            ) : (
              <View className="gap-3">
                {providers.rows.map((provider) => (
                  <Pressable
                    key={provider.id}
                    onPress={() => setProviderId(provider.id)}
                    className={`rounded-[20px] border px-4 py-3 ${
                      providerId === provider.id
                        ? "border-primary bg-primary/10"
                        : "border-border bg-background/70"
                    }`}
                  >
                    <Text className="text-sm font-semibold text-foreground">
                      {provider.businessName ?? provider.name}
                    </Text>
                    <Text className="mt-1 text-xs text-muted">
                      {provider.address ?? "Address on file"}
                      {provider.rating ? ` · ★ ${provider.rating}` : ""}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}
          </SectionCard>
        ) : null}

        {providerId !== null ? (
          <SectionCard
            title="3. Add items to cart"
            subtitle="Prices are shown in whole currency; cart math happens in integer minor units."
          >
            {items.loading ? (
              <LoadingSkeleton rows={3} />
            ) : items.rows.length === 0 ? (
              <EmptyState
                title="No items listed"
                body="This provider has not published catalog items yet."
              />
            ) : (
              <View className="gap-3">
                {items.rows.map((item) => (
                  <View
                    key={item.id}
                    className="rounded-[20px] border border-border bg-background/70 px-4 py-3"
                  >
                    <View className="flex-row items-start justify-between gap-3">
                      <View className="flex-1">
                        <Text className="text-sm font-semibold text-foreground">
                          {item.itemName}
                        </Text>
                        {item.description ? (
                          <Text className="mt-1 text-xs leading-5 text-muted">
                            {item.description}
                          </Text>
                        ) : null}
                        <Text className="mt-1 text-xs text-muted">SKU {item.sku}</Text>
                      </View>
                      <Text className="text-sm font-semibold text-foreground">
                        {formatMajorAmount(item.priceMajor, item.currency)}
                      </Text>
                    </View>
                    {writesBlocked ? (
                      <Text className="mt-3 text-xs font-semibold text-muted">
                        Requires connection to add to cart
                      </Text>
                    ) : (
                      <Pressable
                        onPress={() => void addToCart(item)}
                        disabled={addingItemId === item.id}
                        className="mt-3 self-start rounded-full bg-primary px-4 py-2"
                      >
                        <Text className="text-xs font-semibold text-white">
                          {addingItemId === item.id ? "Adding…" : "Add to cart"}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                ))}
              </View>
            )}
          </SectionCard>
        ) : null}

        <Pressable
          onPress={() => router.push("/consumer/cart" as never)}
          className="rounded-full bg-accent2 px-4 py-3"
        >
          <Text className="text-center text-xs font-semibold text-white">
            Review cart & checkout
          </Text>
        </Pressable>
      </ScrollView>
    </ScreenContainer>
  );
}
