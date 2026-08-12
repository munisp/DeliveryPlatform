import type { LucideIcon } from "lucide-react";

import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type Metric = {
  label: string;
  value: string | number;
  supporting?: string;
};

type Section = {
  title: string;
  description: string;
  items: Array<string | Record<string, unknown>>;
};

type PlatformSummaryPageProps = {
  title: string;
  description: string;
  badge: string;
  icon: LucideIcon;
  metrics: Metric[];
  highlights: Array<string | Record<string, unknown>>;
  sections: Section[];
  loading?: boolean;
  error?: string | null;
};

function renderItem(item: string | Record<string, unknown>) {
  if (typeof item === "string") {
    return item;
  }

  return Object.entries(item)
    .map(([key, value]) => `${key.replace(/_/g, " ")}: ${String(value)}`)
    .join(" · ");
}

export default function PlatformSummaryPage({
  title,
  description,
  badge,
  icon: Icon,
  metrics,
  highlights,
  sections,
  loading = false,
  error = null,
}: PlatformSummaryPageProps) {
  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="space-y-4">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-500/10 px-3 py-1 text-xs font-medium uppercase tracking-[0.2em] text-cyan-200">
            <Icon className="h-4 w-4" />
            {badge}
          </div>
          <div>
            <h1 className="text-3xl font-semibold tracking-tight text-white">{title}</h1>
            <p className="mt-2 max-w-3xl text-slate-400">{description}</p>
          </div>
        </div>

        {error && !loading ? (
          <Card className="border-amber-500/40 bg-amber-950/20">
            <CardHeader>
              <CardTitle className="text-amber-100">Workspace data is unavailable</CardTitle>
              <CardDescription>
                This workspace has not returned verified operational data. No synthetic metrics or fallback records are being shown.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-amber-100/80">{error}</p>
            </CardContent>
          </Card>
        ) : (
          <>

        <div className="grid gap-4 xl:grid-cols-4">
          {metrics.map((metric) => (
            <Card key={metric.label}>
              <CardHeader>
                <CardDescription>{metric.label}</CardDescription>
                <CardTitle className="text-3xl text-white">{metric.value}</CardTitle>
              </CardHeader>
              {metric.supporting ? (
                <CardContent>
                  <p className="text-sm text-slate-400">{metric.supporting}</p>
                </CardContent>
              ) : null}
            </Card>
          ))}
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <Card>
            <CardHeader>
              <CardTitle>Operational highlights</CardTitle>
              <CardDescription>Connected signals and synthesized actions currently available in the rebuilt workspace.</CardDescription>
            </CardHeader>
            <CardContent>
              {loading ? (
                <p className="text-sm text-slate-400">Loading workspace signals...</p>
              ) : highlights.length > 0 ? (
                <ul className="space-y-3 text-sm leading-6 text-slate-300">
                  {highlights.map((item, index) => (
                    <li key={`${index}-${renderItem(item)}`} className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
                      {renderItem(item)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-400">No highlights are currently available.</p>
              )}
            </CardContent>
          </Card>

          <div className="space-y-4">
            {sections.map((section) => (
              <Card key={section.title}>
                <CardHeader>
                  <CardTitle>{section.title}</CardTitle>
                  <CardDescription>{section.description}</CardDescription>
                </CardHeader>
                <CardContent>
                  {loading ? (
                    <p className="text-sm text-slate-400">Loading section data...</p>
                  ) : section.items.length > 0 ? (
                    <ul className="space-y-3 text-sm leading-6 text-slate-300">
                      {section.items.map((item, index) => (
                        <li key={`${section.title}-${index}-${renderItem(item)}`} className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3">
                          {renderItem(item)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-slate-400">No entries are currently available.</p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
          </>
        )}
      </div>
    </DashboardLayout>
  );
}
