import { CalendarDays, ClipboardList, Pencil, Plus, Trash2, Wrench } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ApprovalView, DayRecord, Employee, Shift } from '../../../shared/types';
import { DecisionModal, approvalDetail, approvalLabel, type DecisionDraft } from './Approvals';
import { useAuth, useRefreshOn } from '../api';
import { ApprovalChip, Button, Card, Chip, ClassChip, Empty, Field, Modal, SearchBox, StatusChip, hm, initials, mins, useAction } from '../ui';

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

type Correction =
  | { op: 'add'; employeeId: string; date: string; kind: 'check-in' | 'check-out'; time: string; reason: string }
  | { op: 'void'; eventId: string; label: string; reason: string }
  | { op: 'amend'; eventId: string; label: string; date: string; time: string; reason: string };

export function AttendancePage() {
  const { call, can } = useAuth();
  const { busy, run } = useAction();
  const [from, setFrom] = useState(() => shift(todayLocal(), -6));
  const [to, setTo] = useState(todayLocal);
  const [employeeId, setEmployeeId] = useState('');
  const [status, setStatus] = useState('');
  const [classification, setClassification] = useState('');
  const [shiftId, setShiftId] = useState('');
  const [shiftList, setShiftList] = useState<Shift[]>([]);
  const [q, setQ] = useState('');
  const [emps, setEmps] = useState<Employee[]>([]);
  const [data, setData] = useState<{ rows: DayRecord[]; truncated: boolean } | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<DayRecord | null>(null);
  const [fix, setFix] = useState<Correction | null>(null);
  const [decision, setDecision] = useState<DecisionDraft | null>(null);

  const load = useCallback(() => {
    call<{ rows: DayRecord[]; truncated: boolean }>('attendance.history', { from, to, employeeId: employeeId || undefined, status: status || undefined, classification: classification || undefined, shiftId: shiftId || undefined, q: q.trim() || undefined })
      .then((d) => { setData(d); setError(''); })
      .catch((e: Error) => setError(e.message));
  }, [call, from, to, employeeId, status, classification, shiftId, q]);
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => { call<Employee[]>('employees.list').then(setEmps).catch(() => undefined); call<Shift[]>('shifts.list').then(setShiftList).catch(() => undefined); }, [call]);
  useRefreshOn(['attendance.saved', 'correction.saved', 'employee.changed', 'approval.requested', 'approval.decided'], load);

  // Keep the open detail panel in sync after a correction.
  useEffect(() => {
    if (open && data) setOpen(data.rows.find((r) => r.employeeId === open.employeeId && r.date === open.date) ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const canWrite = can('write');
  const apply = async () => {
    if (!fix) return;
    const { op, reason } = fix;
    const body =
      fix.op === 'add' ? { op, employeeId: fix.employeeId, kind: fix.kind, date: fix.date, time: fix.time, reason }
      : fix.op === 'amend' ? { op, eventId: fix.eventId, date: fix.date, time: fix.time, reason }
      : { op, eventId: fix.eventId, reason };
    const ok = await run('fix', () => call('corrections.apply', body), 'Correction recorded — the original record is preserved');
    if (ok) { setFix(null); load(); }
  };

  return (
    <>
      <Card title="Attendance history" sub={data ? `${data.rows.length} day records${data.truncated ? ' (showing the most recent 3000)' : ''}` : ''} pad={false}
        action={
          can('write') ? <Button onClick={() => setFix({ op: 'add', employeeId: emps[0]?.id ?? '', date: todayLocal(), kind: 'check-in', time: '09:00', reason: '' })}><Wrench size={14} /> Add missing record</Button> : null
        }>
        <div className="row wrap" style={{ padding: '4px 20px 16px', gap: 12, alignItems: 'flex-end' }}>
          <Field label="From"><input className="input" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></Field>
          <Field label="To"><input className="input" type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></Field>
          <Field label="Employee">
            <select className="select" value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">Everyone</option>
              {emps.map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.id}){e.archivedAt ? ' — archived' : ''}</option>)}
            </select>
          </Field>
          <Field label="Shift">
            <select className="select" value={shiftId} onChange={(e) => setShiftId(e.target.value)}>
              <option value="">All shifts</option>
              {shiftList.map((sh) => <option key={sh.id} value={sh.id}>{sh.name}{sh.active ? '' : ' (inactive)'}</option>)}
              <option value="none">No shift</option>
            </select>
          </Field>
          <Field label="Classification">
            <select className="select" value={classification} onChange={(e) => setClassification(e.target.value)}>
              <option value="">All</option>
              <option value="on-time">On time (green)</option>
              <option value="grace">Grace (yellow)</option>
              <option value="late">Late (red)</option>
            </select>
          </Field>
          <Field label="Show">
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All days</option>
              <option value="present">Checked in</option>
              <option value="checked-in">Still checked in</option>
              <option value="checked-out">Checked out</option>
              <option value="overtime">Overtime</option>
              <option value="approval-pending">Awaiting approval</option>
              <option value="approval-rejected">Approval rejected</option>
              <option value="absent">Absent</option>
              <option value="early-leave">Left early</option>
              <option value="missing-checkout">Missing check-out</option>
              <option value="corrected">Corrected</option>
            </select>
          </Field>
          <div className="grow" style={{ minWidth: 180 }}><SearchBox value={q} onChange={setQ} placeholder="Search name, ID, department" /></div>
          <Button onClick={() => { const t = todayLocal(); setFrom(t); setTo(t); }}><CalendarDays size={14} /> Today</Button>
        </div>
        {error ? <div className="card-b" style={{ color: 'var(--rose-ink)' }}>{error}</div> : null}
        {!data ? (
          <div className="card-b muted">Loading…</div>
        ) : data.rows.length === 0 ? (
          <Empty icon={<ClipboardList size={32} />} title="No records match">Try widening the date range or clearing filters.</Empty>
        ) : (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0, borderTop: '1px solid var(--border)', maxHeight: 620 }}>
            <table className="t">
              <thead><tr><th>Date</th><th>Employee</th><th>Shift</th><th>Check-in</th><th>Status</th><th>Check-out</th><th>Worked</th><th>Notes</th></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={`${r.date}-${r.employeeId}`} onClick={() => setOpen(r)} style={{ cursor: 'pointer' }}>
                    <td className="num">{r.date}</td>
                    <td>
                      <div className="row">
                        <span className="avatar" style={{ background: 'var(--blue-soft)', color: 'var(--blue)' }}>{initials(r.employeeName)}</span>
                        <div><div className="name">{r.employeeName}</div><div className="sub">{r.employeeId}</div></div>
                      </div>
                    </td>
                    <td>{r.shifts.length ? r.shifts.map((x) => x.name).join(', ') : <span className="faint">—</span>}</td>
                    <td className="num">{hm(r.checkInLocal)}</td>
                    <td><StatusChip status={r.status} classification={r.classification} early={r.earlyLeave} missing={r.missingCheckOut} overtime={r.overtimeStatus} approvalPending={r.approvalPending} /></td>
                    <td className={`num ${r.earlyLeave ? 'early-flag' : ''}`}>{hm(r.checkOutLocal)}{[...r.sessions].reverse().find((x) => x.checkOutDate)?.checkOutDate && [...r.sessions].reverse().find((x) => x.checkOutDate)!.checkOutDate !== r.date ? <span className="sub"> +1d</span> : null}</td>
                    <td className="num">{mins(r.workedMinutes)}{r.overtimeMinutes ? <div className="sub">+{mins(r.overtimeMinutes)} overtime</div> : null}</td>
                    <td>
                      {r.verification === 'manual-correction' ? <Chip tone="amber" icon={<Wrench size={13} />}>Manual</Chip> : null}
                      {r.corrected && r.verification === 'device-signature' ? <Chip tone="amber">Corrected</Chip> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {open ? (
        <Modal
          title={`${open.employeeName} · ${open.date}`}
          wide
          onClose={() => setOpen(null)}
          footer={
            <>
              <Button disabled={!canWrite} onClick={() => setFix({ op: 'add', employeeId: open.employeeId, date: open.date, kind: open.checkIn && !open.checkOut ? 'check-out' : 'check-in', time: '09:00', reason: '' })}><Plus size={14} /> Add record</Button>
              <Button variant="primary" onClick={() => setOpen(null)}>Close</Button>
            </>
          }
        >
          <div className="row wrap"><StatusChip status={open.status} classification={open.classification} early={open.earlyLeave} missing={open.missingCheckOut} overtime={open.overtimeStatus} approvalPending={open.approvalPending} /><span className="muted">{open.department}</span></div>
          <div className="table-wrap">
            <table className="t">
              <thead><tr><th>Date</th><th>Time</th><th>Event</th><th>Shift</th><th>Classification</th><th>Approval</th><th>Source</th><th>Device</th><th /></tr></thead>
              <tbody>
                {open.events.length === 0 ? <tr><td colSpan={9} className="muted">No attendance events on this day.</td></tr> : null}
                {open.events.map((e) => (
                  <tr key={e.id}>
                    <td className="num">{e.date}</td>
                    <td className="num">{e.local.slice(0, 8)}</td>
                    <td>{e.kind === 'check-in' ? 'Check-in' : 'Check-out'}</td>
                    <td>{e.shiftName ?? <span className="faint">—</span>}</td>
                    <td className={e.classification === 'early-leave' ? 'early-flag' : undefined}>{e.kind === 'check-in' && ['on-time', 'grace', 'late', 'very-late', 'off-day'].includes(e.classification) ? <><ClassChip value={e.classification} />{e.minutes && e.classification !== 'on-time' && e.classification !== 'off-day' ? <span className="sub"> {e.minutes} min</span> : null}</> : <>{e.classification}{e.minutes && e.classification !== 'normal' ? ` (${e.minutes} min)` : ''}</>}</td>
                    <td>{e.approval ? <><ApprovalChip status={e.approval.status} />{e.approval.decidedByName ? <div className="sub">{e.approval.decidedByName}{e.approval.reason ? ` — ${e.approval.reason}` : ''}</div> : null}</> : <span className="faint">—</span>}</td>
                    <td>{e.source === 'device' ? <Chip tone="mint">Phone signature</Chip> : <Chip tone="amber">Manual correction</Chip>}</td>
                    <td className="num">{e.deviceId ?? <span className="faint">—</span>}</td>
                    <td>
                      <div className="actions">
                        <Button size="sm" disabled={!canWrite} onClick={() => setFix({ op: 'amend', eventId: e.id, label: `${e.kind} at ${e.local.slice(0, 5)}`, date: e.date, time: e.local.slice(0, 5), reason: '' })}><Pencil size={13} /> Amend</Button>
                        <Button size="sm" variant="danger" disabled={!canWrite} onClick={() => setFix({ op: 'void', eventId: e.id, label: `${e.kind} at ${e.local.slice(0, 5)}`, reason: '' })}><Trash2 size={13} /> Void</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {open.approvals.length ? (
            <div>
              <b>Approvals</b>
              <div className="table-wrap" style={{ marginTop: 6 }}>
                <table className="t">
                  <thead><tr><th>Request</th><th>Scanned</th><th>Detail</th><th>Status</th><th>Decided by</th><th>Reason</th><th /></tr></thead>
                  <tbody>
                    {open.approvals.map((a: ApprovalView) => (
                      <tr key={a.eventId}>
                        <td>{approvalLabel(a)}</td>
                        <td className="num">{a.localDate} {a.localTime.slice(0, 5)}</td>
                        <td>{approvalDetail(a)}{a.status === 'approved' && a.kind === 'overtime' ? ` · ${mins(a.overtimeMinutes ?? 0)} overtime` : ''}</td>
                        <td><ApprovalChip status={a.status} /></td>
                        <td>{a.decidedByName ?? '—'}</td>
                        <td>{a.reason ?? '—'}</td>
                        <td>
                          {a.status === 'pending' ? (
                            <div className="actions">
                              <Button size="sm" variant="mint" disabled={!canWrite} onClick={() => setDecision({ row: a, decision: 'approve', reason: '' })}>Approve</Button>
                              <Button size="sm" variant="danger" disabled={!canWrite} onClick={() => setDecision({ row: a, decision: 'reject', reason: '' })}>Reject</Button>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
          {open.corrections.length ? (
            <div>
              <b>Correction history</b>
              <ul style={{ margin: '6px 0 0 18px', padding: 0 }} className="muted">{open.corrections.map((c, i) => <li key={i}>{c}</li>)}</ul>
            </div>
          ) : null}
          <div className="muted" style={{ fontSize: 12 }}>Corrections never overwrite the original event. They are appended as new, attributed records with your reason.</div>
        </Modal>
      ) : null}

      {decision ? <DecisionModal draft={decision} onChange={setDecision} onClose={() => setDecision(null)} onDone={() => { setDecision(null); load(); }} /> : null}

      {fix ? (
        <Modal
          title={fix.op === 'add' ? 'Add a missing record' : fix.op === 'amend' ? `Amend ${fix.label}` : `Void ${fix.label}`}
          onClose={() => setFix(null)}
          footer={
            <>
              <Button onClick={() => setFix(null)}>Cancel</Button>
              <Button variant={fix.op === 'void' ? 'danger' : 'primary'} loading={busy === 'fix'} disabled={fix.reason.trim().length < 5} onClick={() => void apply()}>
                {fix.op === 'void' ? 'Void record' : 'Save correction'}
              </Button>
            </>
          }
        >
          {fix.op === 'add' ? (
            <>
              <Field label="Employee">
                <select className="select" value={fix.employeeId} onChange={(e) => setFix({ ...fix, employeeId: e.target.value })}>
                  {emps.map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.id})</option>)}
                </select>
              </Field>
              <div className="row" style={{ alignItems: 'flex-end' }}>
                <div className="grow"><Field label="Type"><select className="select" value={fix.kind} onChange={(e) => setFix({ ...fix, kind: e.target.value as 'check-in' | 'check-out' })}><option value="check-in">Check-in</option><option value="check-out">Check-out</option></select></Field></div>
                <div className="grow"><Field label="Date"><input className="input" type="date" value={fix.date} onChange={(e) => setFix({ ...fix, date: e.target.value })} /></Field></div>
                <div className="grow"><Field label="Time (office time)"><input className="input" type="time" value={fix.time} onChange={(e) => setFix({ ...fix, time: e.target.value })} /></Field></div>
              </div>
            </>
          ) : null}
          {fix.op === 'amend' ? (
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <div className="grow"><Field label="Date"><input className="input" type="date" value={fix.date} onChange={(e) => setFix({ ...fix, date: e.target.value })} /></Field></div>
              <div className="grow"><Field label="Time (office time)"><input className="input" type="time" value={fix.time} onChange={(e) => setFix({ ...fix, time: e.target.value })} /></Field></div>
            </div>
          ) : null}
          {fix.op === 'void' ? <div className="muted">The original event stays in the log but stops counting toward attendance.</div> : null}
          <Field label="Reason (required, recorded in the audit log)" hint="At least 5 characters.">
            <textarea className="textarea" value={fix.reason} maxLength={300} onChange={(e) => setFix({ ...fix, reason: e.target.value })} autoFocus />
          </Field>
        </Modal>
      ) : null}
    </>
  );
}
