/**
 * Consumer offline outbox bridge (P5-OFFLINE).
 *
 * Bridges the unwired IndexedDB write queue (./offlineSync) to the consumer
 * surfaces: cart edits, checkout drafts and ride-request drafts are enqueued
 * when a mutation fails because the device is offline, a Background Sync
 * registration ('consumer-outbox', handled in public/sw.js) plus the window
 * 'online' event trigger a replay through the real tRPC mutations, and a
 * hook surfaces queued state using the PowerSyncStatus conventions (quiet
 * pills, nothing rendered when unsupported).
 *
 * Ordering + attempts contract is inherited from offlineSync: FIFO by
 * createdAt, first failure bumps `attempts` and stops the pass. This module
 * adds the retry policy on top: exponential backoff between passes
 * (2s → 4s → … capped at 60s) and dead-lettering after MAX_ATTEMPTS so a
 * poisoned draft cannot block the lane forever.
 *
 * Replay safety: checkout drafts carry the SAME per-cart-version
 * idempotency key the online path would have used, so a replayed checkout
 * hits the server's idempotent session replay and can never double-charge.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  CONSUMER_OFFLINE_LANES,
  enqueueConsumerOfflineAction,
  listOfflineActions,
  replayOfflineActions,
  type ConsumerOfflineLane,
  type EnqueueOfflineActionResult,
  type OfflineAction,
} from "./offlineSync";

// Must match public/sw.js.
export const CONSUMER_OUTBOX_SYNC_TAG = "consumer-outbox";
export const CONSUMER_OUTBOX_SYNC_MESSAGE = "CONSUMER_OUTBOX_SYNC";

export const CONSUMER_OUTBOX_MAX_ATTEMPTS = 8;
export const CONSUMER_OUTBOX_BASE_RETRY_MS = 2_000;
export const CONSUMER_OUTBOX_MAX_RETRY_MS = 60_000;

// ---------- drafts ----------

export type ConsumerCheckoutDraft = {
  cartId: string;
  idempotencyKey: string;
  deliveryAddress: string;
  deliveryLat: number;
  deliveryLng: number;
  notes?: string;
};

export type ConsumerCartDraft =
  | { kind: "updateCartItem"; cartId: string; itemId: string; quantity: number }
  | { kind: "removeCartItem"; cartId: string; itemId: string };

export type ConsumerRideDraft = {
  /** Caller-supplied dedupe anchor (e.g. a quote id); defaults to a UUID. */
  clientMutationId?: string;
  payload: Record<string, unknown>;
};

type EnqueueDeps = {
  enqueue?: typeof enqueueConsumerOfflineAction;
};

/**
 * Checkout drafts dedupe on (cartId, idempotencyKey): the key is stable for
 * a cart version, so re-submitting the same cart version while offline
 * collapses to one queued action; an edited cart rotates the key and queues
 * a fresh draft.
 */
export async function enqueueConsumerCheckoutDraft(
  accountId: string,
  draft: ConsumerCheckoutDraft,
  deps?: EnqueueDeps,
): Promise<EnqueueOfflineActionResult> {
  const enqueue = deps?.enqueue ?? enqueueConsumerOfflineAction;
  return enqueue({
    accountId,
    lane: "consumer_checkout",
    type: "checkout",
    payload: draft,
    id: `consumer:checkout:${draft.cartId}:${draft.idempotencyKey}`,
  });
}

/**
 * Cart drafts dedupe on (cartId, itemId) with upsert semantics: the latest
 * stepper position wins over earlier queued edits for the same line.
 */
export async function enqueueConsumerCartDraft(
  accountId: string,
  draft: ConsumerCartDraft,
  deps?: EnqueueDeps,
): Promise<EnqueueOfflineActionResult> {
  const enqueue = deps?.enqueue ?? enqueueConsumerOfflineAction;
  return enqueue(
    {
      accountId,
      lane: "consumer_cart",
      type: draft.kind,
      payload: draft,
      id: `consumer:cart:${draft.cartId}:${draft.itemId}`,
    },
    { mode: "upsert" },
  );
}

export async function enqueueConsumerRideDraft(
  accountId: string,
  draft: ConsumerRideDraft,
  deps?: EnqueueDeps,
): Promise<EnqueueOfflineActionResult> {
  const enqueue = deps?.enqueue ?? enqueueConsumerOfflineAction;
  return enqueue({
    accountId,
    lane: "consumer_ride",
    type: "requestRide",
    payload: draft.payload,
    id: `consumer:ride:${draft.clientMutationId ?? crypto.randomUUID()}`,
  });
}

// ---------- offline-failure classification ----------

/**
 * True when a mutation failure is connectivity, not a server rejection:
 * either the browser reports itself offline (a mutation cannot have reached
 * the server in that state) or the fetch layer failed. Walks the cause
 * chain because TRPCClientError wraps the underlying TypeError.
 */
export function isOfflineMutationError(error: unknown): boolean {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return true;
  }
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const message =
      current instanceof Error
        ? current.message
        : typeof current === "string"
          ? current
          : "";
    if (
      /failed to fetch|network\s?error|load failed|fetch failed|network request failed|err_internet_disconnected/i.test(
        message,
      )
    ) {
      return true;
    }
    current =
      current instanceof Error
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

// ---------- background sync registration ----------

type SyncCapableRegistration = ServiceWorkerRegistration & {
  sync?: { register(tag: string): Promise<void> };
};

/**
 * Register the 'consumer-outbox' Background Sync tag (handled by sw.js,
 * which fans a CONSUMER_OUTBOX_SYNC message out to window clients). Returns
 * false when Background Sync is unsupported — replay then relies on the
 * 'online' event + next page load, so callers never branch on the result.
 */
export async function registerConsumerOutboxSync(
  ready?: () => Promise<ServiceWorkerRegistration>,
): Promise<boolean> {
  if (
    !ready &&
    (typeof navigator === "undefined" || !("serviceWorker" in navigator))
  ) {
    return false;
  }
  try {
    const registration = ready
      ? await ready()
      : await navigator.serviceWorker.ready;
    const sync = (registration as SyncCapableRegistration).sync;
    if (!sync) return false;
    await sync.register(CONSUMER_OUTBOX_SYNC_TAG);
    return true;
  } catch {
    return false;
  }
}

// ---------- replay (backoff + dead-letter over the offlineSync contract) ----------

export type ConsumerOutboxMutations = {
  checkout?: (draft: ConsumerCheckoutDraft) => Promise<unknown>;
  updateCartItem?: (input: {
    cartId: string;
    itemId: string;
    quantity: number;
  }) => Promise<unknown>;
  removeCartItem?: (input: { cartId: string; itemId: string }) => Promise<unknown>;
  requestRide?: (payload: Record<string, unknown>) => Promise<unknown>;
};

export type ConsumerOutboxReplayOutcome = {
  /** Actions actually sent to the server this pass. */
  attempted: number;
  /** Actions the server accepted (removed from the outbox). */
  synced: number;
  /** True when the pass was skipped because backoff is still cooling down. */
  deferred: boolean;
  /** Action ids discarded after exhausting CONSUMER_OUTBOX_MAX_ATTEMPTS. */
  deadLettered: string[];
  /** The action that failed and stopped this pass (FIFO), if any. */
  failedActionId: string | null;
  /** Epoch ms when the next replay pass is allowed, if backing off. */
  nextRetryAt: number | null;
};

export type ConsumerOutboxReplayDeps = {
  now?: () => number;
  replay?: typeof replayOfflineActions;
  list?: typeof listOfflineActions;
};

/** Exponential backoff between passes: 2s, 4s, 8s … capped at 60s. */
export function consumerOutboxBackoffMs(
  attempts: number,
  baseMs = CONSUMER_OUTBOX_BASE_RETRY_MS,
  maxMs = CONSUMER_OUTBOX_MAX_RETRY_MS,
): number {
  if (attempts <= 0) return 0;
  return Math.min(baseMs * 2 ** (attempts - 1), maxMs);
}

let nextReplayNotBefore = 0;

/** Test/escape hatch: clear the module-level backoff schedule. */
export function resetConsumerOutboxBackoff(): void {
  nextReplayNotBefore = 0;
}

function laneHasHandlers(
  lane: ConsumerOfflineLane,
  mutations: ConsumerOutboxMutations,
): boolean {
  if (lane === "consumer_checkout") return typeof mutations.checkout === "function";
  if (lane === "consumer_cart") {
    return (
      typeof mutations.updateCartItem === "function" &&
      typeof mutations.removeCartItem === "function"
    );
  }
  return typeof mutations.requestRide === "function";
}

async function dispatchConsumerAction(
  action: OfflineAction,
  mutations: ConsumerOutboxMutations,
): Promise<void> {
  const payload = (action.payload ?? {}) as Record<string, unknown>;
  if (action.lane === "consumer_checkout" && action.type === "checkout") {
    if (!mutations.checkout) throw new Error("consumer_outbox_no_handler");
    await mutations.checkout(payload as unknown as ConsumerCheckoutDraft);
    return;
  }
  if (action.lane === "consumer_cart" && action.type === "updateCartItem") {
    if (!mutations.updateCartItem) throw new Error("consumer_outbox_no_handler");
    await mutations.updateCartItem({
      cartId: String(payload.cartId),
      itemId: String(payload.itemId),
      quantity: Number(payload.quantity),
    });
    return;
  }
  if (action.lane === "consumer_cart" && action.type === "removeCartItem") {
    if (!mutations.removeCartItem) throw new Error("consumer_outbox_no_handler");
    await mutations.removeCartItem({
      cartId: String(payload.cartId),
      itemId: String(payload.itemId),
    });
    return;
  }
  if (action.lane === "consumer_ride" && action.type === "requestRide") {
    if (!mutations.requestRide) throw new Error("consumer_outbox_no_handler");
    await mutations.requestRide(payload);
    return;
  }
  // Unknown consumer action (e.g. written by a newer build): keep it queued
  // and let the attempts ceiling dead-letter it rather than dropping data.
  throw new Error("consumer_outbox_unknown_action");
}

/**
 * Replay queued consumer actions FIFO via the provided tRPC mutations.
 * Only lanes with a complete handler set are replayed (a checkout page must
 * not burn the attempts of queued cart edits it cannot send). Inherits the
 * offlineSync contract: first failure bumps attempts and stops the pass;
 * this module schedules the next pass with exponential backoff and
 * dead-letters actions that exhaust CONSUMER_OUTBOX_MAX_ATTEMPTS.
 */
export async function replayConsumerOutbox(
  accountId: string,
  mutations: ConsumerOutboxMutations,
  deps?: ConsumerOutboxReplayDeps,
): Promise<ConsumerOutboxReplayOutcome> {
  const now = deps?.now ?? Date.now;
  const replay = deps?.replay ?? replayOfflineActions;
  const lanes = CONSUMER_OFFLINE_LANES.filter((lane) =>
    laneHasHandlers(lane, mutations),
  );
  const outcome: ConsumerOutboxReplayOutcome = {
    attempted: 0,
    synced: 0,
    deferred: false,
    deadLettered: [],
    failedActionId: null,
    nextRetryAt: null,
  };
  if (lanes.length === 0) return outcome;

  const startedAt = now();
  if (startedAt < nextReplayNotBefore) {
    outcome.deferred = true;
    outcome.nextRetryAt = nextReplayNotBefore;
    return outcome;
  }

  await replay(
    accountId,
    async (action) => {
      if (action.attempts >= CONSUMER_OUTBOX_MAX_ATTEMPTS) {
        // Resolving lets replayOfflineActions remove the poisoned action so
        // it stops blocking the lane; surfaced via outcome.deadLettered.
        outcome.deadLettered.push(action.id);
        return;
      }
      outcome.attempted += 1;
      try {
        await dispatchConsumerAction(action, mutations);
        outcome.synced += 1;
      } catch (error) {
        outcome.failedActionId = action.id;
        nextReplayNotBefore =
          now() + consumerOutboxBackoffMs(action.attempts + 1);
        outcome.nextRetryAt = nextReplayNotBefore;
        throw error;
      }
    },
    { lanes },
  );

  if (!outcome.failedActionId) nextReplayNotBefore = 0;
  return outcome;
}

// ---------- auto-sync triggers (SW sync message + online event) ----------

// Opaque so both DOM (number) and Node (Timeout) timer handles fit.
type TimerHandle = unknown;

export type ConsumerOutboxAutoSyncOptions = {
  accountId: string;
  mutations: ConsumerOutboxMutations;
  onOutcome?: (outcome: ConsumerOutboxReplayOutcome) => void;
  deps?: ConsumerOutboxReplayDeps;
  /** Test seams for the listener wiring. */
  addOnlineListener?: (handler: () => void) => () => void;
  addSyncMessageListener?: (handler: () => void) => () => void;
  setTimeoutFn?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
};

/**
 * Subscribe to the two replay triggers — the service worker's
 * CONSUMER_OUTBOX_SYNC message (Background Sync) and the window 'online'
 * event — and replay the outbox on each. When a pass backs off, a timer
 * re-fires the pass at the scheduled time. Returns an unsubscribe function.
 */
export function startConsumerOutboxAutoSync(
  options: ConsumerOutboxAutoSyncOptions,
): () => void {
  const now = options.deps?.now ?? Date.now;
  const setTimeoutFn =
    options.setTimeoutFn ??
    ((fn: () => void, ms: number) => setTimeout(fn, ms) as TimerHandle);
  const clearTimeoutFn =
    options.clearTimeoutFn ??
    ((handle: TimerHandle) =>
      clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  let stopped = false;
  let running = false;
  let retryTimer: TimerHandle | null = null;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const outcome = await replayConsumerOutbox(
        options.accountId,
        options.mutations,
        options.deps,
      );
      options.onOutcome?.(outcome);
      if (!stopped && outcome.nextRetryAt) {
        const delay = Math.max(0, outcome.nextRetryAt - now());
        retryTimer = setTimeoutFn(() => {
          retryTimer = null;
          void run();
        }, delay);
      }
    } finally {
      running = false;
    }
  };

  const trigger = () => void run();

  const removeOnline =
    options.addOnlineListener?.(trigger) ??
    (() => {
      if (typeof window === "undefined") return () => undefined;
      window.addEventListener("online", trigger);
      return () => window.removeEventListener("online", trigger);
    })();

  const removeSyncMessage =
    options.addSyncMessageListener?.(trigger) ??
    (() => {
      if (
        typeof navigator === "undefined" ||
        !("serviceWorker" in navigator)
      ) {
        return () => undefined;
      }
      const onMessage = (event: MessageEvent) => {
        if (
          (event.data as { type?: string } | null)?.type ===
          CONSUMER_OUTBOX_SYNC_MESSAGE
        ) {
          trigger();
        }
      };
      navigator.serviceWorker.addEventListener("message", onMessage);
      return () =>
        navigator.serviceWorker.removeEventListener("message", onMessage);
    })();

  return () => {
    stopped = true;
    if (retryTimer !== null) clearTimeoutFn(retryTimer);
    removeOnline();
    removeSyncMessage();
  };
}

// ---------- queued-state hook (PowerSyncStatus conventions) ----------

export type ConsumerOutboxState = {
  /** False when IndexedDB is unavailable — render nothing, online-only. */
  available: boolean;
  queuedCount: number;
  lastOutcome: ConsumerOutboxReplayOutcome | null;
  refresh: () => Promise<void>;
};

/**
 * Queued-state hook for consumer pages. Like usePowerSyncStatus it stays
 * silent when the substrate is unavailable, and it never throws into render.
 * The `mutations` object may be rebuilt every render — the auto-sync
 * subscription is stable and forwards to the latest handlers.
 */
export function useConsumerOutbox(
  accountId: string | null,
  mutations: ConsumerOutboxMutations,
): ConsumerOutboxState {
  const available = typeof indexedDB !== "undefined";
  const [queuedCount, setQueuedCount] = useState(0);
  const [lastOutcome, setLastOutcome] =
    useState<ConsumerOutboxReplayOutcome | null>(null);
  const mutationsRef = useRef(mutations);
  mutationsRef.current = mutations;

  // Stable identity whose per-key getters forward to the latest handlers.
  // Keys read as undefined while a handler is absent, so replay lane
  // filtering (laneHasHandlers) still reflects what the page can send.
  const stableMutations = useMemo<ConsumerOutboxMutations>(() => {
    const proxy: ConsumerOutboxMutations = {};
    const keys = [
      "checkout",
      "updateCartItem",
      "removeCartItem",
      "requestRide",
    ] as const;
    for (const key of keys) {
      Object.defineProperty(proxy, key, {
        enumerable: true,
        get() {
          const fn = mutationsRef.current[key];
          if (!fn) return undefined;
          return (input: Parameters<NonNullable<(typeof mutationsRef.current)[typeof key]>>[0]) =>
            (fn as (value: unknown) => Promise<unknown>)(input);
        },
      });
    }
    return proxy;
  }, []);

  const refresh = useCallback(async () => {
    if (!accountId || typeof indexedDB === "undefined") {
      setQueuedCount(0);
      return;
    }
    try {
      const actions = await listOfflineActions(accountId);
      setQueuedCount(
        actions.filter((action) =>
          (CONSUMER_OFFLINE_LANES as readonly string[]).includes(action.lane),
        ).length,
      );
    } catch {
      // IndexedDB blocked/corrupt — behave online-only, like PowerSyncStatus.
      setQueuedCount(0);
    }
  }, [accountId]);

  useEffect(() => {
    if (!accountId || !available) return;
    void refresh();
    return startConsumerOutboxAutoSync({
      accountId,
      mutations: stableMutations,
      onOutcome: (outcome) => {
        setLastOutcome(outcome);
        void refresh();
      },
    });
  }, [accountId, available, refresh, stableMutations]);

  return { available, queuedCount, lastOutcome, refresh };
}
