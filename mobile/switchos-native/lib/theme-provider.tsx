import AsyncStorage from "@react-native-async-storage/async-storage";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Appearance, View, useColorScheme as useSystemColorScheme } from "react-native";
import { colorScheme as nativewindColorScheme, vars } from "nativewind";

import { SchemeColors, type ColorScheme } from "@/constants/theme";
import type { ThemePreference } from "@/lib/mobile/types";

const THEME_PREFERENCE_KEY = "switchos-mobile:theme-preference";

type ThemeContextValue = {
  colorScheme: ColorScheme;
  preference: ThemePreference;
  setColorScheme: (scheme: ColorScheme) => void;
  setThemePreference: (preference: ThemePreference) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function resolveScheme(preference: ThemePreference, systemScheme?: ColorScheme | null): ColorScheme {
  if (preference === "system") {
    return systemScheme ?? "dark";
  }
  return preference;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemScheme = useSystemColorScheme() ?? "dark";
  const [preference, setPreference] = useState<ThemePreference>("system");
  const colorScheme = resolveScheme(preference, systemScheme);

  const applyScheme = useCallback((scheme: ColorScheme) => {
    nativewindColorScheme.set(scheme);
    Appearance.setColorScheme?.(scheme);
    if (typeof document !== "undefined") {
      const root = document.documentElement;
      root.dataset.theme = scheme;
      root.classList.toggle("dark", scheme === "dark");
      const palette = SchemeColors[scheme];
      Object.entries(palette).forEach(([token, value]) => {
        root.style.setProperty(`--color-${token}`, value);
      });
    }
  }, []);

  const setThemePreference = useCallback(async (nextPreference: ThemePreference) => {
    setPreference(nextPreference);
    await AsyncStorage.setItem(THEME_PREFERENCE_KEY, nextPreference);
  }, []);

  const setColorScheme = useCallback(
    (scheme: ColorScheme) => {
      void setThemePreference(scheme);
    },
    [setThemePreference],
  );

  useEffect(() => {
    void AsyncStorage.getItem(THEME_PREFERENCE_KEY).then((stored) => {
      if (stored === "light" || stored === "dark" || stored === "system") {
        setPreference(stored);
      }
    });
  }, []);

  useEffect(() => {
    applyScheme(colorScheme);
  }, [applyScheme, colorScheme]);

  const themeVariables = useMemo(
    () =>
      vars(
        Object.fromEntries(
          Object.entries(SchemeColors[colorScheme]).map(([token, value]) => [`color-${token}`, value]),
        ),
      ),
    [colorScheme],
  );

  const value = useMemo(
    () => ({
      colorScheme,
      preference,
      setColorScheme,
      setThemePreference,
    }),
    [colorScheme, preference, setColorScheme, setThemePreference],
  );

  return (
    <ThemeContext.Provider value={value}>
      <View style={[{ flex: 1 }, themeVariables]}>{children}</View>
    </ThemeContext.Provider>
  );
}

export function useThemeContext(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useThemeContext must be used within ThemeProvider");
  }
  return ctx;
}
