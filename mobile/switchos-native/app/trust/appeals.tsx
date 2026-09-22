import { memo, useMemo, useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";

import { SectionCard } from "@/components/mobile/operations-ui";
import { ScreenContainer } from "@/components/screen-container";
import {
  BackHeader,
  Notice,
  QueryErrorNotice,
  StatusPill,
  trustInputClass,
  trustPlaceholderColor,
} from "@/components/trust/ui";
import {
  type DeactivationAppealRow,
  type DeactivationCaseRow,
  useFileAppeal,
  useMyDeactivationCase,
  useTrustInvalidation,
} from "@/lib/trustApi";
import { formatDateTime } from "@/lib/money";

/**
 * Deactivation due process (R4). Shows the caller's case with its
 * notice-to-decision timeline and the appeal form. The operator review
 * queue stays in the PWA operator console — this screen is the
 * driver/rider-facing surface.
 */

function noticeCountdown(row: DeactivationCaseRow) {
  if (!row.effective_at) return null;
  const remainingMs = new Date(row.effective_at).getTime() - Date.now();
  if (remainingMs <= 0) return null;
  const days = Math.floor(remainingMs / 86_400_000);
  const hours = Math.floor((remainingMs % 86_400_000) / 3_600_000);
  return `${days}d ${hours}h before deactivation takes effect`;
}

type TimelineStep = { label: string; at: string | Date | null; done: boolean };

function caseTimeline(row: DeactivationCaseRow): TimelineStep[] {
  const status = row.status.toLowerCase();
  const appealed =
    status.includes("appeal") ||
    status.includes("review") ||
    status.includes("reinstated") ||
    status.includes("upheld") ||
    status.includes("decided");
  const decided =
    status.includes("reinstated") ||
    status.includes("upheld") ||
    status.includes("decided");
  return [
    { label: "Notice sent", at: row.notice_sent_at, done: Boolean(row.notice_sent_at) },
    {
      label: "Deactivation effective",
      at: row.effective_at,
      done: decided || status.includes("active") || status.includes("effective"),
    },
    { label: "Appeal filed", at: null, done: appealed },
    { label: "Decision issued", at: null, done: decided },
  ];
}

function appealTone(appeal: DeactivationAppealRow) {
  if (appeal.decision === "upheld") return "error" as const;
  if (appeal.decision) return "success" as const;
  return "info" as const;
}

function AppealForm({ deactivationCase }: { deactivationCase: DeactivationCaseRow }) {
  const fileAppeal = useFileAppeal();
  const invalidation = useTrustInvalidation();
  const [statement, setStatement] = useState("");

  const submit = () => {
    if (!statement.trim()) return;
    fileAppeal.mutate(
      { caseId: deactivationCase.id, statement: statement.trim() },
      {
        onSuccess: () => {
          setStatement("");
          invalidation.deactivation();
        },
      },
    );
  };

  return (
    <View className="gap-3">
      <Text className="text-sm font-semibold text-foreground">
        Appeal statement
      </Text>
      <TextInput
        value={statement}
        onChangeText={setStatement}
        placeholder="State the facts the reviewer must consider — dates, trips, evidence references…"
        placeholderTextColor={trustPlaceholderColor}
        multiline
        className={`${trustInputClass} min-h-[120px]`}
      />
      <Pressable
        onPress={submit}
        disabled={fileAppeal.isPending || !statement.trim()}
        className="self-start rounded-full bg-primary px-4 py-3 disabled:opacity-50"
      >
        <Text className="text-xs font-semibold text-white">
          {fileAppeal.isPending ? "Filing…" : "File appeal"}
        </Text>
      </Pressable>
      {fileAppeal.isError ? (
        <Notice
          tone="error"
          title="Appeal could not be filed"
          body={fileAppeal.error?.message ?? "Try again."}
        />
      ) : null}
      {fileAppeal.isSuccess ? (
        <Notice
          tone="success"
          title="Appeal filed"
          body="A reviewer must decide within the appeal SLA; the decision and rationale will appear below."
        />
      ) : null}
    </View>
  );
}

function MyCaseContent({
  deactivationCase,
}: {
  deactivationCase: DeactivationCaseRow;
}) {
  const countdown = noticeCountdown(deactivationCase);

  return (
    <View className="gap-4">
      <Notice
        tone="warning"
        title={`Deactivation notice — ${deactivationCase.cause_code}`}
        body="Deactivations require 14 days notice except where conduct is egregious. You may appeal with a written statement; the decision and its rationale are recorded here."
      />
      <View className="flex-row flex-wrap gap-2">
        <StatusPill label={deactivationCase.subject_role} tone="neutral" />
        <StatusPill
          label={
            deactivationCase.egregious ? "Egregious — immediate" : "14-day notice"
          }
          tone={deactivationCase.egregious ? "error" : "warning"}
        />
        <StatusPill label={deactivationCase.status} tone="info" />
        {deactivationCase.protected_activity ? (
          <StatusPill label="Protected worker activity flagged" tone="success" />
        ) : null}
        {countdown ? <StatusPill label={countdown} tone="warning" /> : null}
      </View>

      <View className="gap-2">
        <Text className="text-xs font-semibold uppercase tracking-[1px] text-muted">
          Case timeline
        </Text>
        {caseTimeline(deactivationCase).map((step) => (
          <View
            key={step.label}
            className={
              step.done
                ? "rounded-[16px] border border-accent2/40 bg-accent2/10 px-4 py-3"
                : "rounded-[16px] border border-border bg-background/60 px-4 py-3"
            }
          >
            <Text
              className={
                step.done
                  ? "text-sm font-medium text-accent2"
                  : "text-sm font-medium text-muted"
              }
            >
              {step.done ? "✓ " : "○ "}
              {step.label}
            </Text>
            {step.at ? (
              <Text className="mt-1 text-xs text-muted">
                {formatDateTime(step.at)}
              </Text>
            ) : null}
          </View>
        ))}
      </View>

      <AppealForm deactivationCase={deactivationCase} />
    </View>
  );
}

const AppealRow = memo(function AppealRow({
  appeal,
}: {
  appeal: DeactivationAppealRow;
}) {
  return (
    <View className="gap-2 rounded-[16px] border border-border bg-background/60 px-4 py-3">
      <View className="flex-row flex-wrap items-center gap-2">
        <StatusPill
          label={appeal.decision ?? appeal.status}
          tone={appealTone(appeal)}
        />
        <Text className="text-xs text-muted">
          SLA {formatDateTime(appeal.sla_due_at)}
        </Text>
      </View>
      <Text className="text-xs text-muted">
        Filed {formatDateTime(appeal.created_at)}
        {appeal.decided_at
          ? ` · decided ${formatDateTime(appeal.decided_at)}`
          : ""}
      </Text>
      {appeal.rationale ? (
        <Text className="text-sm leading-5 text-foreground">
          Rationale: {appeal.rationale}
        </Text>
      ) : null}
    </View>
  );
});

const appealKeyExtractor = (appeal: DeactivationAppealRow) => appeal.id;

// Stable empty list for the no-case path.
const EMPTY_APPEALS: DeactivationAppealRow[] = [];

const renderAppeal = ({ item }: { item: DeactivationAppealRow }) => (
  <AppealRow appeal={item} />
);

export default function AppealsScreen() {
  const myCase = useMyDeactivationCase();
  const appeals = useMemo(
    () => myCase.data?.appeals ?? [],
    [myCase.data],
  );
  const hasCase = Boolean(myCase.data?.case);

  return (
    <ScreenContainer className="px-4 pb-6">
      <FlatList
        data={hasCase ? appeals : EMPTY_APPEALS}
        keyExtractor={appealKeyExtractor}
        renderItem={renderAppeal}
        windowSize={7}
        maxToRenderPerBatch={8}
        removeClippedSubviews
        contentContainerStyle={{ gap: 16, paddingTop: 20, paddingBottom: 24 }}
        ListHeaderComponent={
          <View className="gap-4">
            <BackHeader
              title="Deactivation appeals"
              subtitle="Advance notice, a stated cause, and a human appeal with a recorded decision — including reinstatement with backpay where the deactivation was unjustified (R4)."
            />
            <SectionCard
              title="My case"
              subtitle="Your deactivation case, its timeline, and the appeal form."
            >
              {myCase.isError ? (
                <QueryErrorNotice
                  resource="your deactivation case"
                  message={myCase.error?.message}
                  onRetry={() => void myCase.refetch()}
                  retrying={myCase.isRefetching}
                />
              ) : myCase.isLoading ? (
                <Text className="text-sm text-muted">Loading your case…</Text>
              ) : !myCase.data?.case ? (
                <Notice
                  tone="success"
                  title="No deactivation case on your account"
                  body="Your account is in good standing. If the platform ever issues a deactivation notice you will see the 14-day timeline, the stated cause, and the appeal form here."
                />
              ) : (
                <MyCaseContent deactivationCase={myCase.data.case} />
              )}
            </SectionCard>
            {hasCase && appeals.length > 0 ? (
              <Text className="text-xs font-semibold uppercase tracking-[1px] text-muted">
                Filed appeals
              </Text>
            ) : null}
          </View>
        }
      />
    </ScreenContainer>
  );
}
