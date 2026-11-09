import * as Linking from "expo-linking";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import { getApiBaseUrl } from "@/constants/oauth";
import { useColors } from "@/hooks/use-colors";
import * as Auth from "@/lib/_core/auth";
import {
  DEFAULT_JOB_COMPLETE_CALLBACK,
  launchOpenRideNavigation,
  parseJobCompleteCallback,
  type OpenRideJobCompletion,
  type OpenRideJobKind,
  type OpenRideJobPayload,
  type OpenRideJobPoint,
} from "@/lib/openride";

/**
 * Job navigation launcher (Contract C1, Phase 1).
 *
 * Opened with the job details as router query params, e.g.:
 *   /job-navigate?jobId=<uuid>&kind=delivery&bundleCity=lagos
 *     &pickupLat=6.5176&pickupLon=3.3787&pickupAddress=University of Lagos
 *     &dropoffLat=6.4281&dropoffLon=3.4219&dropoffAddress=Victoria Island
 *     [&profile=carFast] [&stops=<JSON array of {lat,lon,address}>]
 *
 * Builds the openride.job.v1 payload, hands it to OpenRide via deep link and
 * displays the completion status returned through switchos://job-complete.
 */

type ParsedJobParams =
  | { ok: true; payload: Omit<OpenRideJobPayload, "upload"> }
  | { ok: false; error: string };

function parseCoordinate(
  latRaw: string | undefined,
  lonRaw: string | undefined,
  label: string,
): OpenRideJobPoint | string {
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (
    latRaw === undefined ||
    lonRaw === undefined ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    return `${label} coordinates are missing or invalid`;
  }
  return { lat, lon };
}

function parseStops(raw: string | undefined): OpenRideJobPoint[] | string {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "stops param is not valid JSON";
  }
  if (!Array.isArray(parsed)) return "stops param must be a JSON array";
  const stops: OpenRideJobPoint[] = [];
  for (let i = 0; i < parsed.length; i += 1) {
    const stop = parsed[i] as Partial<OpenRideJobPoint>;
    if (
      typeof stop?.lat !== "number" ||
      typeof stop?.lon !== "number" ||
      !Number.isFinite(stop.lat) ||
      !Number.isFinite(stop.lon)
    ) {
      return `stops[${i}] has invalid coordinates`;
    }
    stops.push({
      lat: stop.lat,
      lon: stop.lon,
      ...(typeof stop.address === "string" ? { address: stop.address } : {}),
    });
  }
  return stops;
}

function useJobParams(): ParsedJobParams {
  const params = useLocalSearchParams<{
    jobId?: string;
    kind?: string;
    profile?: string;
    bundleCity?: string;
    pickupLat?: string;
    pickupLon?: string;
    pickupAddress?: string;
    dropoffLat?: string;
    dropoffLon?: string;
    dropoffAddress?: string;
    stops?: string;
  }>();

  return useMemo<ParsedJobParams>(() => {
    if (!params.jobId) return { ok: false, error: "Missing jobId param" };
    if (params.kind !== "ride" && params.kind !== "delivery") {
      return { ok: false, error: 'kind param must be "ride" or "delivery"' };
    }
    if (!params.bundleCity) return { ok: false, error: "Missing bundleCity param" };

    const pickup = parseCoordinate(params.pickupLat, params.pickupLon, "Pickup");
    if (typeof pickup === "string") return { ok: false, error: pickup };
    const dropoff = parseCoordinate(params.dropoffLat, params.dropoffLon, "Dropoff");
    if (typeof dropoff === "string") return { ok: false, error: dropoff };
    const stops = parseStops(params.stops);
    if (typeof stops === "string") return { ok: false, error: stops };

    if (params.pickupAddress) pickup.address = params.pickupAddress;
    if (params.dropoffAddress) dropoff.address = params.dropoffAddress;

    const kind: OpenRideJobKind = params.kind;
    return {
      ok: true,
      payload: {
        schema: "openride.job.v1",
        jobId: params.jobId,
        kind,
        // Delivery orders default to car routing, rides to the bike profile;
        // the caller can override with an explicit profile param.
        profile: params.profile ?? (kind === "ride" ? "fastbike" : "carFast"),
        pickup,
        dropoff,
        stops,
        bundleCity: params.bundleCity,
        callbackScheme: DEFAULT_JOB_COMPLETE_CALLBACK,
      },
    };
  }, [params]);
}

function formatPoint(point: OpenRideJobPoint): string {
  return point.address ?? `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`;
}

export default function JobNavigateScreen() {
  const colors = useColors();
  const parsed = useJobParams();

  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [openRideMissing, setOpenRideMissing] = useState(false);
  const [completion, setCompletion] = useState<OpenRideJobCompletion | null>(null);

  const jobId = parsed.ok ? parsed.payload.jobId : undefined;

  // Driver session bearer for the C2 upload target (same token the tRPC
  // client sends; stored in expo-secure-store by the auth flow).
  useEffect(() => {
    let mounted = true;
    void Auth.getSessionToken().then((token) => {
      if (!mounted) return;
      setSessionToken(token);
      setSessionLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Listen for the switchos://job-complete return link while this screen is
  // open, and pick up the initial URL in case the OS delivered it cold.
  useEffect(() => {
    const handleUrl = (url: string | null) => {
      if (!url) return;
      const result = parseJobCompleteCallback(url);
      if (result && (!jobId || result.jobId === jobId)) {
        setCompletion(result);
      }
    };
    void Linking.getInitialURL().then(handleUrl);
    const subscription = Linking.addEventListener("url", (event) =>
      handleUrl(event.url),
    );
    return () => subscription.remove();
  }, [jobId]);

  const startNavigation = async () => {
    if (!parsed.ok || !sessionToken) return;
    setLaunching(true);
    setLaunchError(null);
    setOpenRideMissing(false);
    try {
      const payload: OpenRideJobPayload = {
        ...parsed.payload,
        upload: {
          url: `${getApiBaseUrl()}/trpc/openrideTelemetry.ingestTrack`,
          token: sessionToken,
        },
      };
      const result = await launchOpenRideNavigation(payload);
      if (result === "not-installed") {
        setOpenRideMissing(true);
      }
    } catch (error) {
      setLaunchError(
        error instanceof Error ? error.message : "Failed to launch OpenRide",
      );
    } finally {
      setLaunching(false);
    }
  };

  return (
    <ScreenContainer className="px-4">
      <Stack.Screen options={{ title: "Job navigation", headerShown: false }} />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingVertical: 16, gap: 16 }}
      >
        <View>
          <Text className="text-2xl font-bold text-foreground">OpenRide navigation</Text>
          <Text className="mt-1 text-sm leading-5 text-muted">
            Hand this job to OpenRide for offline turn-by-turn navigation. The
            recorded track is uploaded automatically when the job completes.
          </Text>
        </View>

        {!parsed.ok ? (
          <SectionCard title="Cannot start navigation" subtitle={parsed.error}>
            <Text className="text-sm leading-6 text-muted">
              Reopen this screen from the job details so the route parameters are
              passed correctly.
            </Text>
          </SectionCard>
        ) : (
          <>
            <SectionCard
              title={parsed.payload.kind === "ride" ? "Ride job" : "Delivery job"}
              subtitle={`Job ${parsed.payload.jobId}`}
            >
              <View className="gap-2">
                <View>
                  <Text className="text-xs uppercase tracking-wide text-muted">Pickup</Text>
                  <Text className="mt-0.5 text-sm font-semibold text-foreground">
                    {formatPoint(parsed.payload.pickup)}
                  </Text>
                </View>
                {parsed.payload.stops?.map((stop, index) => (
                  <View key={`${stop.lat}-${stop.lon}-${index}`}>
                    <Text className="text-xs uppercase tracking-wide text-muted">
                      Stop {index + 1}
                    </Text>
                    <Text className="mt-0.5 text-sm font-semibold text-foreground">
                      {formatPoint(stop)}
                    </Text>
                  </View>
                ))}
                <View>
                  <Text className="text-xs uppercase tracking-wide text-muted">Dropoff</Text>
                  <Text className="mt-0.5 text-sm font-semibold text-foreground">
                    {formatPoint(parsed.payload.dropoff)}
                  </Text>
                </View>
                <View className="mt-1 flex-row flex-wrap gap-2">
                  <View className="rounded-full bg-background px-3 py-1.5">
                    <Text className="text-[11px] font-semibold text-foreground">
                      Profile: {parsed.payload.profile}
                    </Text>
                  </View>
                  <View className="rounded-full bg-background px-3 py-1.5">
                    <Text className="text-[11px] font-semibold text-foreground">
                      Bundle: {parsed.payload.bundleCity}
                    </Text>
                  </View>
                </View>
              </View>
            </SectionCard>

            {completion ? (
              <View className="rounded-[24px] border border-success/40 bg-success/10 px-4 py-4">
                <Text className="text-xs uppercase tracking-wide text-success">
                  Returned from OpenRide
                </Text>
                <Text className="mt-2 text-base font-semibold text-foreground">
                  Job status: {completion.status}
                </Text>
                <Text className="mt-1 text-sm leading-5 text-muted">
                  The recorded track uploads in the background and is verified
                  against the fare quote on the server.
                </Text>
              </View>
            ) : null}

            {openRideMissing ? (
              <View className="rounded-[24px] border border-warning/40 bg-warning/10 px-4 py-4">
                <Text className="text-xs uppercase tracking-wide text-warning">
                  OpenRide not installed
                </Text>
                <Text className="mt-2 text-sm leading-6 text-foreground">
                  This device cannot open openride:// links. Install the OpenRide
                  driver navigation app, download the "{parsed.payload.bundleCity}"
                  offline bundle, then return here and start navigation again.
                </Text>
              </View>
            ) : null}

            {launchError ? (
              <View className="rounded-[24px] border border-error/40 bg-error/10 px-4 py-4">
                <Text className="text-xs uppercase tracking-wide text-error">
                  Launch failed
                </Text>
                <Text className="mt-2 text-sm leading-6 text-foreground">{launchError}</Text>
              </View>
            ) : null}

            {sessionLoading ? (
              <View className="items-center py-4">
                <ActivityIndicator color={colors.primary} />
              </View>
            ) : !sessionToken ? (
              <View className="rounded-[24px] border border-error/40 bg-error/10 px-4 py-4">
                <Text className="text-xs uppercase tracking-wide text-error">
                  Sign-in required
                </Text>
                <Text className="mt-2 text-sm leading-6 text-foreground">
                  No driver session was found on this device. Sign in again so the
                  recorded track can be uploaded under your account.
                </Text>
              </View>
            ) : (
              <Pressable
                onPress={() => void startNavigation()}
                disabled={launching}
                className="items-center rounded-full bg-primary px-4 py-4"
                style={({ pressed }) => ({ opacity: pressed || launching ? 0.7 : 1 })}
              >
                <Text className="text-sm font-semibold text-white">
                  {launching ? "Opening OpenRide..." : "Start navigation"}
                </Text>
              </Pressable>
            )}
          </>
        )}
      </ScrollView>
    </ScreenContainer>
  );
}
