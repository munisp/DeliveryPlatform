/**
 * Merchant catalog (P4-N, WS-NATIVE merchant).
 *
 * OFFLINE BOUNDARY:
 *   - READS: online renders the own-catalog live view
 *     (consumerCatalog.consumerCatalog, providerId-pinned); disconnected
 *     renders the PowerSync merchant_store replica (provider_catalog_items).
 *   - WRITES: storefront display-field updates
 *     (merchantSelfServe.updateStorefrontProfile — owner-only, idempotent)
 *     are ONLINE-ONLY; offline attempts queue to the operator outbox (lane
 *     merchant_catalog). Product creation/projection lives in the PWA
 *     merchant portal (createProduct/publishCatalogProjection are NOT
 *     surfaced here this wave — catalog is read + storefront-edit only).
 *
 * MONEY: catalog prices are TEXT major units, displayed via
 * formatMajorAmount (integer string math, never floats).
 */
import { useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import {
  EmptyState,
  LoadingSkeleton,
  SectionCard,
} from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import { formatMajorAmount } from "@/lib/consumer";
import { useConsumerDataMode, useReplicaQuery } from "@/lib/consumerOffline";
import {
  buildMerchantQueuedAction,
  mapMerchantApiError,
  mapMerchantReplicaCatalogRow,
  MERCHANT_CATALOG_SQL,
  newMerchantIdempotencyKey,
  useMerchantCatalog,
  useUpdateStorefrontProfile,
  type MerchantReplicaCatalogRow,
} from "@/lib/merchantApi";
import { queueAction } from "@/lib/mobile/offline-sync-sqlite";
import { useMerchantProvider } from "./orders";

export default function MerchantCatalogScreen() {
  const { isAuthenticated, user } = useAuth();
  const { connected } = useConsumerDataMode();
  const { provider } = useMerchantProvider();
  const providerId = provider?.providerId ?? null;

  const live = useMerchantCatalog(connected ? providerId : null);
  const replica = useReplicaQuery(
    isAuthenticated && !connected,
    MERCHANT_CATALOG_SQL,
    [],
    mapMerchantReplicaCatalogRow,
  );

  const updateStorefront = useUpdateStorefrontProfile();
  const [displayName, setDisplayName] = useState("");
  const [address, setAddress] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const accountId = `merchant:${user?.id ?? "unknown"}`;

  const saveStorefront = async () => {
    if (!providerId) return;
    const name = displayName.trim();
    const addr = address.trim();
    if (!name && !addr) {
      setNotice("Enter a display name or address to update.");
      return;
    }
    if (!connected) {
      try {
        const queued = buildMerchantQueuedAction({
          accountId,
          kind: "merchant_update_storefront",
          providerId,
          displayName: name || undefined,
          address: addr || undefined,
        });
        await queueAction(queued);
        setNotice("Offline — storefront update queued; replay from the Queue tab.");
      } catch {
        setNotice("Offline — could not queue the update. Reconnect and retry.");
      }
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const result = await updateStorefront.mutateAsync({
        providerId,
        displayName: name || undefined,
        address: addr || undefined,
        idempotencyKey: newMerchantIdempotencyKey("msp"),
      });
      setNotice(
        result.replayed
          ? "Already applied (idempotent replay)."
          : `Storefront updated — ${result.displayName}.`,
      );
      setDisplayName("");
      setAddress("");
    } catch (error) {
      setNotice(`Update failed (${mapMerchantApiError(error)}).`);
    } finally {
      setSaving(false);
    }
  };

  if (!isAuthenticated) {
    return (
      <ScreenContainer className="px-4 pb-6">
        <View className="pt-10">
          <EmptyState
            title="Sign in as a merchant"
            body="The catalog console requires an authenticated merchant session."
          />
        </View>
      </ScreenContainer>
    );
  }

  const rows = connected ? (live.data ?? []) : replica.rows;
  const loading = connected ? live.isLoading : !replica.loaded;

  return (
    <ScreenContainer className="px-4 pb-6">
      <ScrollView contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}>
        <View>
          <Text className="text-3xl font-bold text-foreground">Catalog</Text>
          <Text className="mt-2 text-sm leading-6 text-muted">
            Your consumer-visible catalog (projected from Medusa). Prices are
            whole-currency text; the replica keeps this readable offline.
          </Text>
        </View>

        {!connected ? (
          <View className="self-start rounded-full bg-background px-3 py-1">
            <Text className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              Offline — synced replica
            </Text>
          </View>
        ) : null}

        {notice ? (
          <View className="rounded-[20px] border border-border bg-background/70 px-4 py-3">
            <Text className="text-sm text-foreground">{notice}</Text>
          </View>
        ) : null}

        <SectionCard
          title={`Items (${rows.length})`}
          subtitle="Projection status is managed in the merchant portal; this view reflects what consumers see."
        >
          {loading ? (
            <LoadingSkeleton rows={4} />
          ) : rows.length === 0 ? (
            <EmptyState
              title="No catalog items"
              body="Publish products in the merchant portal; they project here once mapped."
            />
          ) : (
            <View className="gap-3">
              {rows.map((item) => (
                <View
                  key={item.id}
                  className="flex-row items-start justify-between gap-3 rounded-[20px] border border-border bg-background/70 px-4 py-3"
                >
                  <View className="flex-1">
                    <Text className="text-sm font-semibold text-foreground">
                      {item.itemName}
                    </Text>
                    <Text className="mt-1 text-xs text-muted">SKU {item.sku}</Text>
                  </View>
                  <Text className="text-sm font-semibold text-foreground">
                    {formatMajorAmount(item.priceMajor, item.currency)}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </SectionCard>

        <SectionCard
          title="Storefront profile"
          subtitle="Owner-only display fields (name, address). Status and verification stay platform-owned."
        >
          <View className="gap-3">
            <Field label="Display name" value={displayName} onChangeText={setDisplayName} />
            <Field label="Address" value={address} onChangeText={setAddress} />
          </View>
          {connected ? (
            <Pressable
              onPress={() => void saveStorefront()}
              disabled={saving}
              className="self-start rounded-full bg-primary px-4 py-3"
            >
              <Text className="text-xs font-semibold text-white">
                {saving ? "Saving…" : "Save storefront"}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => void saveStorefront()}
              className="self-start rounded-full bg-background px-4 py-3"
            >
              <Text className="text-xs font-semibold text-foreground">
                Queue update (offline)
              </Text>
            </Pressable>
          )}
        </SectionCard>
      </ScrollView>
    </ScreenContainer>
  );
}

function Field({
  label,
  value,
  onChangeText,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
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
        placeholder={label}
        placeholderTextColor="#6B7F97"
        className="rounded-2xl border border-border bg-background px-4 py-3 text-sm text-foreground"
      />
    </View>
  );
}
