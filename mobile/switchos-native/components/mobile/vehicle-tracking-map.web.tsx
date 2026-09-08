import { Pressable, StyleSheet, Text, View } from "react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import type { DurableVehiclePosition } from "@/lib/mobile/vehicle-tracking";

type NativeVehicleTrackingMapProps = {
  positions: DurableVehiclePosition[];
  isLoading: boolean;
  error: string | null;
  refreshedAt: string | null;
  onRefresh: () => void;
};

export default function NativeVehicleTrackingMap({
  positions,
  isLoading,
  error,
  refreshedAt,
  onRefresh,
}: NativeVehicleTrackingMapProps) {
  return (
    <SectionCard
      title="Live automobile monitoring"
      subtitle="Native map rendering is available in an Android or iOS development build. This browser preview does not substitute synthetic vehicles or coordinates."
    >
      <View style={styles.panel} testID="native-vehicle-tracking-web-fallback">
        <Text style={styles.title}>Native map required</Text>
        <Text style={styles.body}>
          Build the mobile app with the MapLibre native module to render the
          durable vehicle map. The central PWA provides browser mapping.
        </Text>
        <Text style={styles.status}>
          {isLoading
            ? "Loading durable positions…"
            : `${positions.length} durable positions available${
                refreshedAt
                  ? ` · updated ${new Date(refreshedAt).toLocaleTimeString()}`
                  : ""
              }`}
        </Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable
          accessibilityRole="button"
          onPress={onRefresh}
          style={({ pressed }) => [
            styles.button,
            pressed && styles.pressedButton,
          ]}
        >
          <Text style={styles.buttonText}>Refresh tracking</Text>
        </Pressable>
      </View>
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: 10,
    borderRadius: 20,
    padding: 18,
    backgroundColor: "#101D30",
  },
  title: {
    color: "#F8FAFC",
    fontSize: 16,
    fontWeight: "700",
  },
  body: {
    color: "#B8C7D9",
    fontSize: 13,
    lineHeight: 19,
  },
  status: {
    color: "#7DD3FC",
    fontSize: 13,
    lineHeight: 19,
  },
  error: {
    color: "#FDA4AF",
    fontSize: 13,
    lineHeight: 19,
  },
  button: {
    alignSelf: "flex-start",
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#0F62FE",
  },
  buttonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
  },
  pressedButton: {
    opacity: 0.72,
    transform: [{ scale: 0.97 }],
  },
});
