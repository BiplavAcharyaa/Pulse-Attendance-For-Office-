import { Check, ClipboardCheck, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ApprovalView } from '../../../shared/types';
import { useAuth, useRefreshOn } from '../api';
import { ApprovalChip, Banner, Button, Card, Chip, Empty, Field, Modal, initials, mins, useAction, when } from '../ui';

export interface DecisionDraft {
  row: ApprovalView;
  decision: 'approve' | 'reject';
  reason: string;
}

export function approvalLabel(a: ApprovalView): string {
  return a.kind === 'overtime' ? 'Overtime check-out' : 'Late check-in';
}

export function approvalDetail(a: ApprovalView): string {
  return a.kind === 'overtime' ? `${mins(a.minutes)} after shift end${a.shiftEnd ? ` (${a.shiftEnd})` : ''}` : `${mins(a.minutes)} after shift start${a.shiftStart ? ` (${a.shiftStart})` : ''}`;
}

export function DecisionModal({ draft, onChange, onClose, onDone }: { draft: DecisionDraft; onChange: (d: DecisionDraft) => void; onClose: () => void; onDone: () => void }) {
  const { call } = useAuth();
  const { busy, run } = useAction();
  const { row, decision, reason } = draft;
  const approve = decision === 'approve';
  const submit = async () => {
    const ok = await run('decide', () => call('approvals.decide', { eventId: row.eventId, decision, reason: reason.trim() }), approve ? 'Approved and recorded' : 'Rejected and recorded');
    if (ok) onDone();
  };
  return (
    <Modal
      title={`${approve ? 'Approve' : 'Reject'} ${approvalLabel(row).toLowerCase()}?`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={approve ? 'primary' : 'danger'} loading={busy === 'decide'} disabled={reason.trim().length < 5} onClick={() => void submit()}>
            {approve ? 'Approve' : 'Reject'}
          </Button>
        </>
      }
    >
      <dl className="kv">
        <dt>Employee</dt><dd>{row.employeeName} ({row.employeeId})</dd>
        <dt>Scan time</dt><dd>{row.localDate} {row.localTime.slice(0, 8)}</dd>
        <dt>Shift</dt><dd>{row.shiftName ?? '—'}{row.shiftStart ? ` · ${row.shiftStart}–${row.shiftEnd}` : ''}</dd>
        <dt>Detail</dt><dd>{approvalDetail(row)}</dd>
      </dl>
      <Banner tone="info" title={approve ? 'What approval does' : 'What rejection does'}>
        {row.kind === 'overtime'
          ? approve
            ? ' The actual check-out time is kept and the overtime hours are recorded.'
            : ' Worked hours are counted only up to the scheduled shift end.'
          : approve
            ? ' The check-in counts as attendance at the time it was scanned.'
            : ' No attendance is recorded for this shift and the employee cannot request it again.'}
      </Banner>
      <Field label="Reason (required, saved in the attendance log)" hint="At least 5 characters.">
        <textarea className="textarea" value={reason} maxLength={300} onChange={(e) => onChange({ ...draft, reason: e.target.value })} autoFocus />
      </Field>
    </Modal>
  );
}

export function ApprovalsPage() {
  const { call, can } = useAuth();
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [rows, setRows] = useState<ApprovalView[] | null>(null);
  const [draft, setDraft] = useState<DecisionDraft | null>(null);

  const load = useCallback(() => {
    call<ApprovalView[]>('approvals.list', { status }).then(setRows).catch(() => undefined);
  }, [call, status]);
  useEffect(load, [load]);
  useRefreshOn(['approval.requested', 'approval.decided', 'correction.saved'], load);

  const canWrite = can('write');
  return (
    <>
      <Card
        title="Approvals"
        sub="Check-ins after the window closed and check-outs after the overtime cut-off need an administrator's decision"
        pad={false}
        action={
          <div className="tabs" role="tablist">
            {(['pending', 'approved', 'rejected'] as const).map((s) => (
              <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
                {s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        }
      >
        {!rows ? (
          <div className="card-b muted">Loading…</div>
        ) : rows.length === 0 ? (
          <Empty icon={<ClipboardCheck size={32} />} title={status === 'pending' ? 'Nothing is waiting' : `No ${status} requests`} />
        ) : (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="t">
              <thead><tr><th>Employee</th><th>Request</th><th>Shift</th><th>Scanned</th><th>Detail</th><th>Decision</th><th /></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.eventId}>
                    <td>
                      <div className="row">
                        <span className="avatar" style={{ background: 'var(--blue-soft)', color: 'var(--blue)' }}>{initials(r.employeeName)}</span>
                        <div><div className="name">{r.employeeName}</div><div className="sub">{r.employeeId}</div></div>
                      </div>
                    </td>
                    <td><Chip tone={r.kind === 'overtime' ? 'blue' : 'amber'}>{approvalLabel(r)}</Chip></td>
                    <td>{r.shiftName ?? '—'}<div className="sub">{r.shiftStart ? `${r.shiftStart}–${r.shiftEnd}` : ''} · {r.workDate}</div></td>
                    <td className="num">{r.localDate} {r.localTime.slice(0, 5)}<div className="sub">requested {when(r.requestedAt)}</div></td>
                    <td>{approvalDetail(r)}</td>
                    <td>
                      <ApprovalChip status={r.status} />
                      {r.status !== 'pending' ? (
                        <div className="sub">
                          {r.decidedByName ?? '—'} · {when(r.decidedAt)}
                          {r.reason ? ` — ${r.reason}` : ''}
                          {r.kind === 'overtime' && r.status === 'approved' ? ` · ${mins(r.overtimeMinutes ?? 0)} overtime` : ''}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {r.status === 'pending' ? (
                        <div className="actions">
                          <Button size="sm" variant="mint" disabled={!canWrite} onClick={() => setDraft({ row: r, decision: 'approve', reason: '' })}><Check size={14} /> Approve</Button>
                          <Button size="sm" variant="danger" disabled={!canWrite} onClick={() => setDraft({ row: r, decision: 'reject', reason: '' })}><X size={14} /> Reject</Button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {draft ? <DecisionModal draft={draft} onChange={setDraft} onClose={() => setDraft(null)} onDone={() => { setDraft(null); load(); }} /> : null}
    </>
  );
}
