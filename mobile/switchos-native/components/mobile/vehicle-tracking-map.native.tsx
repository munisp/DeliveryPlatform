import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  Camera,
  type CameraRef,
  Map,
  Marker,
} from "@maplibre/maplibre-react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import {
  calculateVehicleBounds,
  type DurableVehiclePosition,
  vehicleIntegrityTone,
} from "@/lib/mobile/vehicle-tracking";

const defaultMapCenter: [number, number] = [3.3792, 6.5244];
const defaultMapStyle = "https://tiles.openfreemap.org/styles/positron";

type NativeVehicleTrackingMapProps = {
  positions: DurableVehiclePosition[];
  isLoading: boolean;
  error: string | null;
  refreshedAt: string | null;
  onRefresh: () => void;
};

function observedTime(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Date(timestamp).toLocaleTimeString()
    : "Unknown";
}

export default function NativeVehicleTrackingMap({
  positions,
  isLoading,
  error,
  refreshedAt,
  onRefresh,
}: NativeVehicleTrackingMapProps) {
  const cameraRef = useRef<CameraRef>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const [selected, setSelected] = useState<DurableVehiclePosition | null>(null);
  const bounds = useMemo(() => calculateVehicleBounds(positions), [positions]);

  const fitVehicleBounds = useCallback(() => {
    if (!bounds) return;
    cameraRef.current?.fitBounds(bounds, {
      padding: { top: 44, right: 44, bottom: 44, left: 44 },
      duration: 450,
    });
  }, [bounds]);

  useEffect(() => {
    if (!mapFailed) fitVehicleBounds();
  }, [fitVehicleBounds, mapFailed]);

  return (
    <SectionCard
      title="Live automobile monitoring"
      subtitle="Tenant-scoped durable vehicle positions from the authenticated central operations snapshot. No positions are invented when tracking is unavailable."
    >
      <View style={styles.mapFrame} testID="native-vehicle-tracking-map">
        <Map
          mapStyle={defaultMapStyle}
          compass
          attribution
          scaleBar
          preferredFramesPerSecond={30}
          onDidFinishLoadingMap={() => {
            setMapFailed(false);
            fitVehicleBounds();
          }}
          onDidFailLoadingMap={() => setMapFailed(true)}
          style={styles.map}
          testID="native-vehicle-tracking-map-canvas"
        >
          <Camera
            ref={cameraRef}
            initialViewState={{ center: defaultMapCenter, zoom: 11 }}
            minZoom={3}
            maxZoom={18}
          />
          {positions.map((position) => (
            <Marker
              key={position.workOrderId}
              id={position.workOrderId}
              lngLat={[position.longitude, position.latitude]}
              anchor="bottom"
              onPress={() => setSelected(position)}
            >
              <View
                accessibilityLabel={`Open vehicle ${position.externalReference}`}
                style={[
                  styles.marker,
                  {
                    backgroundColor: vehicleIntegrityTone(
                      position.integrityScore,
                    ),
                  },
                ]}
              >
                <Text style={styles.markerLabel}>V</Text>
              </View>
            </Marker>
          ))}
        </Map>
        {isLoading ? (
          <View style={styles.overlay} pointerEvents="none">
            <ActivityIndicator color="#7DD3FC" />
            <Text style={styles.overlayText}>Loading durable positions…</Text>
          </View>
        ) : null}
        {!isLoading && positions.length === 0 ? (
          <View style={styles.overlay} pointerEvents="none">
            <Text style={styles.overlayText}>
              No durable current vehicle positions are available for this
              tenant.
            </Text>
          </View>
        ) : null}
        {mapFailed ? (
          <View style={styles.mapFailure}>
            <Text style={styles.mapFailureText}>
              The base map could not load. Tracking data remains protected and
              available below.
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={onRefresh}
              style={({ pressed }) => [
                styles.retryButton,
                pressed && styles.pressedButton,
              ]}
            >
              <Text style={styles.retryButtonText}>Refresh tracking</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      <View style={styles.statusRow}>
        <Text style={styles.statusText}>
          {refreshedAt
            ? `Updated ${observedTime(refreshedAt)}`
            : "Awaiting first tracking refresh"}
        </Text>
        <Text style={styles.statusText}>{positions.length} visible</Text>
      </View>

      {error ? <Text style={styles.errorText}>{error}</Text> : null}

      {selected ? (
        <View style={styles.detailCard}>
          <View style={styles.detailHeading}>
            <Text style={styles.detailTitle}>{selected.externalReference}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close vehicle details"
              onPress={() => setSelected(null)}
              style={({ pressed }) => [
                styles.closeButton,
                pressed && styles.pressedButton,
              ]}
            >
              <Text style={styles.closeButtonText}>Close</Text>
            </Pressable>
          </View>
          <Text style={styles.detailText}>
            Observed {observedTime(selected.observedAt)} · integrity{" "}
            {selected.integrityScore} · source {selected.source}
          </Text>
          <Text style={styles.detailText}>
            {selected.latitude.toFixed(5)}, {selected.longitude.toFixed(5)} ·{" "}
            {selected.accuracyM === null
              ? "accuracy unavailable"
              : `±${Math.round(selected.accuracyM)} m`}
          </Text>
        </View>
      ) : null}
    </SectionCard>
  );
}

const styles = StyleSheet.create({
  mapFrame: {
    height: 320,
    overflow: "hidden",
    borderRadius: 20,
    backgroundColor: "#08111F",
  },
  map: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 28,
    backgroundColor: "rgba(8, 17, 31, 0.62)",
  },
  overlayText: {
    color: "#D7E3F2",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  mapFailure: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 28,
    backgroundColor: "rgba(69, 26, 3, 0.92)",
  },
  mapFailureText: {
    color: "#FEF3C7",
    fontSize: 14,
    lineHeight: 20,
    textAlign: "center",
  },
  retryButton: {
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: "#0F62FE",
  },
  retryButtonText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
  },
  marker: {
    alignItems: "center",
    justifyContent: "center",
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    borderColor: "#FFFFFF",
  },
  markerLabel: {
    color: "#08111F",
    fontSize: 13,
    fontWeight: "800",
  },
  statusRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 16,
    marginTop: 12,
  },
  statusText: {
    color: "#8BA1B9",
    fontSize: 12,
  },
  errorText: {
    marginTop: 12,
    color: "#FDA4AF",
    fontSize: 13,
    lineHeight: 19,
  },
  detailCard: {
    marginTop: 14,
    borderRadius: 16,
    padding: 14,
    backgroundColor: "#101D30",
  },
  detailHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  detailTitle: {
    flex: 1,
    color: "#F8FAFC",
    fontSize: 15,
    fontWeight: "700",
  },
  detailText: {
    marginTop: 7,
    color: "#B8C7D9",
    fontSize: 13,
    lineHeight: 19,
  },
  closeButton: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#1F334C",
  },
  closeButtonText: {
    color: "#D7E3F2",
    fontSize: 12,
    fontWeight: "700",
  },
  pressedButton: {
    opacity: 0.72,
    transform: [{ scale: 0.97 }],
  },
});
