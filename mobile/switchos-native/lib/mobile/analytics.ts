export function buildSparkline(values: number[]) {
  if (values.length === 0) {
    return "—";
  }

  const ticks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const min = Math.min(...values);
  const max = Math.max(...values);

  if (min === max) {
    return values.map(() => ticks[3]).join("");
  }

  return values
    .map((value) => {
      const index = Math.max(0, Math.min(ticks.length - 1, Math.round(((value - min) / (max - min)) * (ticks.length - 1))));
      return ticks[index];
    })
    .join("");
}

export function trendDirection(values: number[]) {
  if (values.length < 2) {
    return "steady" as const;
  }

  const first = values[0] ?? 0;
  const last = values[values.length - 1] ?? 0;

  if (last > first) {
    return "up" as const;
  }
  if (last < first) {
    return "down" as const;
  }
  return "steady" as const;
}

export function buildRecentOperationalSeries(current: number, queued: number, failed: number) {
  const safeCurrent = Math.max(0, current);
  const safeQueued = Math.max(0, queued);
  const safeFailed = Math.max(0, failed);

  return [
    Math.max(0, safeCurrent - safeQueued),
    Math.max(0, safeCurrent - safeFailed),
    safeCurrent,
    Math.max(0, safeCurrent + Math.round(safeQueued / 2)),
    Math.max(0, safeCurrent + safeQueued + safeFailed),
  ];
}
