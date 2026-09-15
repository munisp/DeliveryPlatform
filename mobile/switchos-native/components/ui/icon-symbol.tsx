import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { SymbolWeight } from "expo-symbols";
import { ComponentProps } from "react";
import { OpaqueColorValue, type StyleProp, type TextStyle } from "react-native";

const MAPPING = {
  "house.fill": "home",
  "paperplane.fill": "send",
  "chevron.left.forwardslash.chevron.right": "code",
  "chevron.right": "chevron-right",
  "chart.bar.fill": "bar-chart",
  "truck.box.fill": "local-shipping",
  "storefront.fill": "storefront",
  "tray.full.fill": "inventory-2",
  "bell.fill": "notifications",
  gear: "settings",
  "wifi.slash": "wifi-off",
  "checkmark.circle.fill": "check-circle",
  "exclamationmark.triangle.fill": "warning",
  "arrow.clockwise": "autorenew",
  sos: "sos",
  "checkmark.shield.fill": "verified-user",
  "person.2.fill": "people",
  "doc.text.fill": "description",
  "chart.line.uptrend.xyaxis": "trending-up",
  receipt: "receipt-long",
  "person.badge.shield.checkmark.fill": "how-to-reg",
} as const satisfies Record<
  string,
  ComponentProps<typeof MaterialIcons>["name"]
>;

type IconSymbolName = keyof typeof MAPPING;

export function IconSymbol({
  name,
  size = 24,
  color,
  style,
}: {
  name: IconSymbolName;
  size?: number;
  color: string | OpaqueColorValue;
  style?: StyleProp<TextStyle>;
  weight?: SymbolWeight;
}) {
  return (
    <MaterialIcons
      color={color}
      size={size}
      name={MAPPING[name]}
      style={style}
    />
  );
}
