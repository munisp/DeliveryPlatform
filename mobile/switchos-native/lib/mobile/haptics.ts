import { Platform } from "react-native";
import * as Haptics from "expo-haptics";

function canUseHaptics() {
  return Platform.OS !== "web";
}

export const mobileHaptics = {
  tap() {
    if (canUseHaptics()) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  },
  toggle() {
    if (canUseHaptics()) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
  },
  success() {
    if (canUseHaptics()) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }
  },
  warning() {
    if (canUseHaptics()) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    }
  },
  error() {
    if (canUseHaptics()) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  },
  selection() {
    if (canUseHaptics()) {
      void Haptics.selectionAsync();
    }
  },
};
