import client from 'prom-client';

/**
 * Prometheus metrics. The questions these answer in production:
 *  - Is a partner's feed suddenly failing or being held?            feed_runs_total{status}
 *  - Is data quality degrading for a partner/format?                 feed_records_total{outcome}, feed_issues_total{code}
 *  - Are humans the bottleneck (runs waiting for mapping/approval)?  feed_runs_waiting{status}
 *  - Is ingestion getting slower?                                    feed_run_duration_seconds
 *  - Are partners changing their schemas?                            feed_schema_drift_total
 */
export function createMetrics(countWaiting: () => Record<string, number>) {
  const registry = new client.Registry();
  client.collectDefaultMetrics({ register: registry });

  const runs = new client.Counter({
    name: 'feed_runs_total',
    help: 'Ingestion runs by final status',
    labelNames: ['partner', 'import_type', 'format', 'status'] as const,
    registers: [registry],
  });
  const records = new client.Counter({
    name: 'feed_records_total',
    help: 'Records processed by outcome',
    labelNames: ['partner', 'format', 'outcome'] as const,
    registers: [registry],
  });
  const issues = new client.Counter({
    name: 'feed_issues_total',
    help: 'Issues found, by code and severity',
    labelNames: ['partner', 'code', 'severity'] as const,
    registers: [registry],
  });
  const drift = new client.Counter({
    name: 'feed_schema_drift_total',
    help: 'Runs whose field set differs from the previous run of the same partner and format',
    labelNames: ['partner', 'format'] as const,
    registers: [registry],
  });
  const duration = new client.Histogram({
    name: 'feed_run_duration_seconds',
    help: 'Time to process a file (analysis + processing)',
    labelNames: ['format'] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });
  new client.Gauge({
    name: 'feed_runs_waiting',
    help: 'Runs waiting for a human (mapping confirmation or review)',
    labelNames: ['status'] as const,
    registers: [registry],
    collect() {
      const counts = countWaiting();
      for (const status of ['AWAITING_MAPPING', 'HELD_FOR_REVIEW']) this.set({ status }, counts[status] ?? 0);
    },
  });

  return { registry, runs, records, issues, drift, duration };
}

export type Metrics = ReturnType<typeof createMetrics>;
