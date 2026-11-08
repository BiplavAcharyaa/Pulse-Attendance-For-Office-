import { CheckCircle2, Download, FileSpreadsheet, FolderOpen } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Employee, ExportKind, ExportRequest, ExportStatus } from '../../../shared/types';
import { useAuth, useLive } from '../api';
import { Banner, Button, Card, Field, useAction, when } from '../ui';

const KINDS: Array<{ kind: ExportKind; title: string; blurb: string }> = [
  { kind: 'daily', title: 'Daily report', blurb: 'Everyone for one day' },
  { kind: 'monthly', title: 'Monthly report', blurb: 'A calendar month with a day-by-day grid' },
  { kind: 'range', title: 'Date range', blurb: 'Any period, all employees' },
  { kind: 'employee', title: 'Single employee', blurb: 'One person over a period' },
  { kind: 'complete', title: 'Complete export', blurb: 'All records plus raw events and corrections' },
];

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function ExportsPage() {
  const { call, can } = useAuth();
  const live = useLive();
  const { busy, run } = useAction();
  const [kind, setKind] = useState<ExportKind>('daily');
  const [date, setDate] = useState(today);
  const [month, setMonth] = useState(() => today().slice(0, 7));
  const [from, setFrom] = useState(() => `${today().slice(0, 7)}-01`);
  const [to, setTo] = useState(today);
  const [employeeId, setEmployeeId] = useState('');
  const [emps, setEmps] = useState<Employee[]>([]);
  const [polled, setPolled] = useState<ExportStatus | null>(null);

  useEffect(() => { call<Employee[]>('employees.list').then((l) => { setEmps(l); setEmployeeId((x) => x || l[0]?.id || ''); }).catch(() => undefined); }, [call]);
  const refreshStatus = useCallback(() => call<ExportStatus>('export.status').then(setPolled).catch(() => undefined), [call]);
  useEffect(() => { void refreshStatus(); }, [refreshStatus]);

  const status = live.exportStatus ?? polled;
  const running = status?.state === 'running';

  const start = async () => {
    const req: ExportRequest =
      kind === 'daily' ? { kind, date }
      : kind === 'monthly' ? { kind, month }
      : kind === 'range' ? { kind, from, to }
      : kind === 'employee' ? { kind, employeeId, from, to }
      : { kind, from: from || undefined, to: to || undefined };
    const r = await run('export', () => call<ExportStatus>('export.run', req));
    if (r) setPolled(r);
    void refreshStatus();
  };

  return (
    <div className="grid g-2">
      <Card title="Export center" sub="Reports are written as new .xlsx files. Source records are never modified.">
        <div className="col" style={{ gap: 18 }}>
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(170px, 1fr))', gap: 10 }}>
            {KINDS.map((k) => (
              <button
                key={k.kind}
                onClick={() => setKind(k.kind)}
                className="btn"
                aria-pressed={kind === k.kind}
                style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4, padding: 14, textAlign: 'left', whiteSpace: 'normal', borderColor: kind === k.kind ? 'var(--blue)' : undefined, background: kind === k.kind ? 'var(--blue-tint)' : undefined, boxShadow: kind === k.kind ? '0 0 0 3px rgba(29,95,207,.12)' : undefined }}
              >
                <FileSpreadsheet size={18} color="var(--blue)" />
                <b>{k.title}</b>
                <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>{k.blurb}</span>
              </button>
            ))}
          </div>

          <div className="row wrap" style={{ alignItems: 'flex-end', gap: 12 }}>
            {kind === 'daily' ? <Field label="Date"><input className="input" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field> : null}
            {kind === 'monthly' ? <Field label="Month"><input className="input" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field> : null}
            {kind === 'employee' ? (
              <Field label="Employee">
                <select className="select" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                  {emps.map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.id})</option>)}
                </select>
              </Field>
            ) : null}
            {kind === 'range' || kind === 'employee' || kind === 'complete' ? (
              <>
                <Field label={kind === 'complete' ? 'From (optional)' : 'From'}><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
                <Field label={kind === 'complete' ? 'To (optional)' : 'To'}><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
              </>
            ) : null}
            <Button variant="primary" disabled={!can('export') || running || (kind === 'employee' && !employeeId)} loading={busy === 'export' || running} onClick={() => void start()}>
              <Download size={15} /> Generate Excel file
            </Button>
          </div>
        </div>
      </Card>

      <Card title="Latest export" sub={status?.startedAt ? when(status.startedAt) : 'Nothing exported in this session yet'}>
        {!status || status.state === 'idle' ? (
          <div className="muted">Choose a report type and press Generate. Files are saved in the exports folder inside the data directory.</div>
        ) : (
          <div className="col">
            <div className="progress" role="progressbar" aria-valuenow={status.progress} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${status.progress}%` }} /></div>
            <div className="row between"><span className="muted">{status.step ?? status.state}</span><b>{Math.round(status.progress)}%</b></div>
            {status.state === 'failed' ? <Banner tone="bad" title="Export failed">{status.error}</Banner> : null}
            {status.state === 'done' ? (
              <>
                <div className="row" style={{ color: 'var(--mint-ink)' }}><CheckCircle2 size={18} /> <b>{status.fileName}</b></div>
                <div className="muted">{status.rows} rows</div>
                <div className="row wrap">
                  <Button onClick={() => status.filePath && void run('reveal', () => call('shell.revealExport', { filePath: status.filePath }))}><FolderOpen size={15} /> Show file</Button>
                  <Button onClick={() => void run('open', () => call('shell.openExports'))}>Open exports folder</Button>
                </div>
              </>
            ) : null}
          </div>
        )}
      </Card>
    </div>
  );
}
