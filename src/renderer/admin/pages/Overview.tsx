import { AlarmClock, Clock, LogIn, LogOut, ShieldAlert, UserCheck, UserX, Users } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DayRecord, HostHealth, MonthlyReport, OverviewCounts, Settings } from '../../../shared/types';
import { useAuth, useRefreshOn } from '../api';
import { ArrivalsChart, Donut } from '../charts';
import { Banner, Button, Card, Chip, Empty, SearchBox, Stat, StatusChip, hm, initials, mins, useAction, when } from '../ui';

interface Overview {
  date: string;
  counts: OverviewCounts;
  rows: DayRecord[];
  timeline: Array<{ id: string; ts: string; employeeName: string; kind: string; classification: string; local: string; source: string; approvalStatus?: string }>;
  pendingRequests: number;
  pendingApprovals: number;
  health: HostHealth;
  settings: Settings;
  monthly: MonthlyReport;
}

export function OverviewPage({ go }: { go: (p: string) => void }) {
  const { call, can } = useAuth();
  const { busy, run } = useAction();
  const [data, setData] = useState<Overview | null>(null);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'in' | 'out' | 'on-time' | 'grace' | 'late' | 'absent' | 'pending'>('all');
  const [month, setMonth] = useState('');
  const [monthly, setMonthly] = useState<MonthlyReport | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);

  const load = useCallback(() => {
    call<Overview>('dashboard.overview').then((d) => {
      setData((old) => {
        if (old && d.timeline[0] && old.timeline[0]?.id !== d.timeline[0].id) setFresh(d.timeline[0].id);
        return d;
      });
    }).catch(() => undefined);
  }, [call]);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000); // rolls "pending" into "absent" as the day passes
    return () => clearInterval(t);
  }, [load]);
  useRefreshOn(['attendance.saved', 'correction.saved', 'employee.changed', 'settings.changed', 'request.created', 'request.decided', 'device.changed', 'approval.requested', 'approval.decided'], load);

  const loadMonthly = useCallback(() => {
    if (!month) return;
    call<MonthlyReport>('attendance.monthly', { month }).then(setMonthly).catch(() => undefined);
  }, [call, month]);
  useEffect(loadMonthly, [loadMonthly]);
  useRefreshOn(['attendance.saved', 'correction.saved', 'approval.decided'], loadMonthly);

  const rows = useMemo(() => {
    if (!data) return [];
    const kw = q.trim().toLowerCase();
    return data.rows.filter((r) => {
      if (kw && !`${r.employeeName} ${r.employeeId} ${r.department}`.toLowerCase().includes(kw)) return false;
      switch (filter) {
        case 'in': return r.state === 'checked-in';
        case 'out': return r.state === 'checked-out';
        case 'on-time': return r.classification === 'on-time';
        case 'grace': return r.classification === 'grace';
        case 'late': return r.classification === 'late';
        case 'absent': return r.status === 'absent';
        case 'pending': return r.status === 'pending';
        default: return true;
      }
    });
  }, [data, q, filter]);

  if (!data) return <div className="muted">Loading…</div>;
  const { counts, health } = data;
  const report = month && monthly && monthly.month === month ? monthly : data.monthly;
  const shownMonth = month || data.monthly.month;
  const st = health.storage;

  return (
    <>
      {st.status !== 'ok' ? (
        <Banner tone={st.status === 'critical' ? 'bad' : 'warn'} title={st.status === 'critical' ? 'Attention needed: storage problem' : 'Storage notice'} action={<Button size="sm" onClick={() => go('audit')}>Open audit log</Button>}>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{st.messages.slice(0, 4).map((m, i) => <li key={i}>{m}</li>)}</ul>
        </Banner>
      ) : null}
      {health.clock.suspect ? (
        <Banner tone="bad" title="Host clock warning — attendance is paused" action={can('write') ? <Button size="sm" variant="primary" loading={busy === 'clock'} onClick={() => run('clock', () => call('host.acknowledgeClock'), 'Clock warning acknowledged').then(load)}>Acknowledge</Button> : null}>
          <div>{health.clock.message}</div>
        </Banner>
      ) : null}
      {data.pendingRequests > 0 ? (
        <Banner tone="info" title={`${data.pendingRequests} registration request${data.pendingRequests > 1 ? 's' : ''} waiting for approval`} action={<Button size="sm" variant="primary" onClick={() => go('requests')}>Review</Button>} />
      ) : null}

      {data.pendingApprovals > 0 ? (
        <Banner tone="info" title={`${data.pendingApprovals} attendance approval${data.pendingApprovals > 1 ? 's' : ''} waiting for a decision`} action={<Button size="sm" variant="primary" onClick={() => go('approvals')}>Review</Button>} />
      ) : null}

      <div className="grid g-stats" style={{ marginBottom: 18 }}>
        <Stat label="On time" value={counts.onTime} tone="mint" icon={<UserCheck size={17} />} note={`of ${counts.total} employees`} />
        <Stat label="Grace" value={counts.grace} tone="yellow" icon={<AlarmClock size={17} />} note="within the grace period" />
        <Stat label="Late" value={counts.late} tone="rose" icon={<ShieldAlert size={17} />} note="after the grace period" />
        <Stat label="Absent" value={counts.absent} tone="grey" icon={<UserX size={17} />} note="no check-in today" />
        <Stat label="Checked in" value={counts.checkedIn} tone="blue" icon={<LogIn size={17} />} note="currently on site" />
        <Stat label="Checked out" value={counts.checkedOut} tone="navy" icon={<LogOut size={17} />} note="done for today" />
        <Stat label="Pending" value={counts.pending} tone="grey" icon={<Clock size={17} />} note="not arrived yet" />
      </div>

      <div className="grid g-2" style={{ marginBottom: 18 }}>
        <div className="grid g-2e">
          <Card title="Attendance today" sub={data.date}>
            <Donut counts={counts} />
          </Card>
          <Card title="Arrivals" sub="15-minute slots around start time">
            <ArrivalsChart rows={data.rows} workStart={data.settings.workStart} />
          </Card>
        </div>
        <Card title="Live activity" sub="Newest first" pad>
          {data.timeline.length === 0 ? (
            <Empty icon={<Clock size={30} />} title="No activity yet">Check-ins appear here the moment they are saved.</Empty>
          ) : (
            <div className="timeline" style={{ maxHeight: 250, overflow: 'auto' }}>
              {data.timeline.slice(0, 12).map((t) => (
                <div key={t.id} className={`tl-item ${fresh === t.id ? 'fresh' : ''}`}>
                  <span className={`tl-ico ${t.kind === 'check-in' ? (t.classification === 'late' || t.classification === 'very-late' ? 'tone-rose' : t.classification === 'grace' ? 'tone-yellow' : 'tone-mint') : t.classification === 'early-leave' ? 'tone-rose' : 'tone-blue'}`}>{t.kind === 'check-in' ? <LogIn size={15} /> : <LogOut size={15} />}</span>
                  <div className="tl-main">
                    <b>{t.employeeName}</b> {t.kind === 'check-in' ? 'checked in' : 'checked out'}
                    <div>
                      {t.local.slice(0, 5)}
                      {t.classification === 'grace' ? ' · grace' : ''}
                      {t.classification === 'late' || t.classification === 'very-late' ? ' · late' : ''}
                      {t.classification === 'early-leave' ? ' · early leave' : ''}
                      {t.classification === 'overtime' ? ` · overtime ${t.approvalStatus ?? ''}` : ''}
                      {t.source === 'correction' ? ' · manual' : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Monthly attendance"
        sub={`${report.exceeding.length} employee${report.exceeding.length === 1 ? '' : 's'} over a limit · grace limit ${report.graceLimit}, late limit ${report.lateLimit}`}
        action={<input className="input" type="month" aria-label="Month" value={shownMonth} onChange={(e) => e.target.value && setMonth(e.target.value)} />}
      >
        {report.rows.length === 0 ? (
          <Empty icon={<AlarmClock size={30} />} title="No attendance this month">Monthly counts appear after the first check-in.</Empty>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 360 }}>
            <table className="t">
              <thead><tr><th>Employee</th><th>On time</th><th>Grace</th><th>Late</th><th>Warning</th></tr></thead>
              <tbody>
                {[...report.exceeding, ...report.rows.filter((r) => !r.graceExceeded && !r.lateExceeded)].map((r) => (
                  <tr key={r.employeeId}>
                    <td><div className="name">{r.employeeName}</div><div className="sub">{r.employeeId}{r.department ? ` · ${r.department}` : ''}</div></td>
                    <td><span className="mcount">{r.onTime}</span></td>
                    <td><span className={`mcount ${r.graceExceeded ? 'hit g' : ''}`}>{r.grace}</span></td>
                    <td><span className={`mcount ${r.lateExceeded ? 'hit l' : ''}`}>{r.late}</span></td>
                    <td>
                      <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        {r.graceExceeded ? <Chip tone="yellow">Grace limit exceeded</Chip> : null}
                        {r.lateExceeded ? <Chip tone="rose">Late limit exceeded</Chip> : null}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Employees today"
        sub={`${rows.length} shown`}
        action={
          <>
            <div className="tabs" role="tablist">
              {([['all', 'All'], ['in', 'In'], ['out', 'Out'], ['on-time', 'On time'], ['grace', 'Grace'], ['late', 'Late'], ['pending', 'Pending'], ['absent', 'Absent']] as const).map(([k, l]) => (
                <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>
              ))}
            </div>
            <div style={{ width: 220 }}><SearchBox value={q} onChange={setQ} placeholder="Search employees" /></div>
          </>
        }
      >
        {data.rows.length === 0 ? (
          <Empty icon={<Users size={32} />} title="No employees yet">
            Add employees (or import a CSV) on the Employees page, then approve their phones from the Requests queue.
            <div style={{ marginTop: 12 }}><Button variant="primary" onClick={() => go('employees')}>Add employees</Button></div>
          </Empty>
        ) : (
          <div className="table-wrap" style={{ maxHeight: 460 }}>
            <table className="t">
              <thead><tr><th>Employee</th><th>Shift</th><th>Status</th><th>Check-in</th><th>Check-out</th><th>Worked</th><th>Notes</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.employeeId}>
                    <td>
                      <div className="row">
                        <span className="avatar" style={{ background: 'var(--blue-soft)', color: 'var(--blue)' }}>{initials(r.employeeName)}</span>
                        <div><div className="name">{r.employeeName}</div><div className="sub">{r.employeeId}{r.department ? ` · ${r.department}` : ''}</div></div>
                      </div>
                    </td>
                    <td>{r.shifts.length ? r.shifts.map((x) => x.name).join(', ') : <span className="faint">—</span>}</td>
                    <td><StatusChip status={r.status} classification={r.classification} early={r.earlyLeave} missing={r.missingCheckOut} overtime={r.overtimeStatus} approvalPending={r.approvalPending} /></td>
                    <td className="num">{hm(r.checkInLocal)}{r.minutesLate ? <span className="sub"> (+{r.minutesLate}m)</span> : null}</td>
                    <td className={`num ${r.earlyLeave ? 'early-flag' : ''}`}>{hm(r.checkOutLocal)}</td>
                    <td className="num">{mins(r.workedMinutes)}</td>
                    <td>
                      {r.verification === 'manual-correction' ? <Chip tone="amber">Manual</Chip> : null}
                      {r.corrected && r.verification === 'device-signature' ? <Chip tone="amber">Corrected</Chip> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <div className="muted" style={{ marginTop: 12, fontSize: 12 }}>
        <ShieldAlert size={13} style={{ verticalAlign: -2 }} /> Last saved event: {health.latestEvent ? `${health.latestEvent.employeeName} · ${health.latestEvent.kind} · ${when(health.latestEvent.ts)}` : 'none yet'}
      </div>
    </>
  );
}
