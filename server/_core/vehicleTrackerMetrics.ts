type Labels = Record<string, string>;

type Counter = {
  help: string;
  values: Map<string, { labels: Labels; value: number }>;
};

type Gauge = {
  help: string;
  values: Map<string, { labels: Labels; value: number }>;
};

type Histogram = {
  help: string;
  buckets: number[];
  values: Map<
    string,
    { labels: Labels; count: number; sum: number; bucketCounts: number[] }
  >;
};

function key(labels: Labels) {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join("|");
}

function escapeLabel(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

function labelText(labels: Labels) {
  const entries = Object.entries(labels).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) return "";
  return `{${entries.map(([name, value]) => `${name}="${escapeLabel(value)}"`).join(",")}}`;
}

function finite(value: number) {
  return Number.isFinite(value) ? value : 0;
}

class Registry {
  private readonly counters = new Map<string, Counter>();
  private readonly gauges = new Map<string, Gauge>();
  private readonly histograms = new Map<string, Histogram>();

  counter(name: string, help: string, labels: Labels = {}, amount = 1) {
    let metric = this.counters.get(name);
    if (!metric) {
      metric = { help, values: new Map() };
      this.counters.set(name, metric);
    }
    const metricKey = key(labels);
    const entry = metric.values.get(metricKey) ?? { labels, value: 0 };
    entry.value += finite(amount);
    metric.values.set(metricKey, entry);
  }

  gauge(name: string, help: string, labels: Labels = {}, value: number) {
    let metric = this.gauges.get(name);
    if (!metric) {
      metric = { help, values: new Map() };
      this.gauges.set(name, metric);
    }
    metric.values.set(key(labels), { labels, value: finite(value) });
  }

  clearGauge(name: string) {
    this.gauges.get(name)?.values.clear();
  }

  histogram(
    name: string,
    help: string,
    labels: Labels = {},
    value: number,
    buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  ) {
    let metric = this.histograms.get(name);
    if (!metric) {
      metric = { help, buckets, values: new Map() };
      this.histograms.set(name, metric);
    }
    const metricKey = key(labels);
    const entry = metric.values.get(metricKey) ?? {
      labels,
      count: 0,
      sum: 0,
      bucketCounts: metric.buckets.map(() => 0),
    };
    const normalized = Math.max(0, finite(value));
    entry.count += 1;
    entry.sum += normalized;
    metric.buckets.forEach((bucket, index) => {
      if (normalized <= bucket) entry.bucketCounts[index] += 1;
    });
    metric.values.set(metricKey, entry);
  }

  render() {
    const lines: string[] = [];
    for (const [name, metric] of this.counters) {
      lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} counter`);
      for (const { labels, value } of metric.values.values()) {
        lines.push(`${name}${labelText(labels)} ${value}`);
      }
    }
    for (const [name, metric] of this.gauges) {
      lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} gauge`);
      for (const { labels, value } of metric.values.values()) {
        lines.push(`${name}${labelText(labels)} ${value}`);
      }
    }
    for (const [name, metric] of this.histograms) {
      lines.push(`# HELP ${name} ${metric.help}`, `# TYPE ${name} histogram`);
      for (const entry of metric.values.values()) {
        metric.buckets.forEach((bucket, index) => {
          lines.push(
            `${name}_bucket${labelText({ ...entry.labels, le: `${bucket}` })} ${entry.bucketCounts[index]}`,
          );
        });
        lines.push(
          `${name}_bucket${labelText({ ...entry.labels, le: "+Inf" })} ${entry.count}`,
          `${name}_sum${labelText(entry.labels)} ${entry.sum}`,
          `${name}_count${labelText(entry.labels)} ${entry.count}`,
        );
      }
    }
    return `${lines.join("\n")}\n`;
  }
}

const registry = new Registry();

const allowedProviderKinds = new Set(["geotab_feed", "traccar_rest"]);
const allowedOperations = new Set([
  "claim",
  "renew",
  "bulk_record",
  "complete",
  "release",
  "fetch",
  "observability",
]);

function providerLabels(providerKind: string, integrationKey?: string) {
  const kind = allowedProviderKinds.has(providerKind) ? providerKind : "other";
  // Integration keys are bounded authority identifiers, not event/device identifiers.
  // Omit invalid or oversized values to preserve cardinality discipline.
  const labels: Labels = { provider_kind: kind };
  if (integrationKey && /^[a-z][a-z0-9_.-]{2,80}$/.test(integrationKey)) {
    labels.integration_key = integrationKey;
  }
  return labels;
}

export const vehicleTrackerMetrics = {
  observePoll(
    providerKind: string,
    outcome: "committed" | "empty" | "failed" | "connected" | "configured",
    durationSeconds: number,
  ) {
    const labels = { ...providerLabels(providerKind), outcome };
    registry.counter(
      "vehicle_tracker_provider_ingest_batches_total",
      "Tracker provider ingest cycle outcomes.",
      labels,
    );
    registry.histogram(
      "vehicle_tracker_provider_ingest_duration_seconds",
      "Tracker provider ingest operation duration in seconds.",
      { ...providerLabels(providerKind), operation: "cycle" },
      durationSeconds,
    );
  },

  observeClaim(providerKind: string, outcome: "acquired" | "empty" | "fenced") {
    registry.counter(
      "vehicle_tracker_provider_cursor_claims_total",
      "Tracker provider cursor claim outcomes.",
      { ...providerLabels(providerKind), outcome },
    );
  },

  observeRecords(
    providerKind: string,
    outcome: "recorded" | "duplicate" | "unknown_device",
    count: number,
  ) {
    registry.counter(
      "vehicle_tracker_provider_ingest_records_total",
      "Normalized tracker provider record outcomes.",
      { ...providerLabels(providerKind), outcome },
      count,
    );
  },

  observeFence(providerKind: string, operation: string) {
    registry.counter(
      "vehicle_tracker_provider_cursor_fence_failures_total",
      "Tracker provider cursor UUID lease fencing failures.",
      {
        ...providerLabels(providerKind),
        operation: allowedOperations.has(operation) ? operation : "other",
      },
    );
  },

  observeDatabaseQuery(
    operation: string,
    durationSeconds: number,
    sqlState?: string,
  ) {
    const boundedOperation = allowedOperations.has(operation)
      ? operation
      : "other";
    registry.histogram(
      "vehicle_tracker_database_query_duration_seconds",
      "Tracker worker PostgreSQL authority query duration in seconds.",
      { operation: boundedOperation },
      durationSeconds,
    );
    if (sqlState) {
      registry.counter(
        "vehicle_tracker_database_query_failures_total",
        "Tracker worker PostgreSQL authority query failures by SQLSTATE.",
        {
          operation: boundedOperation,
          sqlstate: /^[0-9A-Z]{5}$/.test(sqlState) ? sqlState : "other",
        },
      );
    }
  },

  setPool(
    total: number,
    idle: number,
    waiting: number,
    maxConnections: number,
  ) {
    registry.gauge(
      "vehicle_tracker_pool_connections",
      "Tracker worker dedicated PostgreSQL pool connections by state.",
      { state: "total" },
      total,
    );
    registry.gauge(
      "vehicle_tracker_pool_connections",
      "Tracker worker dedicated PostgreSQL pool connections by state.",
      { state: "in_use" },
      Math.max(0, total - idle),
    );
    registry.gauge(
      "vehicle_tracker_pool_connections",
      "Tracker worker dedicated PostgreSQL pool connections by state.",
      { state: "idle" },
      idle,
    );
    registry.gauge(
      "vehicle_tracker_pool_connections",
      "Tracker worker dedicated PostgreSQL pool connections by state.",
      { state: "waiting" },
      waiting,
    );
    registry.gauge(
      "vehicle_tracker_pool_max_connections",
      "Configured maximum connections for the tracker worker dedicated PostgreSQL pool.",
      {},
      maxConnections,
    );
  },

  setDatabaseLockState(input: {
    activeTransactions: number;
    lockWaitingTransactions: number;
    maxLockWaitSeconds: number;
    available: boolean;
  }) {
    registry.gauge(
      "vehicle_tracker_database_lock_observability_up",
      "Whether tracker-worker database lock wait statistics are available from PostgreSQL.",
      {},
      input.available ? 1 : 0,
    );
    registry.gauge(
      "vehicle_tracker_database_active_transactions",
      "Active PostgreSQL transactions attributed to the tracker worker application name.",
      {},
      input.activeTransactions,
    );
    registry.gauge(
      "vehicle_tracker_database_lock_waiting_transactions",
      "Active tracker-worker PostgreSQL transactions waiting on locks.",
      {},
      input.lockWaitingTransactions,
    );
    registry.gauge(
      "vehicle_tracker_database_max_lock_wait_seconds",
      "Maximum current lock wait age for tracker-worker PostgreSQL transactions.",
      {},
      input.maxLockWaitSeconds,
    );
  },

  setLeaseState(input: {
    providerKind: string;
    integrationKey: string;
    leaseExpiresAtSeconds: number;
    cursorAgeSeconds: number;
    lastErrorAgeSeconds: number | null;
  }) {
    const labels = providerLabels(input.providerKind, input.integrationKey);
    registry.gauge(
      "vehicle_tracker_provider_cursor_lease_expires_at_seconds",
      "Unix timestamp at which an active tracker cursor lease expires, or zero when unclaimed.",
      labels,
      input.leaseExpiresAtSeconds,
    );
    registry.gauge(
      "vehicle_tracker_provider_cursor_age_seconds",
      "Seconds since durable tracker provider cursor completion.",
      labels,
      input.cursorAgeSeconds,
    );
    if (input.lastErrorAgeSeconds !== null) {
      registry.gauge(
        "vehicle_tracker_provider_cursor_error_age_seconds",
        "Seconds since latest tracker provider cursor error.",
        labels,
        input.lastErrorAgeSeconds,
      );
    }
  },

  resetProviderOverdueCursors() {
    registry.clearGauge("vehicle_tracker_provider_overdue_cursors");
  },

  setProviderOverdueCursor(input: {
    providerKind: string;
    integrationKey: string;
    cursorAgeSeconds: number;
    pollIntervalMs: number;
    namespace: string;
  }) {
    // This is deliberately a bounded work-lane signal, not a claim about the
    // number of records pending at a third-party provider. Every active
    // provider/integration contributes either zero or one overdue cursor.
    const overdueAfterSeconds = Math.max(
      120,
      Math.min(600, Math.floor(Math.max(5_000, input.pollIntervalMs) / 1_000) * 2),
    );
    registry.gauge(
      "vehicle_tracker_provider_overdue_cursors",
      "One when a tracker provider cursor is overdue by at least two bounded poll intervals; this is a bounded provider-work-lane signal, not a record count.",
      {
        ...providerLabels(input.providerKind, input.integrationKey),
        autoscaling_scope: "vehicle-tracker-ingest",
        namespace: input.namespace,
      },
      Math.max(0, finite(input.cursorAgeSeconds)) >= overdueAfterSeconds ? 1 : 0,
    );
  },

  render() {
    return registry.render();
  },
};
