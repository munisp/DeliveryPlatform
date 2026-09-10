import { useCallback, useEffect, useRef, useState } from "react";

export type LiveTrackingDelta = {
  cursor: number;
  orderId: number;
  observedAt: string;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  etaSeconds: number | null;
};

type TrackingSnapshot = {
  cursor: number;
  truncated: boolean;
  deltas: LiveTrackingDelta[];
};

type TrackingDeltaEvent = {
  cursor: number;
  deltas: LiveTrackingDelta[];
};

export type TrackingStreamStatus =
  | "bootstrapping"
  | "live"
  | "reconnecting"
  | "offline"
  | "paused"
  | "unavailable";

export type TrackingFreshness = "unknown" | "fresh" | "aging" | "stale";

export type RoleScopedTrackingState = {
  deltas: LiveTrackingDelta[];
  cursor: number;
  truncated: boolean;
  status: TrackingStreamStatus;
  freshness: TrackingFreshness;
  error: string | null;
  updatedAt: string | null;
  isPaused: boolean;
  pause: () => void;
  resume: () => void;
};

const MAX_RENDERED_POSITIONS = 250;
const MAX_RECONNECT_DELAY_MS = 15_000;
const FRESH_AFTER_MS = 30_000;
const STALE_AFTER_MS = 120_000;

function isValidDelta(value: unknown): value is LiveTrackingDelta {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  const observedAt = new Date(`${candidate.observedAt ?? ""}`);
  return (
    Number.isSafeInteger(candidate.cursor) &&
    Number(candidate.cursor) > 0 &&
    Number.isSafeInteger(candidate.orderId) &&
    Number(candidate.orderId) > 0 &&
    Number.isFinite(candidate.latitude) &&
    Number(candidate.latitude) >= -90 &&
    Number(candidate.latitude) <= 90 &&
    Number.isFinite(candidate.longitude) &&
    Number(candidate.longitude) >= -180 &&
    Number(candidate.longitude) <= 180 &&
    Number.isFinite(observedAt.getTime()) &&
    (candidate.accuracyM === null || Number.isFinite(candidate.accuracyM)) &&
    (candidate.etaSeconds === null || Number.isSafeInteger(candidate.etaSeconds))
  );
}

function parseTrackingPayload(value: unknown): TrackingDeltaEvent | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (!Number.isSafeInteger(candidate.cursor) || Number(candidate.cursor) < 0) return null;
  if (!Array.isArray(candidate.deltas)) return null;
  const deltas = candidate.deltas.filter(isValidDelta);
  return { cursor: Number(candidate.cursor), deltas };
}

function dedupeLatest(deltas: LiveTrackingDelta[]): LiveTrackingDelta[] {
  const latestByOrder = new Map<number, LiveTrackingDelta>();
  for (const delta of deltas) {
    const current = latestByOrder.get(delta.orderId);
    if (!current || delta.cursor > current.cursor) latestByOrder.set(delta.orderId, delta);
  }
  return [...latestByOrder.values()]
    .sort((left, right) => right.cursor - left.cursor)
    .slice(0, MAX_RENDERED_POSITIONS);
}

function applyDeltas(current: LiveTrackingDelta[], next: LiveTrackingDelta[]): LiveTrackingDelta[] {
  return dedupeLatest([...current, ...next]);
}

function freshnessFor(lastEventAt: string | null, now = Date.now()): TrackingFreshness {
  if (!lastEventAt) return "unknown";
  const age = now - new Date(lastEventAt).getTime();
  if (!Number.isFinite(age) || age < 0) return "unknown";
  if (age < FRESH_AFTER_MS) return "fresh";
  if (age < STALE_AFTER_MS) return "aging";
  return "stale";
}

function reconnectDelay(attempt: number) {
  const base = Math.min(1_000 * 2 ** Math.min(attempt - 1, 4), MAX_RECONNECT_DELAY_MS);
  const jitter = Math.floor(base * (0.1 + Math.random() * 0.2));
  return Math.min(base + jitter, MAX_RECONNECT_DELAY_MS);
}

async function fetchSnapshot(scope: string, signal: AbortSignal): Promise<TrackingSnapshot> {
  const response = await fetch(`/api/tracking/live/${encodeURIComponent(scope)}/snapshot`, {
    credentials: "include",
    cache: "no-store",
    signal,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || !Array.isArray(body.deltas)) {
    throw new Error(typeof body?.error === "string" ? body.error : "tracking_snapshot_unavailable");
  }
  const parsed = parseTrackingPayload(body);
  if (!parsed) throw new Error("tracking_snapshot_invalid");
  return {
    cursor: parsed.cursor,
    truncated: body.truncated === true,
    deltas: dedupeLatest(parsed.deltas),
  };
}

export function useRoleScopedTracking(scope: "admin" | "customer" | "merchant" | "driver" | "me") {
  const [paused, setPaused] = useState(false);
  const [online, setOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [state, setState] = useState<Omit<RoleScopedTrackingState, "pause" | "resume">>({
    deltas: [],
    cursor: 0,
    truncated: false,
    status: "bootstrapping",
    freshness: "unknown",
    error: null,
    updatedAt: null,
    isPaused: false,
  });
  const cursorRef = useRef(0);
  const reconnectAttemptRef = useRef(0);

  const pause = useCallback(() => setPaused(true), []);
  const resume = useCallback(() => setPaused(false), []);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setState((current) => ({ ...current, freshness: freshnessFor(current.updatedAt) }));
    }, 10_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    let closed = false;
    let stream: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const abortController = new AbortController();

    const clearRetry = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    };

    const markUpdated = (updatedAt: string, status: TrackingStreamStatus = "live") => {
      setState((current) => ({
        ...current,
        updatedAt,
        freshness: freshnessFor(updatedAt),
        status,
        error: null,
        isPaused: false,
      }));
    };

    const reconnect = (resync: boolean) => {
      if (closed || paused || !online) return;
      stream?.close();
      stream = null;
      clearRetry();
      reconnectAttemptRef.current += 1;
      const delay = reconnectDelay(reconnectAttemptRef.current);
      setState((current) => ({ ...current, status: "reconnecting", isPaused: false }));
      retryTimer = setTimeout(() => {
        if (resync) void bootstrap();
        else openStream();
      }, delay);
    };

    const onDelta = (event: MessageEvent<string>) => {
      let parsed: TrackingDeltaEvent | null = null;
      try {
        parsed = parseTrackingPayload(JSON.parse(event.data));
      } catch {
        return;
      }
      if (!parsed || parsed.cursor < cursorRef.current) return;
      const accepted = parsed.deltas.filter((delta) => delta.cursor > cursorRef.current);
      cursorRef.current = Math.max(cursorRef.current, parsed.cursor);
      if (accepted.length === 0) return;
      const updatedAt = new Date().toISOString();
      setState((current) => ({
        ...current,
        deltas: applyDeltas(current.deltas, accepted),
        cursor: cursorRef.current,
        status: "live",
        freshness: "fresh",
        error: null,
        updatedAt,
        isPaused: false,
      }));
    };

    const openStream = () => {
      if (closed || paused || !online) return;
      clearRetry();
      stream = new EventSource(
        `/api/tracking/live/${encodeURIComponent(scope)}?cursor=${cursorRef.current}`,
        { withCredentials: true },
      );
      stream.addEventListener("ready", () => {
        reconnectAttemptRef.current = 0;
        markUpdated(new Date().toISOString());
      });
      stream.addEventListener("tracking.delta", onDelta as EventListener);
      stream.addEventListener("heartbeat", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent<string>).data) as { cursor?: unknown };
          if (Number.isSafeInteger(payload.cursor) && Number(payload.cursor) >= cursorRef.current) {
            cursorRef.current = Number(payload.cursor);
          }
          markUpdated(new Date().toISOString());
        } catch {
          // Heartbeats are advisory and must not advance the cursor when malformed.
        }
      });
      stream.addEventListener("rotate", () => reconnect(false));
      stream.addEventListener("error", (event) => {
        const payload = event as MessageEvent<string>;
        if (typeof payload.data === "string" && payload.data.length > 0) {
          try {
            const parsed = JSON.parse(payload.data) as { code?: unknown };
            setState((current) => ({
              ...current,
              error: typeof parsed.code === "string" ? parsed.code : "tracking_stream_unavailable",
            }));
          } catch {
            // EventSource network errors do not contain a trustworthy payload.
          }
        }
        reconnect(false);
      });
    };

    const bootstrap = async () => {
      if (closed || paused || !online) return;
      setState((current) => ({ ...current, status: "bootstrapping", error: null, isPaused: false }));
      try {
        const snapshot = await fetchSnapshot(scope, abortController.signal);
        if (closed) return;
        cursorRef.current = snapshot.cursor;
        reconnectAttemptRef.current = 0;
        const updatedAt = new Date().toISOString();
        setState({
          deltas: snapshot.deltas,
          cursor: snapshot.cursor,
          truncated: snapshot.truncated,
          status: "live",
          freshness: "fresh",
          error: null,
          updatedAt,
          isPaused: false,
        });
        openStream();
      } catch (error) {
        if (closed || abortController.signal.aborted) return;
        setState((current) => ({
          ...current,
          status: "unavailable",
          error: error instanceof Error ? error.message : "tracking_snapshot_unavailable",
          isPaused: false,
        }));
        reconnect(true);
      }
    };

    if (paused) {
      setState((current) => ({ ...current, status: "paused", isPaused: true }));
    } else if (!online) {
      setState((current) => ({ ...current, status: "offline", isPaused: false }));
    } else {
      void bootstrap();
    }

    return () => {
      closed = true;
      abortController.abort();
      clearRetry();
      stream?.close();
    };
  }, [online, paused, scope]);

  return { ...state, pause, resume };
}

export const trackingStateForTest = {
  applyDeltas,
  dedupeLatest,
  parseTrackingPayload,
  freshnessFor,
  reconnectDelay,
};
