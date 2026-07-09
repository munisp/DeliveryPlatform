import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";

import { useColors } from "@/hooks/use-colors";
import { runSmartSearch } from "@/lib/mobile/api";
import { useMobileApp } from "@/lib/mobile/provider";
import type { SmartSearchResult } from "@/lib/mobile/types";

type SmartSearchPanelProps = {
  domain: "inventory" | "dispatch" | "all";
  region?: string;
  onSelectResult: (result: SmartSearchResult) => void;
};

const suggestionMap = {
  inventory: [
    "Show warehouses at risk of stockout in my region",
    "Which inventory nodes need urgent replenishment?",
    "Find cold-chain issues with low confidence counts",
  ],
  dispatch: [
    "Which dispatch zones need urgent rider rebalancing?",
    "Show watch zones with long wait times",
    "Find pinned zones under pressure",
  ],
  all: [
    "What needs my attention first right now?",
    "Show critical operations in Lagos",
    "Find the highest-risk logistics and dispatch records",
  ],
} as const;

export function SmartSearchPanel({ domain, region, onSelectResult }: SmartSearchPanelProps) {
  const colors = useColors();
  const { snapshot, settings } = useMobileApp();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SmartSearchResult[]>([]);
  const [searchMode, setSearchMode] = useState<"idle" | "live" | "offline">("idle");
  const [isSearching, setIsSearching] = useState(false);
  const [fallbackReason, setFallbackReason] = useState<string | undefined>();

  const suggestions = suggestionMap[domain];
  const scopedResults = useMemo(
    () => results.filter((result) => domain === "all" || result.domain === domain),
    [domain, results],
  );

  const runQuery = async (value?: string) => {
    const nextQuery = (value ?? query).trim();
    if (!nextQuery) {
      setResults([]);
      setSearchMode("idle");
      setFallbackReason(undefined);
      return;
    }

    setIsSearching(true);
    const response = await runSmartSearch(settings, snapshot, nextQuery, region ?? settings.region);
    setResults(response.results);
    setSearchMode(response.mode);
    setFallbackReason(response.fallbackReason);
    setIsSearching(false);
  };

  return (
    <View className="gap-3 rounded-[24px] border border-border bg-surface px-4 py-4">
      <View>
        <Text className="text-base font-semibold text-foreground">AI smart search</Text>
        <Text className="mt-1 text-sm leading-6 text-muted">
          Ask for records in plain language and the app will rank the most relevant live or cached operations for you.
        </Text>
      </View>

      <TextInput
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={() => void runQuery()}
        placeholder={domain === "dispatch" ? "Ask about rider pressure, queues, or wait times" : "Ask about stockouts, replenishment, or risky warehouses"}
        placeholderTextColor={colors.muted}
        className="rounded-[20px] border border-border bg-background px-4 py-3 text-sm text-foreground"
      />

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {suggestions.map((suggestion) => (
          <Pressable
            key={suggestion}
            onPress={() => {
              setQuery(suggestion);
              void runQuery(suggestion);
            }}
            className="rounded-full bg-background px-4 py-2"
          >
            <Text className="text-xs font-semibold text-foreground">{suggestion}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <View className="flex-row flex-wrap gap-3">
        <Pressable onPress={() => void runQuery()} className="rounded-full bg-primary px-4 py-3">
          <Text className="text-xs font-semibold text-white">{isSearching ? "Searching..." : "Run smart search"}</Text>
        </Pressable>
        {searchMode !== "idle" ? (
          <View className={searchMode === "live" ? "rounded-full bg-success px-4 py-3" : "rounded-full bg-warning px-4 py-3"}>
            <Text className="text-xs font-semibold text-white">{searchMode === "live" ? "AI live results" : "Offline semantic fallback"}</Text>
          </View>
        ) : null}
      </View>

      {fallbackReason && searchMode === "offline" ? (
        <View className="rounded-[18px] border border-warning/40 bg-warning/10 px-4 py-3">
          <Text className="text-xs uppercase tracking-wide text-warning">Live AI unavailable</Text>
          <Text className="mt-2 text-sm leading-6 text-muted">{fallbackReason}</Text>
        </View>
      ) : null}

      {scopedResults.length > 0 ? (
        scopedResults.map((result) => (
          <Pressable
            key={`${result.domain}-${result.recordId}`}
            onPress={() => onSelectResult(result)}
            className="rounded-[20px] border border-border bg-background/70 px-4 py-3"
          >
            <View className="flex-row items-start justify-between gap-3">
              <View className="flex-1">
                <Text className="text-xs uppercase tracking-wide text-muted">{result.domain === "inventory" ? "Inventory match" : "Dispatch match"}</Text>
                <Text className="mt-1 text-sm font-semibold text-foreground">{result.title}</Text>
                <Text className="mt-1 text-sm leading-6 text-muted">{result.subtitle}</Text>
              </View>
              <View className="rounded-full bg-surface px-3 py-1.5">
                <Text className="text-[11px] font-semibold text-foreground">{result.score}</Text>
              </View>
            </View>
            <Text className="mt-3 text-sm leading-6 text-foreground">{result.reason}</Text>
            <View className="mt-3 flex-row flex-wrap gap-2">
              {result.explanationChips.map((chip) => (
                <View key={chip} className="rounded-full bg-surface px-3 py-1.5">
                  <Text className="text-[11px] font-semibold text-foreground">{chip}</Text>
                </View>
              ))}
            </View>
          </Pressable>
        ))
      ) : searchMode !== "idle" && !isSearching ? (
        <View className="rounded-[18px] border border-border bg-background/70 px-4 py-3">
          <Text className="text-sm font-semibold text-foreground">No relevant records found</Text>
          <Text className="mt-2 text-sm leading-6 text-muted">Try asking about a region, a risk state, or an operational issue such as stockouts, wait times, or rebalancing.</Text>
        </View>
      ) : null}
    </View>
  );
}
