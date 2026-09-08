import { useQuery } from "@tanstack/react-query";

export type OperatorRole =
  | "viewer"
  | "operator"
  | "ops"
  | "admin"
  | "platform_admin"
  | "super_admin";

export type SessionProfile = {
  id: number;
  name: string;
  role: OperatorRole | null;
  tenantId: string | null;
  scopes: string[];
  mfaAuthenticated: boolean;
  assuranceLevel: string | null;
};

async function fetchSessionProfile(): Promise<SessionProfile | null> {
  const response = await fetch("/api/auth/session-profile", {
    credentials: "include",
    cache: "no-store",
  });

  if (response.status === 401) return null;
  const payload = await response
    .json()
    .catch(() => ({ error: "session_profile_unavailable" }));
  if (!response.ok || !payload?.user || typeof payload.user !== "object") {
    throw new Error(payload?.error ?? "session_profile_unavailable");
  }

  const user = payload.user as Record<string, unknown>;
  const role = typeof user.role === "string" ? user.role.toLowerCase() : null;
  const supportedRoles = new Set<OperatorRole>([
    "viewer",
    "operator",
    "ops",
    "admin",
    "platform_admin",
    "super_admin",
  ]);

  return {
    id: Number(user.id),
    name: typeof user.name === "string" ? user.name : "Operator",
    role: supportedRoles.has(role as OperatorRole)
      ? (role as OperatorRole)
      : null,
    tenantId: typeof user.tenantId === "string" ? user.tenantId : null,
    scopes: Array.isArray(user.scopes)
      ? user.scopes.filter(
          (scope): scope is string => typeof scope === "string",
        )
      : [],
    mfaAuthenticated: Boolean(user.mfaAuthenticated),
    assuranceLevel:
      typeof user.assuranceLevel === "string" ? user.assuranceLevel : null,
  };
}

export function useSessionProfile() {
  return useQuery({
    queryKey: ["session-profile"],
    queryFn: fetchSessionProfile,
    staleTime: 60_000,
    retry: false,
  });
}
