import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  TextInput,
  View,
} from "react-native";

import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

/**
 * Debounced place search backed by the Contract C3 geocoder proxy
 * (tRPC `openrideGeo.search`, which forwards to the server-hosted OpenRide
 * geocoder service: GET /search?q=&lat=&lon= on a city bundle).
 *
 * Results are ranked server-side; when `lat`/`lon` props are supplied the
 * service also returns `distanceM`, which this field renders.
 */

export type OpenRidePlace = {
  name: string;
  /** Geocoder category, e.g. "address" | "poi" | "street". */
  kind: string;
  lat: number;
  lon: number;
  /** Metres from the supplied reference point; present only when lat/lon were given. */
  distanceM?: number | null;
};

type PlaceSearchFieldProps = {
  /** Reference location for distance display and proximity ranking. */
  lat?: number;
  lon?: number;
  placeholder?: string;
  /** Max results requested from the proxy. Defaults to 8. */
  limit?: number;
  /** Minimum characters before a search fires. Defaults to 2. */
  minChars?: number;
  onSelect: (place: OpenRidePlace) => void;
};

const DEBOUNCE_MS = 300;

function formatDistance(distanceM: number): string {
  if (distanceM < 1000) return `${Math.round(distanceM)} m`;
  return `${(distanceM / 1000).toFixed(1)} km`;
}

export function PlaceSearchField({
  lat,
  lon,
  placeholder = "Search for a place",
  limit = 8,
  minChars = 2,
  onSelect,
}: PlaceSearchFieldProps) {
  const colors = useColors();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  // True right after a selection so the list stays hidden until the driver
  // edits the text again.
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const searchInput = useMemo(
    () => ({
      q: debouncedQuery,
      ...(lat !== undefined && lon !== undefined ? { lat, lon } : {}),
      limit,
    }),
    [debouncedQuery, lat, lon, limit],
  );

  const enabled = debouncedQuery.length >= minChars;
  const search = trpc.openrideGeo.search.useQuery(searchInput, {
    enabled,
    // Place results stay warm briefly so re-focusing the field does not
    // hammer the geocoder proxy.
    staleTime: 30_000,
  });

  const results = useMemo<OpenRidePlace[]>(
    () => (search.data ?? []).slice(0, limit),
    [search.data, limit],
  );
  const showResults = enabled && !dismissed;

  const handleSelect = (place: OpenRidePlace) => {
    setQuery(place.name);
    setDismissed(true);
    onSelect(place);
  };

  return (
    <View className="gap-2">
      <TextInput
        value={query}
        onChangeText={(text) => {
          setQuery(text);
          setDismissed(false);
        }}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        className="rounded-[20px] border border-border bg-background px-4 py-3 text-sm text-foreground"
      />

      {showResults && search.isFetching ? (
        <View className="flex-row items-center gap-2 rounded-[18px] border border-border bg-background/70 px-4 py-3">
          <ActivityIndicator size="small" color={colors.primary} />
          <Text className="text-sm text-muted">Searching places...</Text>
        </View>
      ) : null}

      {showResults && search.isError ? (
        <View className="rounded-[18px] border border-error/40 bg-error/10 px-4 py-3">
          <Text className="text-sm font-semibold text-foreground">
            Place search is unavailable
          </Text>
          <Text className="mt-1 text-sm leading-5 text-muted">
            Check your connection and try again. The geocoder is served from the
            DeliveryPlatform API.
          </Text>
          <Pressable
            onPress={() => void search.refetch()}
            className="mt-3 self-start rounded-full bg-primary px-4 py-2"
          >
            <Text className="text-xs font-semibold text-white">Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {showResults && !search.isFetching && !search.isError && results.length === 0 ? (
        <View className="rounded-[18px] border border-border bg-background/70 px-4 py-3">
          <Text className="text-sm font-semibold text-foreground">No places found</Text>
          <Text className="mt-1 text-sm leading-5 text-muted">
            Try a street name, landmark, or a more specific address.
          </Text>
        </View>
      ) : null}

      {showResults && results.length > 0 ? (
        <FlatList
          data={results}
          keyExtractor={(place, index) =>
            `${place.name}-${place.lat}-${place.lon}-${index}`
          }
          scrollEnabled={false}
          className="rounded-[18px] border border-border bg-surface"
          renderItem={({ item: place }) => (
            <Pressable
              onPress={() => handleSelect(place)}
              className="border-b border-border/60 px-4 py-3 last:border-b-0"
              style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}
            >
              <View className="flex-row items-start justify-between gap-3">
                <View className="flex-1">
                  <Text className="text-sm font-semibold text-foreground">
                    {place.name}
                  </Text>
                  <Text className="mt-0.5 text-xs uppercase tracking-wide text-muted">
                    {place.kind}
                  </Text>
                </View>
                {typeof place.distanceM === "number" ? (
                  <View className="rounded-full bg-background px-3 py-1.5">
                    <Text className="text-[11px] font-semibold text-foreground">
                      {formatDistance(place.distanceM)}
                    </Text>
                  </View>
                ) : null}
              </View>
            </Pressable>
          )}
        />
      ) : null}
    </View>
  );
}
