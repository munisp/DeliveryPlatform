import { Tabs } from "expo-router";
import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { HapticTab } from "@/components/haptic-tab";
import { IconSymbol } from "@/components/ui/icon-symbol";
import { useColors } from "@/hooks/use-colors";
import { useNativeOperatorSession } from "@/lib/mobile/operator-session";

export default function TabLayout() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { role, isLoading } = useNativeOperatorSession();
  const isAdministrator = !isLoading && role === "admin";
  const bottomPadding =
    Platform.OS === "web" ? 14 : Math.max(insets.bottom, 10);
  const tabBarHeight = 62 + bottomPadding;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "600",
        },
        tabBarStyle: {
          paddingTop: 10,
          paddingBottom: bottomPadding,
          height: tabBarHeight,
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          borderTopWidth: 1,
        },
        sceneStyle: {
          backgroundColor: colors.background,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color }) => (
            <IconSymbol size={24} name="house.fill" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="logistics"
        options={{
          title: "Logistics",
          tabBarIcon: ({ color }) => (
            <IconSymbol size={24} name="tray.full.fill" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="dispatch"
        options={{
          title: "Dispatch",
          tabBarIcon: ({ color }) => (
            <IconSymbol size={24} name="truck.box.fill" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="safety"
        options={{
          title: "Safety",
          tabBarIcon: ({ color }) => (
            <IconSymbol size={24} name="sos" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="trust"
        options={{
          title: "Trust",
          tabBarIcon: ({ color }) => (
            <IconSymbol size={24} name="checkmark.shield.fill" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="growth"
        options={{
          href: isAdministrator ? undefined : null,
          title: "Growth",
          tabBarIcon: ({ color }) => (
            <IconSymbol size={24} name="storefront.fill" color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="queue"
        options={{
          href: isAdministrator ? undefined : null,
          title: "Queue",
          tabBarIcon: ({ color }) => (
            <IconSymbol size={24} name="arrow.clockwise" color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
