import { ActivityIndicator, Text, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { useNativeOperatorSession } from "@/lib/mobile/operator-session";

export function NativeAdminRouteGuard({
  children,
}: {
  children: React.ReactNode;
}) {
  const { role, isLoading } = useNativeOperatorSession();

  if (isLoading) {
    return (
      <ScreenContainer className="items-center justify-center px-6">
        <ActivityIndicator color="#7DD3FC" />
        <Text className="mt-4 text-sm text-muted">
          Checking operator access…
        </Text>
      </ScreenContainer>
    );
  }

  if (role !== "admin") {
    return (
      <ScreenContainer className="items-center justify-center px-6">
        <View className="max-w-md rounded-[24px] border border-warning/40 bg-warning/10 px-6 py-5">
          <Text className="text-lg font-bold text-foreground">
            Workspace access restricted
          </Text>
          <Text className="mt-3 text-sm leading-6 text-muted">
            This administrator workspace is hidden for the active operator role.
            The service remains responsible for independently authorizing every
            remote operation.
          </Text>
        </View>
      </ScreenContainer>
    );
  }

  return <>{children}</>;
}
