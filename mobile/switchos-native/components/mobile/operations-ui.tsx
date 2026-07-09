import React, { useEffect, useMemo, useRef } from "react";
import {
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type EasingFunction,
} from "react-native";

import { useColors } from "@/hooks/use-colors";
import { mobileHaptics } from "@/lib/mobile/haptics";
import { cn } from "@/lib/utils";
import type { MobileAlert, OutboxItem, RiskLevel, ServiceHealth, SyncStatus } from "@/lib/mobile/types";

type DetailMetric = {
  label: string;
  value: string;
  tone?: "default" | "accent" | "success" | "warning" | "error";
};

type DetailAction = {
  label: string;
  tone?: "primary" | "secondary" | "danger";
  onPress: () => void;
};

function severityClasses(level: RiskLevel) {
  switch (level) {
    case "critical":
      return "bg-error/15 border-error/40 text-error";
    case "watch":
      return "bg-warning/15 border-warning/40 text-warning";
    default:
      return "bg-success/15 border-success/40 text-success";
  }
}

function syncClasses(status: SyncStatus) {
  switch (status) {
    case "failed":
      return "bg-error/15 text-error";
    case "queued":
      return "bg-warning/15 text-warning";
    case "syncing":
      return "bg-primary/15 text-primary";
    case "completed":
      return "bg-success/15 text-success";
    default:
      return "bg-surface text-muted";
  }
}

function metricToneClass(tone: DetailMetric["tone"]) {
  switch (tone) {
    case "accent":
      return "text-accent2";
    case "success":
      return "text-success";
    case "warning":
      return "text-warning";
    case "error":
      return "text-error";
    default:
      return "text-foreground";
  }
}

function actionToneClasses(tone: DetailAction["tone"], colors: ReturnType<typeof useColors>) {
  switch (tone) {
    case "secondary":
      return {
        container: [styles.actionButtonBase, { backgroundColor: colors.background, borderColor: colors.border, borderWidth: 1 }],
        label: [styles.actionButtonLabel, { color: colors.foreground }],
      };
    case "danger":
      return {
        container: [styles.actionButtonBase, { backgroundColor: colors.error }],
        label: [styles.actionButtonLabel, { color: "#ffffff" }],
      };
    default:
      return {
        container: [styles.actionButtonBase, { backgroundColor: colors.primary }],
        label: [styles.actionButtonLabel, { color: "#ffffff" }],
      };
  }
}

function useModalAnimation(visible: boolean) {
  const opacity = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(28)).current;

  useEffect(() => {
    const easing: EasingFunction = (value) => value;
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: visible ? 1 : 0,
        duration: visible ? 180 : 140,
        useNativeDriver: true,
        easing,
      }),
      Animated.timing(translateY, {
        toValue: visible ? 0 : 28,
        duration: visible ? 220 : 140,
        useNativeDriver: true,
        easing,
      }),
    ]).start();
  }, [opacity, translateY, visible]);

  return { opacity, translateY };
}

export function ConnectivityBanner({
  mode,
  reachable,
}: {
  mode: "online" | "limited" | "offline";
  reachable: boolean;
}) {
  const tone = mode === "online" ? "success" : mode === "limited" ? "warning" : "error";
  const label = mode === "online"
    ? "Connected"
    : mode === "limited"
      ? "Intermittent network"
      : "Offline mode";
  const body = reachable
    ? "Operational actions can sync with remote services."
    : "Actions will be stored locally and retried automatically when the network returns.";

  return (
    <View className={cn("rounded-[24px] border px-4 py-3", tone === "success" && "border-success/30 bg-success/10", tone === "warning" && "border-warning/30 bg-warning/10", tone === "error" && "border-error/30 bg-error/10")}>
      <Text className={cn("text-sm font-semibold", tone === "success" && "text-success", tone === "warning" && "text-warning", tone === "error" && "text-error")}>{label}</Text>
      <Text className="mt-1 text-sm leading-5 text-muted">{body}</Text>
    </View>
  );
}

export function SyncStatusBar({
  syncing,
  lastSyncedAt,
  queueCount,
}: {
  syncing: boolean;
  lastSyncedAt?: string;
  queueCount: number;
}) {
  return (
    <View className="flex-row items-center justify-between rounded-[24px] border border-border bg-surface px-4 py-3">
      <View className="flex-1 pr-3">
        <Text className="text-sm font-semibold text-foreground">{syncing ? "Sync in progress" : "Sync state stable"}</Text>
        <Text className="mt-1 text-xs leading-5 text-muted">{lastSyncedAt ? `Last sync ${new Date(lastSyncedAt).toLocaleString()}` : "No successful sync has been recorded yet."}</Text>
      </View>
      <View className="rounded-full bg-primary/10 px-3 py-1.5">
        <Text className="text-xs font-semibold text-primary">{queueCount} queued</Text>
      </View>
    </View>
  );
}

export function RiskBadge({ level }: { level: RiskLevel }) {
  return (
    <View className={cn("rounded-full border px-2.5 py-1", severityClasses(level))}>
      <Text className={cn("text-[11px] font-semibold uppercase tracking-[1px]", severityClasses(level).split(" ").pop())}>{level}</Text>
    </View>
  );
}

export function MetricPill({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <View className="min-w-[112px] flex-1 rounded-[20px] border border-border bg-background/70 px-4 py-3">
      <Text className="text-[11px] uppercase tracking-[1px] text-muted">{label}</Text>
      <Text className="mt-2 text-xl font-semibold text-foreground">{value}</Text>
    </View>
  );
}

export function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <View className="rounded-[28px] border border-border bg-surface px-4 py-4 shadow-sm">
      <Text className="text-lg font-semibold text-foreground">{title}</Text>
      {subtitle ? <Text className="mt-1 text-sm leading-5 text-muted">{subtitle}</Text> : null}
      <View className="mt-4 gap-3">{children}</View>
    </View>
  );
}

export function ServiceHealthCard({ service }: { service: ServiceHealth }) {
  const level: RiskLevel = service.status === "healthy" ? "stable" : service.status === "degraded" ? "watch" : "critical";

  return (
    <View className="rounded-[22px] border border-border bg-background/70 px-4 py-3">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground">{service.label}</Text>
          <Text className="mt-1 text-xs leading-5 text-muted">{service.detail || "Awaiting service telemetry."}</Text>
        </View>
        <RiskBadge level={level} />
      </View>
      <Text className="mt-3 text-xs text-muted">{service.latencyMs ? `${service.latencyMs} ms` : "Latency unavailable"}</Text>
    </View>
  );
}

export function SnapshotCard({
  eyebrow,
  title,
  body,
  accentValue,
  accentLabel,
  risk,
  onPress,
}: {
  eyebrow: string;
  title: string;
  body: string;
  accentValue: string;
  accentLabel: string;
  risk?: RiskLevel;
  onPress?: () => void;
}) {
  const interactiveStyle = useMemo(
    () => ({
      transform: [{ scale: 1 }],
      opacity: 1,
    }),
    [],
  );

  const content = (
    <View className="rounded-[28px] border border-border bg-surface px-4 py-4 shadow-sm">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="text-[11px] font-semibold uppercase tracking-[1.2px] text-accent2">{eyebrow}</Text>
          <Text className="mt-2 text-lg font-semibold leading-6 text-foreground">{title}</Text>
          <Text className="mt-2 text-sm leading-6 text-muted">{body}</Text>
        </View>
        {risk ? <RiskBadge level={risk} /> : null}
      </View>
      <View className="mt-4 rounded-[20px] border border-border bg-background/70 px-4 py-3">
        <Text className="text-[11px] uppercase tracking-[1px] text-muted">{accentLabel}</Text>
        <Text className="mt-2 text-2xl font-semibold text-foreground">{accentValue}</Text>
      </View>
    </View>
  );

  if (!onPress) {
    return content;
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${eyebrow} ${title}`}
      onPress={() => {
        mobileHaptics.selection();
        onPress();
      }}
      style={({ pressed }) => [interactiveStyle, pressed ? styles.pressedCard : null]}
    >
      {content}
    </Pressable>
  );
}

export function ActionCard({
  eyebrow,
  title,
  body,
  cta,
  onPress,
}: {
  eyebrow: string;
  title: string;
  body: string;
  cta: string;
  onPress: () => void;
}) {
  const colors = useColors();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${eyebrow} ${title}`}
      onPress={() => {
        mobileHaptics.tap();
        onPress();
      }}
      style={({ pressed }) => [styles.pressableCard, pressed ? styles.pressedCard : null]}
    >
      <View className="rounded-[28px] border border-border bg-surface px-4 py-4 shadow-sm">
        <Text className="text-[11px] font-semibold uppercase tracking-[1.2px] text-accent2">{eyebrow}</Text>
        <Text className="mt-2 text-lg font-semibold leading-6 text-foreground">{title}</Text>
        <Text className="mt-2 text-sm leading-6 text-muted">{body}</Text>
        <View style={[styles.inlineButton, { backgroundColor: colors.primary }]}> 
          <Text style={styles.inlineButtonLabel}>{cta}</Text>
        </View>
      </View>
    </Pressable>
  );
}

export function DetailSheet({
  visible,
  title,
  subtitle,
  risk,
  stateLabel,
  summary,
  metrics,
  notes,
  actions,
  onClose,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  risk: RiskLevel;
  stateLabel: string;
  summary: string;
  metrics: DetailMetric[];
  notes?: string[];
  actions: DetailAction[];
  onClose: () => void;
}) {
  const colors = useColors();
  const { opacity, translateY } = useModalAnimation(visible);

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose}>
      <View style={styles.modalRoot}>
        <Animated.View style={[styles.backdrop, { opacity }]}>
          <Pressable onPress={onClose} style={StyleSheet.absoluteFillObject} />
        </Animated.View>
        <Animated.View
          style={[
            styles.sheetWrapper,
            {
              transform: [{ translateY }],
              opacity,
            },
          ]}
        >
          <View style={[styles.sheetContainer, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
            <View style={styles.sheetHandle} />
            <View className="flex-row items-start justify-between gap-3">
              <View className="flex-1">
                <Text className="text-2xl font-semibold text-foreground">{title}</Text>
                {subtitle ? <Text className="mt-1 text-sm leading-5 text-muted">{subtitle}</Text> : null}
              </View>
              <RiskBadge level={risk} />
            </View>
            <View className="mt-4 self-start rounded-full bg-primary/10 px-3 py-1.5">
              <Text className="text-xs font-semibold text-primary">{stateLabel}</Text>
            </View>
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.sheetScrollContent}>
              <Text className="text-sm leading-6 text-muted">{summary}</Text>
              <View className="mt-5 flex-row flex-wrap gap-3">
                {metrics.map((metric) => (
                  <View key={metric.label} className="min-w-[140px] flex-1 rounded-[20px] border border-border bg-background/70 px-4 py-3">
                    <Text className="text-[11px] uppercase tracking-[1px] text-muted">{metric.label}</Text>
                    <Text className={cn("mt-2 text-base font-semibold", metricToneClass(metric.tone))}>{metric.value}</Text>
                  </View>
                ))}
              </View>
              {notes?.length ? (
                <View className="mt-5 gap-3 rounded-[20px] border border-border bg-background/50 px-4 py-4">
                  <Text className="text-sm font-semibold text-foreground">Operator notes</Text>
                  {notes.map((note, index) => (
                    <Text key={`${note}-${index}`} className="text-sm leading-6 text-muted">{note}</Text>
                  ))}
                </View>
              ) : null}
            </ScrollView>
            <View className="mt-4 gap-3">
              {actions.map((action) => {
                const toneClasses = actionToneClasses(action.tone, colors);
                return (
                  <Pressable
                    key={action.label}
                    accessibilityRole="button"
                    accessibilityLabel={action.label}
                    onPress={() => {
                      if (action.tone === "danger") {
                        mobileHaptics.warning();
                      } else {
                        mobileHaptics.tap();
                      }
                      action.onPress();
                    }}
                    style={({ pressed }) => [toneClasses.container, pressed ? styles.pressedButton : null]}
                  >
                    <Text style={toneClasses.label}>{action.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

export function ConfirmationModal({
  visible,
  title,
  body,
  confirmLabel,
  cancelLabel,
  destructive,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const colors = useColors();
  const { opacity, translateY } = useModalAnimation(visible);

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onCancel}>
      <View style={styles.modalRoot}>
        <Animated.View style={[styles.backdrop, { opacity }]}>
          <Pressable onPress={onCancel} style={StyleSheet.absoluteFillObject} />
        </Animated.View>
        <Animated.View
          style={[
            styles.confirmationWrapper,
            {
              opacity,
              transform: [{ translateY }],
            },
          ]}
        >
          <View style={[styles.confirmationCard, { backgroundColor: colors.surface, borderColor: colors.border }]}> 
            <Text className="text-xl font-semibold text-foreground">{title}</Text>
            <Text className="mt-3 text-sm leading-6 text-muted">{body}</Text>
            <View className="mt-6 gap-3">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={confirmLabel}
                onPress={() => {
                  destructive ? mobileHaptics.warning() : mobileHaptics.success();
                  onConfirm();
                }}
                style={({ pressed }) => [styles.actionButtonBase, { backgroundColor: destructive ? colors.error : colors.primary }, pressed ? styles.pressedButton : null]}
              >
                <Text style={styles.actionButtonLabel}>{confirmLabel}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={cancelLabel ?? "Cancel"}
                onPress={() => {
                  mobileHaptics.selection();
                  onCancel();
                }}
                style={({ pressed }) => [styles.actionButtonBase, styles.secondaryButton, { backgroundColor: colors.background, borderColor: colors.border }, pressed ? styles.pressedButton : null]}
              >
                <Text style={[styles.actionButtonLabel, { color: colors.foreground }]}>{cancelLabel ?? "Cancel"}</Text>
              </Pressable>
            </View>
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

export function OutboxItemRow({ item }: { item: OutboxItem }) {
  return (
    <View className="rounded-[22px] border border-border bg-background/70 px-4 py-3">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground">{item.payload.title}</Text>
          <Text className="mt-1 text-xs leading-5 text-muted">{item.payload.note || "No operator note attached."}</Text>
        </View>
        <View className={cn("rounded-full px-2.5 py-1", syncClasses(item.status))}>
          <Text className="text-xs font-semibold capitalize">{item.status}</Text>
        </View>
      </View>
      <Text className="mt-3 text-xs text-muted">Queued {new Date(item.createdAt).toLocaleString()}</Text>
      {item.lastAttemptAt ? <Text className="mt-1 text-xs text-muted">Last attempt {new Date(item.lastAttemptAt).toLocaleString()}</Text> : null}
      {item.errorMessage ? <Text className="mt-2 text-xs text-error">{item.errorMessage}</Text> : null}
    </View>
  );
}

export function AlertRow({ alert }: { alert: MobileAlert }) {
  return (
    <View className="rounded-[22px] border border-border bg-background/70 px-4 py-3">
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="text-sm font-semibold text-foreground">{alert.title}</Text>
          <Text className="mt-1 text-xs leading-5 text-muted">{alert.body}</Text>
        </View>
        <RiskBadge level={alert.severity} />
      </View>
      <Text className="mt-3 text-xs text-muted">{alert.source} • {new Date(alert.createdAt).toLocaleString()}</Text>
    </View>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <View className="rounded-[22px] border border-dashed border-border bg-background/40 px-4 py-5">
      <Text className="text-sm font-semibold text-foreground">{title}</Text>
      <Text className="mt-1 text-sm leading-6 text-muted">{body}</Text>
    </View>
  );
}

export function LoadingSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <View className="gap-3 rounded-[22px] border border-border bg-background/40 px-4 py-5">
      {Array.from({ length: rows }).map((_, index) => (
        <View key={index} className="h-5 rounded-full bg-surface" />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  pressableCard: {
    transform: [{ scale: 1 }],
    opacity: 1,
  },
  pressedCard: {
    transform: [{ scale: 0.985 }],
    opacity: 0.94,
  },
  pressedButton: {
    transform: [{ scale: 0.985 }],
    opacity: 0.94,
  },
  inlineButton: {
    alignSelf: "flex-start",
    borderRadius: 999,
    marginTop: 16,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  inlineButtonLabel: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "600",
  },
  modalRoot: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(2, 6, 23, 0.62)",
  },
  sheetWrapper: {
    paddingHorizontal: 12,
    paddingBottom: 12,
  },
  sheetContainer: {
    borderRadius: 32,
    borderWidth: 1,
    maxHeight: "86%",
    paddingHorizontal: 18,
    paddingTop: 12,
    paddingBottom: 18,
  },
  sheetHandle: {
    alignSelf: "center",
    backgroundColor: "rgba(148, 163, 184, 0.45)",
    borderRadius: 999,
    height: 5,
    marginBottom: 16,
    width: 52,
  },
  sheetScrollContent: {
    paddingTop: 14,
    paddingBottom: 4,
  },
  actionButtonBase: {
    alignItems: "center",
    borderRadius: 20,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  actionButtonLabel: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "700",
  },
  confirmationWrapper: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  confirmationCard: {
    borderRadius: 28,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingVertical: 22,
  },
  secondaryButton: {
    borderWidth: 1,
  },
});
