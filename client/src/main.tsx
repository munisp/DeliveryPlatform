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

declare global {
  interface Window {
    __APP_BUILD_VERSION__?: string;
  }
}

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root mount element '#root' was not found.");
}

const queryClient = new QueryClient();
const buildVersion = window.__APP_BUILD_VERSION__ && window.__APP_BUILD_VERSION__ !== "__APP_BUILD_VERSION__"
  ? window.__APP_BUILD_VERSION__
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

if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", async () => {
    try {
      const registration = await navigator.serviceWorker.register(`/sw.js?v=${encodeURIComponent(buildVersion)}`);
      if (registration.waiting) {
        registration.waiting.postMessage({ type: "SKIP_WAITING" });
      }
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type === "SW_VERSION_ACTIVATED" && event.data.version !== buildVersion) {
          window.location.reload();
        }
      });
    } catch (error) {
      reportClientError("pwa.service_worker_registration_failed", error, { buildVersion });
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
