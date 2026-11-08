import type { AuditBody, AuditEntry, LiveEvent, Severity } from '../../shared/types';
import { newId } from '../ids';
import type { JsonlLog } from '../storage/jsonl';

export interface AuditInput {
  type: string;
  severity?: Severity;
  actor?: string;
  summary: string;
  details?: Record<string, unknown>;
}

/**
 * Administrative and security audit trail (append-only, hash-chained). A failure to write the audit
 * log is surfaced through `lastError` (shown on the health screen) rather than silently ignored.
 */
export class AuditService {
  private readonly throttle = new Map<string, number>();
  lastError: string | null = null;

  constructor(
    private readonly log: JsonlLog<AuditBody>,
    private readonly now: () => number,
    private readonly emit: (e: LiveEvent) => void,
  ) {}

  get count(): number {
    return this.log.count;
  }

  async record(input: AuditInput): Promise<AuditEntry | null> {
    const ts = new Date(this.now()).toISOString();
    const body: AuditBody = {
      v: 1,
      id: newId('aud', this.now()),
      ts,
      type: input.type,
      severity: input.severity ?? 'info',
      actor: input.actor ?? 'system',
      summary: input.summary,
      details: input.details,
    };
    try {
      const rec = await this.log.append(body);
      this.lastError = null;
      this.emit({ type: 'audit', data: rec });
      return rec;
    } catch (e) {
      this.lastError = (e as Error).message;
      // eslint-disable-next-line no-console
      console.error('[audit] write failed:', this.lastError);
      return null;
    }
  }

  /** For high-frequency security noise: at most one identical record per `windowMs`. */
  async recordThrottled(key: string, input: AuditInput, windowMs = 5000): Promise<void> {
    const nowMs = this.now();
    const last = this.throttle.get(key);
    if (last !== undefined && nowMs - last < windowMs) return;
    this.throttle.set(key, nowMs);
    if (this.throttle.size > 2000) {
      for (const [k, t] of this.throttle) if (nowMs - t > windowMs) this.throttle.delete(k);
    }
    await this.record(input);
  }

  list(opts: { limit?: number; type?: string; severity?: Severity; q?: string; securityOnly?: boolean } = {}): AuditEntry[] {
    const q = opts.q?.trim().toLowerCase();
    const out: AuditEntry[] = [];
    for (let i = this.log.records.length - 1; i >= 0 && out.length < (opts.limit ?? 200); i--) {
      const r = this.log.records[i];
      if (opts.securityOnly && !r.type.startsWith('security.') && r.severity !== 'warning' && r.severity !== 'critical') continue;
      if (opts.type && r.type !== opts.type) continue;
      if (opts.severity && r.severity !== opts.severity) continue;
      if (q && !(`${r.summary} ${r.type} ${r.actor} ${JSON.stringify(r.details ?? {})}`.toLowerCase().includes(q))) continue;
      out.push(r);
    }
    return out;
  }

  /** Aggregates suspicious activity in the trailing window. */
  securityOverview(windowMs = 24 * 3600 * 1000): {
    since: string;
    total: number;
    byType: Record<string, number>;
    topSources: Array<{ source: string; count: number }>;
    flaggedDevices: Array<{ deviceId: string; count: number }>;
    recent: AuditEntry[];
  } {
    const since = this.now() - windowMs;
    const byType: Record<string, number> = {};
    const sources = new Map<string, number>();
    const devices = new Map<string, number>();
    const recent: AuditEntry[] = [];
    let total = 0;
    for (let i = this.log.records.length - 1; i >= 0; i--) {
      const r = this.log.records[i];
      if (Date.parse(r.ts) < since) break;
      if (!r.type.startsWith('security.')) continue;
      total++;
      byType[r.type] = (byType[r.type] ?? 0) + 1;
      const ip = r.details?.ip as string | undefined;
      if (ip) sources.set(ip, (sources.get(ip) ?? 0) + 1);
      const dev = r.details?.deviceId as string | undefined;
      if (dev) devices.set(dev, (devices.get(dev) ?? 0) + 1);
      if (recent.length < 25) recent.push(r);
    }
    const top = (m: Map<string, number>) =>
      [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
    return {
      since: new Date(since).toISOString(),
      total,
      byType,
      topSources: top(sources).map(([source, count]) => ({ source, count })),
      flaggedDevices: top(devices).map(([deviceId, count]) => ({ deviceId, count })),
      recent,
    };
  }
}
