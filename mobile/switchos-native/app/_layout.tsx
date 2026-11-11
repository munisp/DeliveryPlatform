import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect, useState } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useColors } from "@/hooks/use-colors";
import { MobileAppProvider } from "@/lib/mobile/provider";
import { PowerSyncProvider } from "@/lib/powersync/PowerSyncProvider";
import { ThemeProvider, useThemeContext } from "@/lib/theme-provider";
import { createTRPCClient, trpc } from "@/lib/trpc";

function LayoutFrame() {
  const colors = useColors();
  const { colorScheme } = useThemeContext();

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.background);
  }, [colors.background]);

  return (
    <>
      <StatusBar style={colorScheme === "dark" ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="oauth/callback" />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  // Platform trust/economics/safety screens consume the deployed tRPC API
  // through these providers (Wave E1). Clients are created once per app
  // lifetime.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 300_000,
            // RN has no window-focus events; keep explicit parity with web.
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );
  const [trpcClient] = useState(() => createTRPCClient());

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <trpc.Provider client={trpcClient} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <ThemeProvider>
              <MobileAppProvider>
                {/* Offline DATA sync layer (orders/loyalty/support replicas +
                    whitelisted uploads). No-op on web / Expo Go without a dev
                    build — degrades to online-only, never blocks render. The
                    operator ACTION outbox lives separately in
                    lib/mobile/offline-sync-sqlite.ts. */}
                <PowerSyncProvider>
                  <LayoutFrame />
                </PowerSyncProvider>
              </MobileAppProvider>
            </ThemeProvider>
          </QueryClientProvider>
        </trpc.Provider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
