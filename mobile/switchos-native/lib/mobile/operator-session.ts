import { useCallback, useEffect, useState } from "react";

import { getMe } from "@/lib/_core/api";

export type NativeOperatorRole = "user" | "admin";

type NativeOperatorSession = {
  role: NativeOperatorRole | null;
  isLoading: boolean;
  refresh: () => Promise<void>;
};

function normalizeRole(value: unknown): NativeOperatorRole {
  return value === "admin" ? "admin" : "user";
}

export function useNativeOperatorSession(): NativeOperatorSession {
  const [role, setRole] = useState<NativeOperatorRole | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    try {
      const user = await getMe();
      setRole(user ? normalizeRole(user.role) : null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { role, isLoading, refresh };
}
