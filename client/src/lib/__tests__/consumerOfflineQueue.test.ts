/**
 * P5-OFFLINE consumer outbox tests.
 *
 * The IndexedDB substrate (../offlineSync) is substituted with an in-memory
 * fake that mirrors its contract exactly (add = ConstraintError duplicate,
 * FIFO replay, attempts bump + stop on first failure, lane filter) so the
 * bridge logic — enqueue dedupe, replay ordering, backoff, dead-lettering —
 * is tested hermetically in node. The sw.js tests load the real service
 * worker source into a sandboxed harness (fake self/caches/fetch) and
 * exercise the actual fetch handler, including the auth-no-store guard.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OfflineAction } from "../offlineSync";
import {
  CONSUMER_OUTBOX_BASE_RETRY_MS,
  CONSUMER_OUTBOX_MAX_ATTEMPTS,
  CONSUMER_OUTBOX_MAX_RETRY_MS,
  CONSUMER_OUTBOX_SYNC_MESSAGE,
  CONSUMER_OUTBOX_SYNC_TAG,
  consumerOutboxBackoffMs,
  enqueueConsumerCartDraft,
  enqueueConsumerCheckoutDraft,
  enqueueConsumerRideDraft,
  isOfflineMutationError,
  registerConsumerOutboxSync,
  replayConsumerOutbox,
  resetConsumerOutboxBackoff,
  startConsumerOutboxAutoSync,
  type ConsumerOutboxMutations,
} from "../consumerOfflineQueue";

// ---------- in-memory offlineSync contract fake ----------

function createFakeOfflineStore() {
  const actions: OfflineAction[] = [];

  const enqueue = async (
    input: {
      accountId: string;
      lane: OfflineAction["lane"];
      type: string;
      payload: unknown;
      id?: string;
    },
    options?: { mode?: "add" | "upsert" },
  ): Promise<"enqueued" | "duplicate"> => {
    const id = input.id ?? crypto.randomUUID();
    const existing = actions.findIndex((action) => action.id === id);
    const action: OfflineAction = {
      id,
      accountId: input.accountId,
      lane: input.lane,
      type: input.type,
      payload: input.payload,
      createdAt: new Date().toISOString(),
      attempts: existing >= 0 ? actions[existing].attempts : 0,
    };
    if (existing >= 0) {
      if (options?.mode === "upsert") {
        actions[existing] = action;
        return "enqueued";
      }
      return "duplicate";
    }
    actions.push(action);
    return "enqueued";
  };

  const list = async (accountId: string) =>
    actions
      .filter((action) => action.accountId === accountId)
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt));

  const replay = async (
    accountId: string,
    send: (action: OfflineAction) => Promise<void>,
    options?: { lanes?: readonly string[] },
  ) => {
    const rows = actions
      .filter(
        (action) =>
          action.accountId === accountId &&
          (!options?.lanes || options.lanes.includes(action.lane)),
      )
      .sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    for (const action of rows) {
      try {
        await send(action);
        actions.splice(actions.indexOf(action), 1);
      } catch {
        action.attempts += 1;
        break;
      }
    }
  };

  return { actions, enqueue, list, replay };
}

const ACCOUNT = "consumer-1";

function checkoutDraft(idempotencyKey = "checkout-cart-1-v1-uuid") {
  return {
    cartId: "cart-1",
    idempotencyKey,
    deliveryAddress: "12 Admiralty Way, Lekki",
    deliveryLat: 6.4474,
    deliveryLng: 3.4723,
    notes: undefined,
  };
}

beforeEach(() => resetConsumerOutboxBackoff());
afterEach(() => resetConsumerOutboxBackoff());

// ---------- enqueue ----------

describe("enqueue", () => {
  it("enqueues a checkout draft on the consumer_checkout lane with a deterministic id", async () => {
    const store = createFakeOfflineStore();
    const result = await enqueueConsumerCheckoutDraft(
      ACCOUNT,
      checkoutDraft(),
      { enqueue: store.enqueue },
    );
    expect(result).toBe("enqueued");
    expect(store.actions).toHaveLength(1);
    const action = store.actions[0];
    expect(action.lane).toBe("consumer_checkout");
    expect(action.type).toBe("checkout");
    expect(action.id).toBe(
      "consumer:checkout:cart-1:checkout-cart-1-v1-uuid",
    );
    expect(action.attempts).toBe(0);
    expect((action.payload as { deliveryLat: number }).deliveryLat).toBe(
      6.4474,
    );
  });

  it("suppresses duplicate checkout drafts for the same cart version", async () => {
    const store = createFakeOfflineStore();
    const first = await enqueueConsumerCheckoutDraft(
      ACCOUNT,
      checkoutDraft(),
      { enqueue: store.enqueue },
    );
    const second = await enqueueConsumerCheckoutDraft(
      ACCOUNT,
      checkoutDraft(),
      { enqueue: store.enqueue },
    );
    expect(first).toBe("enqueued");
    expect(second).toBe("duplicate");
    expect(store.actions).toHaveLength(1);
  });

  it("coalesces cart stepper edits so the latest quantity wins", async () => {
    const store = createFakeOfflineStore();
    await enqueueConsumerCartDraft(
      ACCOUNT,
      { kind: "updateCartItem", cartId: "cart-1", itemId: "item-1", quantity: 2 },
      { enqueue: store.enqueue },
    );
    const result = await enqueueConsumerCartDraft(
      ACCOUNT,
      { kind: "updateCartItem", cartId: "cart-1", itemId: "item-1", quantity: 5 },
      { enqueue: store.enqueue },
    );
    expect(result).toBe("enqueued");
    expect(store.actions).toHaveLength(1);
    expect(
      (store.actions[0].payload as { quantity: number }).quantity,
    ).toBe(5);
  });

  it("dedupes ride drafts on the caller-supplied clientMutationId", async () => {
    const store = createFakeOfflineStore();
    const draft = {
      clientMutationId: "quote-9",
      payload: { pickupLat: 6.5, dropoffLat: 6.6 },
    };
    await enqueueConsumerRideDraft(ACCOUNT, draft, {
      enqueue: store.enqueue,
    });
    const second = await enqueueConsumerRideDraft(ACCOUNT, draft, {
      enqueue: store.enqueue,
    });
    expect(second).toBe("duplicate");
    expect(store.actions).toHaveLength(1);
    expect(store.actions[0].lane).toBe("consumer_ride");
  });
});

// ---------- replay ordering / backoff / dead-letter ----------

describe("replay", () => {
  it("replays queued actions FIFO and drains the outbox on success", async () => {
    const store = createFakeOfflineStore();
    await enqueueConsumerCartDraft(
      ACCOUNT,
      { kind: "updateCartItem", cartId: "c", itemId: "i1", quantity: 1 },
      { enqueue: store.enqueue },
    );
    await enqueueConsumerCartDraft(
      ACCOUNT,
      { kind: "updateCartItem", cartId: "c", itemId: "i2", quantity: 2 },
      { enqueue: store.enqueue },
    );
    await enqueueConsumerCheckoutDraft(ACCOUNT, checkoutDraft(), {
      enqueue: store.enqueue,
    });

    const sent: string[] = [];
    const mutations: ConsumerOutboxMutations = {
      checkout: async () => {
        sent.push("checkout");
      },
      updateCartItem: async (input) => {
        sent.push(`update:${input.itemId}`);
      },
      removeCartItem: async (input) => {
        sent.push(`remove:${input.itemId}`);
      },
    };
    const outcome = await replayConsumerOutbox(ACCOUNT, mutations, {
      replay: store.replay,
      list: store.list,
    });
    expect(sent).toEqual(["update:i1", "update:i2", "checkout"]);
    expect(outcome).toMatchObject({
      attempted: 3,
      synced: 3,
      deferred: false,
      failedActionId: null,
    });
    expect(store.actions).toHaveLength(0);
  });

  it("stops at the first failure, bumps its attempts and preserves the rest", async () => {
    const store = createFakeOfflineStore();
    await enqueueConsumerCartDraft(
      ACCOUNT,
      { kind: "updateCartItem", cartId: "c", itemId: "i1", quantity: 1 },
      { enqueue: store.enqueue },
    );
    await enqueueConsumerCartDraft(
      ACCOUNT,
      { kind: "updateCartItem", cartId: "c", itemId: "i2", quantity: 2 },
      { enqueue: store.enqueue },
    );

    let now = 1_000_000;
    const mutations: ConsumerOutboxMutations = {
      updateCartItem: async (input) => {
        if (input.itemId === "i1") throw new Error("network down");
      },
      removeCartItem: async () => undefined,
    };
    const outcome = await replayConsumerOutbox(ACCOUNT, mutations, {
      replay: store.replay,
      list: store.list,
      now: () => now,
    });
    expect(outcome.failedActionId).toBe(store.actions[0].id);
    expect(outcome.synced).toBe(0);
    expect(store.actions).toHaveLength(2);
    expect(store.actions[0].attempts).toBe(1);
    expect(store.actions[1].attempts).toBe(0);
    expect(outcome.nextRetryAt).toBe(now + CONSUMER_OUTBOX_BASE_RETRY_MS);
  });

  it("backs off exponentially between passes and defers early replays", async () => {
    const store = createFakeOfflineStore();
    await enqueueConsumerCheckoutDraft(ACCOUNT, checkoutDraft(), {
      enqueue: store.enqueue,
    });
    let now = 0;
    let calls = 0;
    const mutations: ConsumerOutboxMutations = {
      checkout: async () => {
        calls += 1;
        throw new Error("still offline");
      },
    };
    const deps = { replay: store.replay, list: store.list, now: () => now };

    const first = await replayConsumerOutbox(ACCOUNT, mutations, deps);
    expect(first.nextRetryAt).toBe(CONSUMER_OUTBOX_BASE_RETRY_MS); // 2s after attempt #1

    // Early replay during the backoff window is deferred — no server call.
    now = CONSUMER_OUTBOX_BASE_RETRY_MS - 1;
    const deferred = await replayConsumerOutbox(ACCOUNT, mutations, deps);
    expect(deferred.deferred).toBe(true);
    expect(calls).toBe(1);

    // After the window the pass runs and the next backoff doubles.
    now = CONSUMER_OUTBOX_BASE_RETRY_MS;
    const second = await replayConsumerOutbox(ACCOUNT, mutations, deps);
    expect(second.deferred).toBe(false);
    expect(calls).toBe(2);
    expect(second.nextRetryAt).toBe(now + CONSUMER_OUTBOX_BASE_RETRY_MS * 2);
    expect(store.actions[0].attempts).toBe(2);
  });

  it("caps the backoff at the maximum", () => {
    expect(consumerOutboxBackoffMs(1)).toBe(2_000);
    expect(consumerOutboxBackoffMs(2)).toBe(4_000);
    expect(consumerOutboxBackoffMs(3)).toBe(8_000);
    expect(consumerOutboxBackoffMs(30)).toBe(CONSUMER_OUTBOX_MAX_RETRY_MS);
    expect(consumerOutboxBackoffMs(0)).toBe(0);
  });

  it("dead-letters actions that exhaust the attempts ceiling without sending them", async () => {
    const store = createFakeOfflineStore();
    await enqueueConsumerCheckoutDraft(ACCOUNT, checkoutDraft(), {
      enqueue: store.enqueue,
    });
    await enqueueConsumerCartDraft(
      ACCOUNT,
      { kind: "updateCartItem", cartId: "c", itemId: "i1", quantity: 3 },
      { enqueue: store.enqueue },
    );
    store.actions[0].attempts = CONSUMER_OUTBOX_MAX_ATTEMPTS;

    let checkoutCalls = 0;
    const sent: string[] = [];
    const mutations: ConsumerOutboxMutations = {
      checkout: async () => {
        checkoutCalls += 1;
      },
      updateCartItem: async (input) => {
        sent.push(input.itemId);
      },
      removeCartItem: async () => undefined,
    };
    const outcome = await replayConsumerOutbox(ACCOUNT, mutations, {
      replay: store.replay,
      list: store.list,
    });
    expect(checkoutCalls).toBe(0);
    expect(outcome.deadLettered).toEqual([
      "consumer:checkout:cart-1:checkout-cart-1-v1-uuid",
    ]);
    // The poisoned draft is removed and no longer blocks later actions.
    expect(sent).toEqual(["i1"]);
    expect(store.actions).toHaveLength(0);
  });

  it("only replays lanes with a complete handler set, leaving other actions untouched", async () => {
    const store = createFakeOfflineStore();
    await enqueueConsumerCartDraft(
      ACCOUNT,
      { kind: "updateCartItem", cartId: "c", itemId: "i1", quantity: 1 },
      { enqueue: store.enqueue },
    );
    await enqueueConsumerRideDraft(
      ACCOUNT,
      { clientMutationId: "q1", payload: { a: 1 } },
      { enqueue: store.enqueue },
    );

    let rideCalls = 0;
    // Only ride handler provided — the cart lane must not be touched.
    const outcome = await replayConsumerOutbox(
      ACCOUNT,
      {
        requestRide: async () => {
          rideCalls += 1;
        },
      },
      { replay: store.replay, list: store.list },
    );
    expect(rideCalls).toBe(1);
    expect(outcome.synced).toBe(1);
    expect(store.actions).toHaveLength(1);
    expect(store.actions[0].lane).toBe("consumer_cart");
    expect(store.actions[0].attempts).toBe(0);
  });
});

// ---------- offline-failure classification + sync registration ----------

describe("isOfflineMutationError", () => {
  it("classifies fetch-layer failures (incl. wrapped causes) as offline", () => {
    expect(isOfflineMutationError(new TypeError("Failed to fetch"))).toBe(true);
    const wrapped = new Error("TRPCClientError: fetch failed", {
      cause: new TypeError("NetworkError when attempting to fetch resource."),
    });
    expect(isOfflineMutationError(wrapped)).toBe(true);
  });

  it("does not classify server rejections as offline", () => {
    expect(isOfflineMutationError(new Error("cart_version_conflict"))).toBe(
      false,
    );
    expect(isOfflineMutationError(new Error("UNAUTHORIZED"))).toBe(false);
  });
});

describe("registerConsumerOutboxSync", () => {
  it("registers the consumer-outbox tag when Background Sync is supported", async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const ok = await registerConsumerOutboxSync(async () => {
      return { sync: { register } } as unknown as ServiceWorkerRegistration;
    });
    expect(ok).toBe(true);
    expect(register).toHaveBeenCalledWith(CONSUMER_OUTBOX_SYNC_TAG);
  });

  it("returns false when SyncManager is unavailable", async () => {
    const ok = await registerConsumerOutboxSync(
      async () => ({}) as ServiceWorkerRegistration,
    );
    expect(ok).toBe(false);
  });
});

// ---------- auto-sync triggers ----------

describe("startConsumerOutboxAutoSync", () => {
  it("replays on the SW sync message and on 'online', and unsubscribes cleanly", async () => {
    const store = createFakeOfflineStore();
    await enqueueConsumerCheckoutDraft(ACCOUNT, checkoutDraft(), {
      enqueue: store.enqueue,
    });

    const onlineHandlers: Array<() => void> = [];
    const syncHandlers: Array<() => void> = [];
    let calls = 0;
    const stop = startConsumerOutboxAutoSync({
      accountId: ACCOUNT,
      mutations: {
        checkout: async () => {
          calls += 1;
        },
      },
      deps: { replay: store.replay, list: store.list },
      addOnlineListener: (handler) => {
        onlineHandlers.push(handler);
        return () => onlineHandlers.splice(onlineHandlers.indexOf(handler), 1);
      },
      addSyncMessageListener: (handler) => {
        syncHandlers.push(handler);
        return () => syncHandlers.splice(syncHandlers.indexOf(handler), 1);
      },
    });

    syncHandlers[0]();
    await vi.waitFor(() => {
      expect(calls).toBe(1);
      expect(store.actions).toHaveLength(0);
    });

    await enqueueConsumerCheckoutDraft(
      ACCOUNT,
      checkoutDraft("checkout-cart-1-v2-uuid"),
      { enqueue: store.enqueue },
    );
    onlineHandlers[0]();
    await vi.waitFor(() => {
      expect(calls).toBe(2);
      expect(store.actions).toHaveLength(0);
    });

    stop();
    expect(onlineHandlers).toHaveLength(0);
    expect(syncHandlers).toHaveLength(0);
  });
});

// ---------- public/sw.js fetch-handler guards (sandboxed real source) ----------

const SW_SOURCE = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../public/sw.js",
  ),
  "utf8",
);

type SwRequestEvent = {
  request: Request;
  respondWith: (response: Promise<Response> | Response) => void;
  waitUntil: (promise: Promise<unknown>) => void;
};

function createFakeCacheStorage() {
  const stores = new Map<string, Map<string, Response>>();
  const openStore = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      match: async (request: Request | string) =>
        store.get(typeof request === "string" ? request : request.url),
      put: async (request: Request | string, response: Response) => {
        store.set(typeof request === "string" ? request : request.url, response);
      },
      addAll: async () => undefined,
    };
  };
  return {
    stores,
    open: async (name: string) => openStore(name),
    match: async (request: Request | string) => {
      const url = typeof request === "string" ? request : request.url;
      for (const store of stores.values()) {
        const hit = store.get(url);
        if (hit) return hit;
      }
      return undefined;
    },
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
  };
}

function loadServiceWorker(options: {
  fetchImpl: (input: Request) => Promise<Response>;
}) {
  const listeners = new Map<string, Array<(event: never) => void>>();
  const posted: Array<{ clientId: string; message: unknown }> = [];
  const caches = createFakeCacheStorage();
  const self = {
    location: { origin: "https://app.example" },
    addEventListener: (type: string, listener: (event: never) => void) => {
      const existing = listeners.get(type) ?? [];
      existing.push(listener);
      listeners.set(type, existing);
    },
    clients: {
      matchAll: async () => [
        {
          id: "client-1",
          postMessage: (message: unknown) =>
            posted.push({ clientId: "client-1", message }),
        },
      ],
      claim: async () => undefined,
    },
    skipWaiting: () => undefined,
  };
  // new Function keeps the module scope isolated while giving the worker
  // source exactly the globals it uses in a real SW context.
  const factory = new Function(
    "self",
    "caches",
    "fetch",
    `${SW_SOURCE}\n;return self;`,
  );
  factory(self, caches, options.fetchImpl);
  return { listeners, posted, caches };
}

function createFetchEvent(request: Request) {
  const waits: Promise<unknown>[] = [];
  const event: SwRequestEvent & {
    responded: Promise<Response> | null;
    waits: Promise<unknown>[];
  } = {
    request,
    responded: null,
    waits,
    respondWith(response) {
      event.responded = Promise.resolve(response);
    },
    waitUntil(promise) {
      waits.push(Promise.resolve(promise));
    },
  };
  return event;
}

function okJsonResponse(body: unknown) {
  const response = new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  // undici-constructed Responses report type "default"; network responses
  // inside a real service worker are "basic", which sw.js requires.
  Object.defineProperty(response, "type", { value: "basic" });
  return response;
}

describe("public/sw.js consumer read caching + outbox sync", () => {
  it("never caches requests carrying an Authorization header (no-store passthrough)", async () => {
    const fetched: Request[] = [];
    const sw = loadServiceWorker({
      fetchImpl: async (input) => {
        fetched.push(input);
        return okJsonResponse({ ok: true });
      },
    });
    const request = new Request(
      "https://app.example/api/trpc/consumerCatalog.consumerVerticals?batch=1&input=%7B%7D",
      { headers: { authorization: "Bearer user-token" } },
    );
    const event = createFetchEvent(request);
    for (const listener of sw.listeners.get("fetch") ?? []) listener(event as never);
    expect(event.responded).not.toBeNull();
    await event.responded;
    expect(fetched).toHaveLength(1);

    // Second identical request must hit the network again — nothing cached.
    const event2 = createFetchEvent(request);
    for (const listener of sw.listeners.get("fetch") ?? []) listener(event2 as never);
    await event2.responded;
    expect(fetched).toHaveLength(2);
  });

  it("serves whitelisted consumer reads stale-while-revalidate within the 60s budget", async () => {
    let fetches = 0;
    const sw = loadServiceWorker({
      fetchImpl: async () => {
        fetches += 1;
        return okJsonResponse({ result: { data: { n: fetches } } });
      },
    });
    const url =
      "https://app.example/api/trpc/consumerCatalog.consumerVerticals?batch=1&input=%7B%7D";

    const first = createFetchEvent(new Request(url));
    for (const listener of sw.listeners.get("fetch") ?? []) listener(first as never);
    const firstResponse = await first.responded!;
    expect(fetches).toBe(1);
    await firstResponse.text();

    // Fresh cached entry: served from cache while the background
    // revalidation (waitUntil) refreshes the entry asynchronously.
    const second = createFetchEvent(new Request(url));
    for (const listener of sw.listeners.get("fetch") ?? []) listener(second as never);
    const cachedResponse = await second.responded!;
    const body = (await cachedResponse.json()) as {
      result: { data: { n: number } };
    };
    expect(body.result.data.n).toBe(1);
    await Promise.all(second.waits); // background revalidation completes
    expect(fetches).toBe(2);

    // Age the entry beyond the 60s max-age: the next request revalidates
    // synchronously instead of serving stale.
    const store = sw.caches.stores.get(
      [...sw.caches.stores.keys()].find((key) =>
        key.startsWith("switchos-consumer-read-"),
      )!,
    )!;
    const cached = store.get(url)!;
    const agedHeaders = new Headers(cached.headers);
    agedHeaders.set("x-sw-cached-at", String(Date.now() - 61_000));
    store.set(
      url,
      new Response(await cached.clone().blob(), {
        status: cached.status,
        headers: agedHeaders,
      }),
    );
    const third = createFetchEvent(new Request(url));
    for (const listener of sw.listeners.get("fetch") ?? []) listener(third as never);
    const thirdResponse = await third.responded!;
    expect(fetches).toBe(3);
    const thirdBody = (await thirdResponse.json()) as {
      result: { data: { n: number } };
    };
    expect(thirdBody.result.data.n).toBe(3);
  });

  it("keeps non-whitelisted API paths network-only and never touches non-GET requests", async () => {
    const fetched: string[] = [];
    const sw = loadServiceWorker({
      fetchImpl: async (input) => {
        fetched.push(`${input.method} ${input.url}`);
        return okJsonResponse({ ok: true });
      },
    });
    const fetchListeners = sw.listeners.get("fetch") ?? [];

    // consumerRide.requestRide is a mutation path — even a hypothetical GET
    // to it must bypass the consumer read cache.
    const readEvent = createFetchEvent(
      new Request("https://app.example/api/trpc/consumerRide.requestRide"),
    );
    for (const listener of fetchListeners) listener(readEvent as never);
    await readEvent.responded;
    expect(fetched).toEqual([
      "GET https://app.example/api/trpc/consumerRide.requestRide",
    ]);
    expect([...sw.caches.stores.keys()].some((k) => k.includes("consumer-read"))).toBe(
      false,
    );

    // POST requests pass straight through (no respondWith at all).
    const postEvent = createFetchEvent(
      new Request("https://app.example/api/trpc/consumer.checkout?batch=1", {
        method: "POST",
        body: "{}",
      }),
    );
    for (const listener of fetchListeners) listener(postEvent as never);
    expect(postEvent.responded).toBeNull();
  });

  it("fans a CONSUMER_OUTBOX_SYNC message out to window clients on the sync event", async () => {
    const sw = loadServiceWorker({
      fetchImpl: async () => okJsonResponse({}),
    });
    const waits: Promise<unknown>[] = [];
    for (const listener of sw.listeners.get("sync") ?? []) {
      listener({
        tag: CONSUMER_OUTBOX_SYNC_TAG,
        waitUntil: (promise: Promise<unknown>) => waits.push(promise),
      } as never);
    }
    await Promise.all(waits);
    expect(sw.posted).toEqual([
      {
        clientId: "client-1",
        message: {
          type: CONSUMER_OUTBOX_SYNC_MESSAGE,
          tag: CONSUMER_OUTBOX_SYNC_TAG,
        },
      },
    ]);
  });
});
