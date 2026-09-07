export type ClientLogContext = Record<string, boolean | number | string | null | undefined>;

const CLIENT_OBSERVABILITY_PATH = "/api/telemetry/client-errors";
const MAX_EVENT_LENGTH = 80;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_CONTEXT_ENTRIES = 12;

function truncate(value: string, maximum: number) {
  return value.length > maximum ? value.slice(0, maximum) : value;
}

function normalizeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: truncate(error.name || "Error", 120),
      message: truncate(error.message || "Unknown client error", MAX_MESSAGE_LENGTH),
    };
  }
  if (typeof error === "string") {
    return { name: "Error", message: truncate(error, MAX_MESSAGE_LENGTH) };
  }
  return { name: "Error", message: "Unknown client error" };
}

function sanitizeContext(context?: ClientLogContext) {
  return Object.fromEntries(
    Object.entries(context ?? {})
      .slice(0, MAX_CONTEXT_ENTRIES)
      .map(([key, value]) => [truncate(key, 80), typeof value === "string" ? truncate(value, 250) : value ?? null]),
  );
}

export function reportClientError(event: string, error: unknown, context?: ClientLogContext) {
  if (typeof window === "undefined") return;
  const normalized = normalizeError(error);
  const payload = JSON.stringify({
    event: truncate(event.replace(/[^a-zA-Z0-9._-]/g, "_"), MAX_EVENT_LENGTH),
    errorName: normalized.name,
    message: normalized.message,
    path: truncate(window.location.pathname, 250),
    context: sanitizeContext(context),
    occurredAt: new Date().toISOString(),
  });

  try {
    const body = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon?.(CLIENT_OBSERVABILITY_PATH, body)) return;
    void fetch(CLIENT_OBSERVABILITY_PATH, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Logging must never interrupt the primary user workflow.
  }
}
