/**
 * Minimal in-process metrics registry rendered in Prometheus text format at
 * GET /metrics. Each instance exposes its own numbers; a Prometheus server
 * would scrape and aggregate all instances.
 */
type Labels = Record<string, string>;
type Kind = 'counter' | 'gauge' | 'summary';

const HELP: Record<string, [Kind, string]> = {
  wager_transactions_total: ['counter', 'Settled wager transactions by final status'],
  wager_duplicates_total: ['counter', 'Requests/messages answered as an idempotent replay'],
  wager_reference_retries_total: ['counter', 'PENDING_REFERENCE re-evaluations by the retry worker'],
  wager_queue_retries_total: ['counter', 'Queue messages left for redelivery after a transient error'],
  wager_dlq_total: ['counter', 'Queue messages sent to the dead-letter queue'],
  wallet_lock_timeouts_total: ['counter', 'Requests that gave up waiting for a busy wallet lock'],
  outbox_published_total: ['counter', 'Outbox events published'],
  outbox_lag_seconds: ['gauge', 'Age of the oldest unpublished outbox event'],
  wager_processing_seconds: ['summary', 'Wager processing latency'],
};

class Metrics {
  private readonly values = new Map<string, Map<string, number>>();

  inc(name: string, labels: Labels = {}, by = 1): void {
    const series = this.series(name);
    const key = labelKey(labels);
    series.set(key, (series.get(key) ?? 0) + by);
  }

  set(name: string, value: number, labels: Labels = {}): void {
    this.series(name).set(labelKey(labels), value);
  }

  observe(name: string, seconds: number): void {
    this.inc(`${name}_sum`, {}, seconds);
    this.inc(`${name}_count`);
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, [kind, help]] of Object.entries(HELP)) {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${kind}`);
      const names = kind === 'summary' ? [`${name}_sum`, `${name}_count`] : [name];
      for (const seriesName of names) {
        for (const [key, value] of this.values.get(seriesName) ?? []) {
          lines.push(`${seriesName}${key} ${value}`);
        }
      }
    }
    return `${lines.join('\n')}\n`;
  }

  private series(name: string): Map<string, number> {
    let series = this.values.get(name);
    if (!series) {
      series = new Map();
      this.values.set(name, series);
    }
    return series;
  }
}

function labelKey(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? '' : `{${entries.map(([k, v]) => `${k}="${v}"`).join(',')}}`;
}

export const metrics = new Metrics();
