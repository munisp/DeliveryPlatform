import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import App from "./App";
import "./index.css";
import { trpc } from "@/lib/trpc";
import { UNAUTHED_ERR_MSG } from "@shared/const";
import { getLoginUrl } from "./const";
import { reportClientError } from "./lib/logger";

declare const __APP_BUILD_VERSION__: string;

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root mount element '#root' was not found.");
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Perf wave W4 (audit finding 5): stop refetch storms — keep data fresh
      // for 30s, retain cache for 5min, no refetch on window focus, one retry.
      staleTime: 30_000,
      gcTime: 300_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
const metadataBuildVersion = document
  .querySelector('meta[name="switchos-build-version"]')
  ?.getAttribute("content")
  ?.trim();
const buildVersion =
  metadataBuildVersion && /^[a-zA-Z0-9._-]{7,128}$/.test(metadataBuildVersion)
    ? metadataBuildVersion
    : __APP_BUILD_VERSION__;
const PUBLIC_PATHS = new Set(["/", "/portal"]);

const isPublicRoute = () => {
  if (typeof window === "undefined") return false;
  return PUBLIC_PATHS.has(window.location.pathname);
};

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (error.message !== UNAUTHED_ERR_MSG) return;
  if (isPublicRoute()) return;
  window.location.href = getLoginUrl();
};

queryClient.getQueryCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    reportClientError("api.query_error", error);
  }
});

queryClient.getMutationCache().subscribe((event) => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    reportClientError("api.mutation_error", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
          cache: "no-store",
        });
      },
    }),
  ],
});

const hasImmutableBuildVersion =
  /^[a-zA-Z0-9._-]{7,128}$/.test(buildVersion) &&
  buildVersion !== "__APP_BUILD_VERSION__";

if (
  import.meta.env.PROD &&
  hasImmutableBuildVersion &&
  typeof window !== "undefined" &&
  window.isSecureContext &&
  "serviceWorker" in navigator
) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register("/sw.js", {
        scope: "/",
      });

      const announceUpdate = () => {
        window.dispatchEvent(
          new CustomEvent("switchos:pwa-update-ready", {
            detail: { version: buildVersion },
          }),
        );
      };

      if (registration.waiting) announceUpdate();
      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (
            installing.state === "installed" &&
            navigator.serviceWorker.controller
          ) {
            announceUpdate();
          }
        });
      });

      window.addEventListener("focus", () => {
        void registration.update();
      });
    } catch (error) {
      reportClientError("pwa.service_worker_registration_failed", error, {
        buildVersion,
      });
    }
  });
}

createRoot(rootElement).render(
  <React.StrictMode>
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </trpc.Provider>
  </React.StrictMode>,
);
