import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";

import { Notice, trustInputClass, trustPlaceholderColor } from "@/components/trust/ui";
import {
  type ManifestPassengerInput,
  useAttachManifest,
  useEconomicsSafetyInvalidation,
} from "@/lib/economicsSafetyApi";

/**
 * "Who's riding?" passenger manifest composer (R2 — every rider on a trip is
 * named, optionally NIN-referenced, before dispatch). Native port of the
 * PWA's client/src/components/PassengerManifestForm.tsx.
 *
 * Privacy note: exactly like the PWA, the NIN is transmitted to the platform
 * API over TLS and immediately reduced to a sha256 digest server-side
 * (safety.attachManifest hashes before anything else; raw NINs never
 * persist). A client-side digest cannot be sent instead because the server
 * schema caps `nin` at 32 characters — see server/_core/safetyRouter.ts.
 */
export function PassengerManifestForm({
  tripId: initialTripId = "",
}: {
  tripId?: string;
}) {
  const [tripId, setTripId] = useState(initialTripId);
  const [passengers, setPassengers] = useState<ManifestPassengerInput[]>([
    { name: "", nin: "" },
  ]);
  const attachManifest = useAttachManifest();
  const invalidation = useEconomicsSafetyInvalidation();

  const updatePassenger = (
    index: number,
    patch: Partial<ManifestPassengerInput>,
  ) =>
    setPassengers((current) =>
      current.map((row, rowIndex) =>
        rowIndex === index ? { ...row, ...patch } : row,
      ),
    );

  const removePassenger = (index: number) =>
    setPassengers((current) =>
      current.length === 1
        ? current
        : current.filter((_, rowIndex) => rowIndex !== index),
    );

  const submit = () => {
    const cleaned = passengers
      .map((row) => ({
        name: row.name.trim(),
        nin: row.nin?.trim() ? row.nin.trim() : undefined,
      }))
      .filter((row) => row.name.length > 0);
    if (!tripId.trim() || cleaned.length === 0) return;
    attachManifest.mutate(
      { tripId: tripId.trim(), passengers: cleaned },
      { onSuccess: () => invalidation.safety() },
    );
  };

  const result = attachManifest.data;

  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold text-foreground">
        Who&apos;s riding?
      </Text>
      <Text className="text-xs leading-5 text-muted">
        Every passenger is named before pickup. Optional NINs are stored only
        as sha256 digests — the raw number never persists.
      </Text>
      <TextInput
        value={tripId}
        onChangeText={setTripId}
        placeholder="Trip ID"
        placeholderTextColor={trustPlaceholderColor}
        className={trustInputClass}
      />
      {passengers.map((row, index) => (
        <View
          key={index}
          className="gap-2 rounded-[20px] border border-border bg-background/60 px-3 py-3"
        >
          <TextInput
            value={row.name}
            onChangeText={(value) => updatePassenger(index, { name: value })}
            placeholder={`Passenger ${index + 1} full name`}
            placeholderTextColor={trustPlaceholderColor}
            className={trustInputClass}
          />
          <View className="flex-row items-center gap-2">
            <TextInput
              value={row.nin ?? ""}
              onChangeText={(value) => updatePassenger(index, { nin: value })}
              placeholder="NIN (optional)"
              placeholderTextColor={trustPlaceholderColor}
              keyboardType="number-pad"
              maxLength={32}
              className={`${trustInputClass} flex-1`}
            />
            <Pressable
              onPress={() => removePassenger(index)}
              disabled={passengers.length === 1}
              accessibilityRole="button"
              accessibilityLabel={`Remove passenger ${index + 1}`}
              className="rounded-full border border-border bg-surface px-3 py-2 disabled:opacity-40"
            >
              <Text className="text-xs font-semibold text-foreground">
                Remove
              </Text>
            </Pressable>
          </View>
        </View>
      ))}
      <View className="flex-row flex-wrap gap-2">
        <Pressable
          onPress={() =>
            setPassengers((current) => [...current, { name: "", nin: "" }])
          }
          className="rounded-full border border-border bg-surface px-4 py-3"
        >
          <Text className="text-xs font-semibold text-foreground">
            + Add passenger
          </Text>
        </Pressable>
        <Pressable
          onPress={submit}
          disabled={
            attachManifest.isPending ||
            !tripId.trim() ||
            passengers.every((row) => !row.name.trim())
          }
          className="rounded-full bg-primary px-4 py-3 disabled:opacity-50"
        >
          <Text className="text-xs font-semibold text-white">
            {attachManifest.isPending ? "Attaching…" : "Attach manifest"}
          </Text>
        </Pressable>
      </View>
      {attachManifest.isError ? (
        <Notice
          tone="error"
          title="Manifest could not be attached"
          body={attachManifest.error?.message ?? "Try again."}
        />
      ) : null}
      {result ? (
        <Notice
          tone={result.manifest_verified ? "success" : "warning"}
          title={
            result.manifest_verified
              ? "Manifest verified"
              : "Manifest attached but not fully verified"
          }
          body={
            result.manifest_verified
              ? "All named riders cleared screening."
              : "The driver will see per-rider verification chips before pickup."
          }
        />
      ) : null}
    </View>
  );
}
