import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";

/**
 * Return-link target for OpenRide (Contract C1 callbackScheme):
 *   switchos://job-complete?jobId=<uuid>&status=<status>
 *
 * expo-router auto-registers this route and maps the deep-link host
 * "job-complete" onto it, so a cold start of the app lands here instead of
 * the unmatched-route screen. When the app is already running with
 * app/job-navigate.tsx open, that screen's Linking listener also observes the
 * same URL; this route is the reliable cold-start path.
 */
export default function JobCompleteScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ jobId?: string; status?: string }>();

  useEffect(() => {
    // No side effects required here: the C2 track summary is uploaded by
    // OpenRide directly to openrideTelemetry.ingestTrack and verified on the
    // server. This screen only surfaces the returned status to the driver.
  }, []);

  const valid = Boolean(params.jobId && params.status);

  return (
    <ScreenContainer className="px-4">
      <View className="flex-1 justify-center gap-4">
        <View className="rounded-[28px] border border-border bg-surface px-4 py-4">
          <Text className="text-xs uppercase tracking-wide text-muted">
            Returned from OpenRide
          </Text>
          {valid ? (
            <>
              <Text className="mt-2 text-lg font-semibold text-foreground">
                Job status: {params.status}
              </Text>
              <Text className="mt-1 text-sm leading-5 text-muted">
                Job {params.jobId}
              </Text>
              <Text className="mt-3 text-sm leading-5 text-muted">
                The recorded track uploads in the background and is verified
                against the fare quote on the server.
              </Text>
            </>
          ) : (
            <Text className="mt-2 text-sm leading-6 text-foreground">
              The return link from OpenRide was missing its job details. The
              track upload still completes in the background.
            </Text>
          )}
        </View>
        <Pressable
          onPress={() => router.replace("/(tabs)")}
          className="items-center rounded-full bg-primary px-4 py-4"
          style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
        >
          <Text className="text-sm font-semibold text-white">Back to dashboard</Text>
        </Pressable>
      </View>
    </ScreenContainer>
  );
}
