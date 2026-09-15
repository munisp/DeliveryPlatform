import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";

import { cn } from "@/lib/utils";

/**
 * Shared primitives for the Wave E1 trust/economics screens. They follow the
 * app's existing visual language (rounded surface cards, muted helper text)
 * so the new screens read as native to SwitchOS.
 */

export const trustInputClass =
  "rounded-[20px] border border-border bg-background px-4 py-3 text-sm text-foreground";

export const trustPlaceholderColor = "#6B7F97";

type PillTone = "success" | "warning" | "error" | "info" | "neutral";

const pillToneClasses: Record<PillTone, string> = {
  success: "border-success/40 bg-success/10",
  warning: "border-warning/40 bg-warning/10",
  error: "border-error/40 bg-error/10",
  info: "border-accent2/40 bg-accent2/10",
  neutral: "border-border bg-background/60",
};

const pillTextClasses: Record<PillTone, string> = {
  success: "text-success",
  warning: "text-warning",
  error: "text-error",
  info: "text-accent2",
  neutral: "text-muted",
};

export function StatusPill({
  label,
  tone = "neutral",
}: {
  label: string;
  tone?: PillTone;
}) {
  return (
    <View
      className={cn(
        "self-start rounded-full border px-3 py-1",
        pillToneClasses[tone],
      )}
    >
      <Text className={cn("text-xs font-semibold", pillTextClasses[tone])}>
        {label}
      </Text>
    </View>
  );
}

export function Notice({
  tone = "neutral",
  title,
  body,
}: {
  tone?: PillTone;
  title: string;
  body?: string;
}) {
  return (
    <View
      className={cn("rounded-[20px] border px-4 py-3", pillToneClasses[tone])}
    >
      <Text className={cn("text-sm font-semibold", pillTextClasses[tone])}>
        {title}
      </Text>
      {body ? (
        <Text className="mt-1 text-sm leading-5 text-muted">{body}</Text>
      ) : null}
    </View>
  );
}

export function KeyValueRow({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <View className="flex-row items-center justify-between gap-3 py-1.5">
      <Text className="text-sm text-muted">{label}</Text>
      <Text
        className={cn(
          "shrink text-right text-sm font-medium text-foreground",
          valueClassName,
        )}
      >
        {value}
      </Text>
    </View>
  );
}

/** Header row with a back affordance for the stack-pushed trust screens. */
export function BackHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle?: string;
}) {
  const router = useRouter();
  return (
    <View className="gap-3">
      <Pressable
        onPress={() => router.back()}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        className="self-start rounded-full border border-border bg-surface px-4 py-2"
      >
        <Text className="text-xs font-semibold text-foreground">‹ Back</Text>
      </Pressable>
      <View>
        <Text className="text-2xl font-bold text-foreground">{title}</Text>
        {subtitle ? (
          <Text className="mt-2 text-sm leading-6 text-muted">{subtitle}</Text>
        ) : null}
      </View>
    </View>
  );
}

export function QueryErrorNotice({
  resource,
  message,
  onRetry,
  retrying,
}: {
  resource: string;
  message?: string | null;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  return (
    <View className="gap-3">
      <Notice
        tone="warning"
        title={`Could not load ${resource}`}
        body={message ?? "Check your connection and session, then try again."}
      />
      {onRetry ? (
        <Pressable
          onPress={onRetry}
          disabled={retrying}
          className="self-start rounded-full bg-primary px-4 py-2 disabled:opacity-50"
        >
          <Text className="text-xs font-semibold text-white">
            {retrying ? "Retrying…" : "Retry"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
