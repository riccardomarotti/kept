/**
 * Low-overhead performance diagnostics for development and troubleshooting.
 *
 * Disabled by default. Enable with `localStorage.setItem('kept_perf', '1')`
 * (persisted) or `?kept_perf=1` in the URL (this session only), then inspect
 * `window.__keptPerf.snapshot()` in the browser console.
 *
 * Only durations, counts and trigger reasons are recorded. Never pass note
 * text, URLs, tokens or other private metadata as names or triggers.
 */

export interface PerfEntry {
  name: string;
  count: number;
  totalMs: number;
  maxMs: number;
  minMs: number;
  triggers: Record<string, number>;
}

export type PerfSnapshot = Record<string, PerfEntry>;

export class PerfMonitor {
  private entries = new Map<string, PerfEntry>();
  private override?: boolean;

  /** Opt-in check; cheap enough to call on every instrumented path. */
  enabled(): boolean {
    if (this.override !== undefined) return this.override;
    try {
      if (typeof localStorage !== 'undefined') {
        const flag = localStorage.getItem('kept_perf');
        if (flag === '1') return true;
        if (flag === '0') return false;
      }
      if (typeof location !== 'undefined' && /[?&]kept_perf=1(&|$)/.test(location.search || '')) return true;
    } catch { /* Storage can be unavailable; diagnostics must never break the app. */ }
    return false;
  }

  /** Test hook: force monitoring on or off regardless of environment. */
  setEnabled(value: boolean | undefined) {
    this.override = value;
    this.entries.clear();
  }

  /** Time a synchronous or asynchronous unit of work. */
  async time<T>(name: string, trigger: string | undefined, work: () => Promise<T> | T): Promise<T> {
    if (!this.enabled()) return work();
    const started = performance.now();
    try {
      return await work();
    } finally {
      this.record(name, trigger, performance.now() - started);
    }
  }

  /** Record one observed duration manually. */
  record(name: string, trigger: string | undefined, durationMs: number) {
    if (!this.enabled()) return;
    const entry = this.entries.get(name) || { name, count: 0, totalMs: 0, maxMs: 0, minMs: Infinity, triggers: {} };
    entry.count += 1;
    entry.totalMs += durationMs;
    entry.maxMs = Math.max(entry.maxMs, durationMs);
    entry.minMs = Math.min(entry.minMs, durationMs);
    if (trigger) entry.triggers[trigger] = (entry.triggers[trigger] || 0) + 1;
    this.entries.set(name, entry);
  }

  /** Count an instantaneous event (coalesced triggers, redundant work, ...). */
  count(name: string, trigger?: string, amount = 1) {
    if (!this.enabled()) return;
    const entry = this.entries.get(name) || { name, count: 0, totalMs: 0, maxMs: 0, minMs: Infinity, triggers: {} };
    entry.count += amount;
    if (trigger) entry.triggers[trigger] = (entry.triggers[trigger] || 0) + amount;
    this.entries.set(name, entry);
  }

  /** Plain-object summary for console inspection and automated benchmarks. */
  snapshot(): PerfSnapshot {
    const result: PerfSnapshot = {};
    for (const [name, entry] of this.entries) {
      result[name] = { ...entry, triggers: { ...entry.triggers }, minMs: entry.minMs === Infinity ? 0 : entry.minMs };
    }
    return result;
  }

  reset() {
    this.entries.clear();
  }
}

export const perf = new PerfMonitor();

// Expose for browser profiling sessions (diagnostic data only).
try {
  if (typeof window !== 'undefined') (window as typeof window & { __keptPerf?: PerfMonitor }).__keptPerf = perf;
} catch { /* Non-browser runtimes. */ }
