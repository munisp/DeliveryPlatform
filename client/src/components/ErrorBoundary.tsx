import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link } from "wouter";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { reportClientError } from "@/lib/logger";

type ErrorBoundaryProps = {
  children: ReactNode;
  /**
   * "app" renders a full-screen fallback for catastrophic failures;
   * "section" renders an in-place card so the surrounding shell stays usable.
   */
  variant?: "app" | "section";
  /** Human-readable name of the protected area, used in fallback copy and logs. */
  section?: string;
};

type ErrorBoundaryState = {
  error: Error | null;
};

/**
 * Global/section render error boundary. Any render throw below this boundary
 * is contained so the app never white-screens: a styled fallback with a
 * reload action is shown instead, and the error is reported through the
 * client logger.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportClientError("ui.render_error", error, {
      section: this.props.section ?? this.props.variant ?? "unknown",
      component_stack: info.componentStack?.slice(0, 2000) ?? null,
    });
  }

  private handleReload = () => {
    window.location.reload();
  };

  private handleReset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    const sectionLabel = this.props.section ?? "this workspace";
    const devDetails = import.meta.env.DEV ? (
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-xl border border-amber-900/40 bg-slate-950/80 p-4 text-xs leading-5 text-amber-200/80">
        {error.message}
      </pre>
    ) : null;

    const body = (
      <Card className="border-amber-900/40 bg-slate-900/60">
        <CardHeader className="gap-3 p-8">
          <div className="text-xs uppercase tracking-[0.24em] text-amber-300/80">
            Something went wrong
          </div>
          <CardTitle className="text-2xl">
            {this.props.variant === "app"
              ? "The application hit an unexpected error."
              : `We couldn't render ${sectionLabel}.`}
          </CardTitle>
          <CardDescription className="max-w-2xl text-base leading-7">
            Your data is safe. The error has been reported to the operations
            team. Reload the page to try again, or head back to the dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 p-8 pt-0">
          {devDetails}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-full bg-amber-200/90 px-5 py-2.5 text-sm font-medium text-slate-950 transition hover:bg-amber-100"
            >
              Reload page
            </button>
            <button
              type="button"
              onClick={this.handleReset}
              className="rounded-full border border-slate-700 px-5 py-2.5 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-900"
            >
              Try again without reload
            </button>
            <Link
              href="/dashboard"
              className="rounded-full border border-slate-700 px-5 py-2.5 text-sm font-medium text-slate-200 transition hover:border-slate-500 hover:bg-slate-900"
            >
              Return to dashboard
            </Link>
          </div>
        </CardContent>
      </Card>
    );

    if (this.props.variant === "app") {
      return (
        <div className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-16 text-slate-100">
          <div className="w-full max-w-2xl">{body}</div>
        </div>
      );
    }

    return <div className="py-6">{body}</div>;
  }
}

export default ErrorBoundary;
