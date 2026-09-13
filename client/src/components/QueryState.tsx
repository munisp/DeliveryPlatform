import { AlertTriangle, Inbox, RefreshCw } from "lucide-react";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type QueryErrorStateProps = {
  /** Short label for the resource that failed, e.g. "trust console data". */
  resource?: string;
  /** Error message surfaced to the operator (tRPC error message). */
  message?: string;
  /** Retries the failed query. */
  onRetry: () => void;
  retrying?: boolean;
};

/**
 * Explicit failure state for tRPC queries. Rendered in place of data so a
 * failed query is never indistinguishable from honest zeros or empty data.
 */
export function QueryErrorState({
  resource = "workspace data",
  message,
  onRetry,
  retrying = false,
}: QueryErrorStateProps) {
  return (
    <Card className="border-amber-900/40 bg-slate-900/60" role="alert">
      <CardHeader className="gap-2">
        <div className="flex items-center gap-2 text-amber-300/90">
          <AlertTriangle className="h-4 w-4" />
          <span className="text-xs font-semibold uppercase tracking-[0.18em]">
            Unable to load {resource}
          </span>
        </div>
        <CardTitle className="text-xl">The query failed — this is not live data.</CardTitle>
        <CardDescription className="max-w-2xl">
          {message ??
            "The server could not return this data. Figures below are withheld rather than shown as zeros."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-medium text-amber-100 transition hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <RefreshCw className={retrying ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
          {retrying ? "Retrying…" : "Retry"}
        </button>
      </CardContent>
    </Card>
  );
}

type EmptyStateProps = {
  /** e.g. "No payouts yet". */
  title: string;
  description?: string;
};

/**
 * Explicit empty state for successful queries that returned no records, so a
 * genuinely empty dataset is clearly distinguished from a failure.
 */
export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-800 bg-slate-950/60 px-6 py-10 text-center">
      <Inbox className="h-6 w-6 text-slate-500" />
      <p className="text-sm font-medium text-slate-200">{title}</p>
      {description ? (
        <p className="max-w-md text-sm leading-6 text-slate-400">{description}</p>
      ) : null}
    </div>
  );
}
