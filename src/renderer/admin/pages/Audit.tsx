import { ClipboardCheck, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AuditEntry, IntegrityReport, Severity } from '../../../shared/types';
import { useAuth, useRefreshOn } from '../api';
import { Banner, Button, Card, Chip, Empty, SearchBox, Stat, useAction, when } from '../ui';

interface SecurityOverview {
  since: string;
  total: number;
  byType: Record<string, number>;
  topSources: Array<{ source: string; count: number }>;
  flaggedDevices: Array<{ deviceId: string; count: number }>;
  recent: AuditEntry[];
}

const TONE: Record<Severity, 'grey' | 'blue' | 'amber' | 'rose'> = { info: 'grey', notice: 'blue', warning: 'amber', critical: 'rose' };

export function AuditPage() {
  const { call } = useAuth();
  const { busy, run } = useAction();
  const [view, setView] = useState<'all' | 'security'>('all');
  const [severity, setSeverity] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [sec, setSec] = useState<SecurityOverview | null>(null);
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    call<AuditEntry[]>('audit.list', { limit: 300, severity: severity || undefined, q: q.trim() || undefined, securityOnly: view === 'security' }).then(setRows).catch(() => undefined);
    call<SecurityOverview>('audit.security').then(setSec).catch(() => undefined);
  }, [call, view, severity, q]);
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);
  useRefreshOn(['audit'], load, 400);

  return (
    <>
      <div className="grid g-stats" style={{ marginBottom: 18 }}>
        <Stat label="Security events · 24h" value={sec?.total ?? '—'} tone={sec && sec.total > 0 ? 'amber' : 'mint'} icon={<ShieldAlert size={17} />} note={sec ? `since ${when(sec.since)}` : undefined} />
        <Stat label="Flagged devices" value={sec?.flaggedDevices.length ?? '—'} tone={sec?.flaggedDevices.length ? 'rose' : 'grey'} icon={<ShieldAlert size={17} />} note="Devices with rejected scans" />
        <Stat label="Top source" value={sec?.topSources[0]?.source ?? '—'} tone="blue" icon={<ShieldAlert size={17} />} note={sec?.topSources[0] ? `${sec.topSources[0].count} events` : 'Nothing suspicious'} />
      </div>

      <Banner tone="info" title="What the audit log can and cannot do">
        Each entry is chained to the previous one with a keyed hash, so edits, deletions or reordering of the log file are <b>detected</b> by the integrity check. This does not <i>prevent</i> someone with full access to this PC from altering files — it makes silent changes visible.
      </Banner>

      <div style={{ height: 18 }} />
      <Card
        title="Integrity check"
        sub="Verifies the hash chains of the attendance and audit logs"
        action={<Button variant="primary" loading={busy === 'verify'} onClick={async () => { const r = await run('verify', () => call<IntegrityReport>('host.verifyIntegrity')); if (r) setReport(r); }}><ShieldCheck size={15} /> Run check</Button>}
      >
        {!report ? (
          <div className="muted">Not run in this session.</div>
        ) : (
          <div className="col">
            <div className="row">{report.ok ? <Chip tone="mint" icon={<ShieldCheck size={13} />}>All records verified</Chip> : <Chip tone="rose">Problems found</Chip>}<span className="muted">{when(report.at)}</span></div>
            {report.files.map((f) => (
              <div key={f.file}>
                <b>{f.file}</b> <span className="muted">· {f.records} records · {f.ok ? 'OK' : 'PROBLEMS'}</span>
                {f.problems.length ? <ul style={{ margin: '4px 0 0 18px', padding: 0, color: 'var(--rose-ink)' }}>{f.problems.slice(0, 8).map((p, i) => <li key={i}>{p}</li>)}</ul> : null}
              </div>
            ))}
          </div>
        )}
      </Card>

      <div style={{ height: 18 }} />
      <Card
        title="Audit log"
        sub={rows ? `${rows.length} most recent entries` : ''}
        pad={false}
        action={
          <>
            <div className="tabs" role="tablist">
              <button className={view === 'all' ? 'on' : ''} onClick={() => setView('all')}>All</button>
              <button className={view === 'security' ? 'on' : ''} onClick={() => setView('security')}>Suspicious</button>
            </div>
            <select className="select" style={{ width: 130 }} value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Severity">
              <option value="">Any severity</option><option value="info">Info</option><option value="notice">Notice</option><option value="warning">Warning</option><option value="critical">Critical</option>
            </select>
            <div style={{ width: 200 }}><SearchBox value={q} onChange={setQ} placeholder="Search log" /></div>
          </>
        }
      >
        {!rows ? (
          <div className="card-b muted">Loading…</div>
        ) : rows.length === 0 ? (
          <Empty icon={<ClipboardCheck size={32} />} title="No entries">Nothing matches this filter.</Empty>
        ) : (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0, maxHeight: 560 }}>
            <table className="t">
              <thead><tr><th>#</th><th>Time</th><th>Severity</th><th>Actor</th><th>Event</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => setOpen(open === r.id ? null : r.id)} style={{ cursor: 'pointer' }}>
                    <td className="num faint">{r.seq}</td>
                    <td className="num" style={{ whiteSpace: 'nowrap' }}>{when(r.ts)}</td>
                    <td><Chip tone={TONE[r.severity]}>{r.severity}</Chip></td>
                    <td>{r.actor}</td>
                    <td>
                      <div>{r.summary}</div>
                      <div className="sub mono">{r.type}</div>
                      {open === r.id && r.details ? <pre className="mono" style={{ margin: '6px 0 0', whiteSpace: 'pre-wrap', color: 'var(--muted)' }}>{JSON.stringify(r.details, null, 2)}</pre> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
