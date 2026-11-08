import { Archive, ArchiveRestore, Ban, Check, Inbox, KeyRound, Pencil, Plus, Smartphone, Upload, UserCheck, UserPlus, UserX, Users, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Device, Employee, RegistrationRequestView, TerminalQr } from '../../../shared/types';
import { useAuth, useLive, useRefreshOn } from '../api';
import { QrFrame, Countdown } from '../QrView';
import { Banner, Button, Card, Chip, Empty, Field, Modal, SearchBox, ago, initials, useAction, useToast, when } from '../ui';

const FLAG_TEXT: Record<string, string> = {
  'name-mismatch': 'Name differs from the employee record',
  'phone-mismatch': 'Phone number differs from the employee record',
  'new-employee': 'Employee ID is not in the directory — approving creates the employee',
};
const flagText = (f: string) => FLAG_TEXT[f] ?? f;

// ───────────────────────── Requests ─────────────────────────
export function RequestsPage() {
  const { call, can } = useAuth();
  const { busy, run } = useAction();
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [rows, setRows] = useState<RegistrationRequestView[] | null>(null);
  const [reject, setReject] = useState<RegistrationRequestView | null>(null);
  const [approve, setApprove] = useState<RegistrationRequestView | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    call<RegistrationRequestView[]>('requests.list', { status }).then(setRows).catch(() => undefined);
  }, [call, status]);
  useEffect(load, [load]);
  useRefreshOn(['request.created', 'request.decided'], load);

  const canWrite = can('write');
  const doApprove = async (r: RegistrationRequestView) => {
    const ok = await run(r.requestId, () => call('requests.approve', { requestId: r.requestId }), `${r.fullName}'s phone was approved`);
    if (ok) {
      setApprove(null);
      load();
    }
  };

  return (
    <>
      <Card
        title="Registration requests"
        sub="Phones waiting for an administrator's decision"
        action={
          <div className="tabs" role="tablist">
            {(['pending', 'approved', 'rejected'] as const).map((s) => (
              <button key={s} className={status === s ? 'on' : ''} onClick={() => setStatus(s)}>
                {s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        }
        pad={false}
      >
        {!rows ? (
          <div className="card-b muted">Loading…</div>
        ) : rows.length === 0 ? (
          <Empty icon={<Inbox size={32} />} title={status === 'pending' ? 'No phones are waiting' : `No ${status} requests`}>
            {status === 'pending' ? 'Show the registration QR on the Terminal page so an employee can enroll their phone.' : null}
          </Empty>
        ) : (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="t">
              <thead>
                <tr><th>Employee</th><th>Type</th><th>Phone</th><th>Submitted</th><th>Checks</th><th /></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.requestId}>
                    <td>
                      <div className="name">{r.fullName}</div>
                      <div className="sub">{r.employeeId}</div>
                    </td>
                    <td>{r.type === 'replacement' ? <Chip tone="blue">Replacement</Chip> : <Chip tone="grey">New phone</Chip>}</td>
                    <td>
                      <div>{r.phone}</div>
                      <div className="sub" title={r.userAgent}>{r.userAgent.slice(0, 40)}</div>
                    </td>
                    <td>
                      <div>{when(r.createdAt)}</div>
                      <div className="sub">{r.remoteAddr}</div>
                    </td>
                    <td>
                      {r.flags.length === 0 ? <Chip tone="mint">No issues</Chip> : <span className="row wrap" style={{ gap: 4 }}>{r.flags.map((f) => <span key={f} className="flag" title={flagText(f)}>{f}</span>)}</span>}
                      {r.status !== 'pending' ? <div className="sub">{r.status} by {r.decidedBy ?? '—'}{r.decisionReason ? ` — ${r.decisionReason}` : ''}</div> : null}
                    </td>
                    <td>
                      {r.status === 'pending' ? (
                        <div className="actions">
                          <Button size="sm" variant="mint" disabled={!canWrite} loading={busy === r.requestId} onClick={() => (r.flags.length ? setApprove(r) : void doApprove(r))}>
                            <Check size={14} /> Approve
                          </Button>
                          <Button size="sm" variant="danger" disabled={!canWrite} onClick={() => { setReason(''); setReject(r); }}>
                            <X size={14} /> Reject
                          </Button>
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

      {approve ? (
        <Modal
          title="Review before approving"
          onClose={() => setApprove(null)}
          footer={
            <>
              <Button onClick={() => setApprove(null)}>Cancel</Button>
              <Button variant="primary" loading={busy === approve.requestId} onClick={() => void doApprove(approve)}>Approve anyway</Button>
            </>
          }
        >
          <Banner tone="warn" title="This request has warnings">
            <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>{approve.flags.map((f) => <li key={f}>{flagText(f)}</li>)}</ul>
          </Banner>
          <dl className="kv">
            <dt>Name</dt><dd>{approve.fullName}</dd>
            <dt>Employee ID</dt><dd>{approve.employeeId}</dd>
            <dt>Phone</dt><dd>{approve.phone}</dd>
            <dt>Source</dt><dd>{approve.remoteAddr}</dd>
          </dl>
          <div className="muted">Only approve if you have confirmed in person that this phone belongs to this employee.</div>
        </Modal>
      ) : null}

      {reject ? (
        <Modal
          title={`Reject ${reject.fullName}?`}
          onClose={() => setReject(null)}
          footer={
            <>
              <Button onClick={() => setReject(null)}>Cancel</Button>
              <Button
                variant="danger"
                loading={busy === 'reject'}
                onClick={async () => {
                  const ok = await run('reject', () => call('requests.reject', { requestId: reject.requestId, reason: reason.trim() || 'Rejected by administrator' }), 'Request rejected');
                  if (ok) { setReject(null); load(); }
                }}
              >
                Reject request
              </Button>
            </>
          }
        >
          <Field label="Reason (shown to the employee)">
            <input className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Field>
        </Modal>
      ) : null}
    </>
  );
}

// ───────────────────────── Employees ─────────────────────────
type EmployeeRow = Employee & {
  device: { deviceId: string; label: string; enrolledAt: string; lastSeenAt?: string } | null;
  pendingRequest: boolean;
};

export function EmployeesPage() {
  const { call, can } = useAuth();
  const { busy, run } = useAction();
  const toast = useToast();
  const live = useLive();
  const [rows, setRows] = useState<EmployeeRow[] | null>(null);
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<Partial<Employee> & { isNew?: boolean } | null>(null);
  const [off, setOff] = useState<EmployeeRow | null>(null);
  const [offReason, setOffReason] = useState('');
  const [csv, setCsv] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [arch, setArch] = useState<{ emp: EmployeeRow; reason: string } | null>(null);
  const [replace, setReplace] = useState<{ emp: EmployeeRow; qr: TerminalQr } | null>(null);

  const load = useCallback(() => {
    call<EmployeeRow[]>('employees.list').then(setRows).catch(() => undefined);
  }, [call]);
  useEffect(load, [load]);
  useRefreshOn(['employee.changed', 'device.changed', 'request.created', 'request.decided'], load);

  const canWrite = can('write');
  const shown = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return (rows ?? []).filter((r) => (showArchived || !r.archivedAt) && (!kw || `${r.fullName} ${r.id} ${r.department} ${r.phone}`.toLowerCase().includes(kw)));
  }, [rows, q, showArchived]);

  // Close the replacement-QR dialog automatically once the new phone has been submitted.
  useRefreshOn(['request.created'], () => {
    if (replace) setReplace(null);
  });

  const save = async () => {
    if (!edit) return;
    const body = { fullName: edit.fullName ?? '', phone: edit.phone ?? '', department: edit.department ?? '' };
    const ok = await run(
      'save',
      () => (edit.isNew ? call('employees.create', { id: edit.id ?? '', ...body }) : call('employees.update', { id: edit.id, patch: body })),
      edit.isNew ? 'Employee added' : 'Employee updated',
    );
    if (ok) { setEdit(null); load(); }
  };

  const importCsv = async () => {
    if (csv == null) return;
    const r = await run('csv', () => call<{ created: number; skipped: Array<{ line: number; reason: string }> }>('employees.import', { csv }));
    if (r) {
      setCsv(null);
      load();
      if (r.skipped.length) toast.err(`Imported ${r.created}; skipped ${r.skipped.length}: ${r.skipped.slice(0, 3).map((s) => `line ${s.line} (${s.reason})`).join('; ')}`);
      else toast.ok(`Imported ${r.created} employees`);
    }
  };

  return (
    <>
      <Card
        title="Employees"
        sub={rows ? `${rows.filter((r) => r.status === 'active').length} active of ${rows.length}${rows.some((r) => r.archivedAt) ? ` · ${rows.filter((r) => r.archivedAt).length} archived` : ''}` : ''}
        action={
          <>
            <div style={{ width: 220 }}><SearchBox value={q} onChange={setQ} placeholder="Search employees" /></div>
            {rows?.some((r) => r.archivedAt) ? <Button onClick={() => setShowArchived(!showArchived)}><Archive size={15} /> {showArchived ? 'Hide' : 'Show'} archived</Button> : null}
            <Button disabled={!canWrite} onClick={() => setCsv('')}><Upload size={15} /> Import CSV</Button>
            <Button variant="primary" disabled={!canWrite} onClick={() => setEdit({ isNew: true, id: '', fullName: '', phone: '', department: '' })}>
              <UserPlus size={15} /> Add employee
            </Button>
          </>
        }
        pad={false}
      >
        {!rows ? (
          <div className="card-b muted">Loading…</div>
        ) : rows.length === 0 ? (
          <Empty icon={<Users size={32} />} title="No employees yet">Add employees one by one or import a CSV (ID, name, phone, department).</Empty>
        ) : (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0, maxHeight: 640 }}>
            <table className="t">
              <thead><tr><th>Employee</th><th>Phone number</th><th>Status</th><th>Registered phone</th><th /></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id} style={r.status === 'inactive' || r.archivedAt ? { opacity: 0.7 } : undefined}>
                    <td>
                      <div className="row">
                        <span className="avatar" style={{ background: 'var(--blue-soft)', color: 'var(--blue)' }}>{initials(r.fullName)}</span>
                        <div><div className="name">{r.fullName}</div><div className="sub">{r.id}{r.department ? ` · ${r.department}` : ''}</div></div>
                      </div>
                    </td>
                    <td>{r.phone}</td>
                    <td>
                      {r.archivedAt ? <Chip tone="grey" icon={<Archive size={13} />}>Archived</Chip> : r.status === 'active' ? <Chip tone="mint">Active</Chip> : <Chip tone="grey">Inactive</Chip>}
                      {r.archivedAt ? <div className="sub">{r.archivedReason}</div> : r.deactivatedReason ? <div className="sub">{r.deactivatedReason}</div> : null}
                    </td>
                    <td>
                      {r.device ? (
                        <div><Chip tone="blue" icon={<Smartphone size={13} />}>Enrolled</Chip><div className="sub">last seen {ago(r.device.lastSeenAt)}</div></div>
                      ) : r.pendingRequest ? (
                        <Chip tone="amber">Awaiting approval</Chip>
                      ) : (
                        <Chip tone="grey">No phone</Chip>
                      )}
                    </td>
                    <td>
                      <div className="actions">
                        {r.archivedAt ? (
                          <Button size="sm" disabled={!canWrite} loading={busy === `unarch-${r.id}`} onClick={() => void run(`unarch-${r.id}`, async () => { await call('employees.restore', { id: r.id }); load(); }, `${r.fullName} restored (inactive)`)}><ArchiveRestore size={13} /> Restore</Button>
                        ) : (
                        <>
                        <Button size="sm" disabled={!canWrite} onClick={() => setEdit({ ...r })} aria-label={`Edit ${r.fullName}`}><Pencil size={13} /> Edit</Button>
                        {r.status === 'active' ? (
                          <>
                            <Button
                              size="sm"
                              disabled={!canWrite}
                              loading={busy === `rep-${r.id}`}
                              title="Issue a one-time QR so this employee can enroll a replacement phone"
                              onClick={async () => {
                                const qr = await run(`rep-${r.id}`, () => call<TerminalQr>('devices.issueReplacement', { employeeId: r.id }));
                                if (qr) setReplace({ emp: r, qr });
                              }}
                            >
                              <KeyRound size={13} /> {r.device ? 'Replace phone' : 'Enroll phone'}
                            </Button>
                            <Button size="sm" variant="danger" disabled={!canWrite} onClick={() => { setOffReason(''); setOff(r); }}><UserX size={13} /> Deactivate</Button>
                          </>
                        ) : (
                          <Button size="sm" disabled={!canWrite} loading={busy === `re-${r.id}`} onClick={() => void run(`re-${r.id}`, async () => { await call('employees.reactivate', { id: r.id }); load(); }, `${r.fullName} reactivated`)}>
                            <UserCheck size={13} /> Reactivate
                          </Button>
                        )}
                        {r.status !== 'active' ? <Button size="sm" disabled={!canWrite} onClick={() => setArch({ emp: r, reason: '' })}><Archive size={13} /> Archive</Button> : null}
                        </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {edit ? (
        <Modal
          title={edit.isNew ? 'Add employee' : `Edit ${edit.fullName}`}
          onClose={() => setEdit(null)}
          footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" loading={busy === 'save'} onClick={() => void save()}><Plus size={14} /> {edit.isNew ? 'Add' : 'Save'}</Button></>}
        >
          <Field label="Employee ID" hint={edit.isNew ? 'Letters, digits, “-” or “_”. Cannot be changed later.' : undefined}>
            <input className="input" value={edit.id ?? ''} disabled={!edit.isNew} maxLength={32} onChange={(e) => setEdit({ ...edit, id: e.target.value })} autoFocus={edit.isNew} />
          </Field>
          <Field label="Full name"><input className="input" value={edit.fullName ?? ''} maxLength={80} onChange={(e) => setEdit({ ...edit, fullName: e.target.value })} /></Field>
          <Field label="Phone number"><input className="input" inputMode="tel" value={edit.phone ?? ''} maxLength={24} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
          <Field label="Department"><input className="input" value={edit.department ?? ''} maxLength={60} onChange={(e) => setEdit({ ...edit, department: e.target.value })} /></Field>
        </Modal>
      ) : null}

      {off ? (
        <Modal
          title={`Deactivate ${off.fullName}?`}
          onClose={() => setOff(null)}
          footer={
            <>
              <Button onClick={() => setOff(null)}>Cancel</Button>
              <Button
                variant="danger"
                loading={busy === 'off'}
                onClick={async () => {
                  const ok = await run('off', () => call('employees.deactivate', { id: off.id, reason: offReason.trim() || 'Deactivated by administrator' }), 'Employee deactivated');
                  if (ok) { setOff(null); load(); }
                }}
              >
                Deactivate
              </Button>
            </>
          }
        >
          <div className="muted">Their phone will stop being accepted immediately. Past attendance records are kept untouched.</div>
          <Field label="Reason"><input className="input" value={offReason} maxLength={200} onChange={(e) => setOffReason(e.target.value)} autoFocus /></Field>
        </Modal>
      ) : null}

      {arch ? (
        <Modal
          title={`Archive ${arch.emp.fullName}?`}
          onClose={() => setArch(null)}
          footer={
            <>
              <Button onClick={() => setArch(null)}>Cancel</Button>
              <Button variant="danger" loading={busy === 'arch'} disabled={arch.reason.trim().length < 3} onClick={async () => { const ok = await run('arch', () => call('employees.archive', { id: arch.emp.id, reason: arch.reason.trim() }), 'Employee archived'); if (ok) { setArch(null); load(); } }}>Archive</Button>
            </>
          }
        >
          <div className="muted">The record is hidden from the directory but never deleted. Attendance history, phones and audit entries stay intact, and you can restore the employee at any time.</div>
          <Field label="Reason"><input className="input" value={arch.reason} maxLength={200} onChange={(e) => setArch({ ...arch, reason: e.target.value })} autoFocus /></Field>
        </Modal>
      ) : null}

      {csv != null ? (
        <Modal
          title="Import employees from CSV"
          wide
          onClose={() => setCsv(null)}
          footer={<><Button onClick={() => setCsv(null)}>Cancel</Button><Button variant="primary" loading={busy === 'csv'} disabled={!csv.trim()} onClick={() => void importCsv()}><Upload size={14} /> Import</Button></>}
        >
          <div className="muted">One employee per line: <span className="mono">employeeId, full name, phone, department</span>. A header row is optional. Existing IDs are skipped.</div>
          <textarea className="textarea mono" style={{ minHeight: 200 }} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'E-1001, Asha Rai, 9800000001, Sales\nE-1002, Bikash Thapa, 9800000002, Operations'} />
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-label="Choose a CSV file"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f && f.size < 400_000) setCsv(await f.text());
            }}
          />
        </Modal>
      ) : null}

      {replace ? (
        <Modal title={`${replace.emp.device ? 'Replacement phone' : 'Enroll phone'} — ${replace.emp.fullName}`} onClose={() => setReplace(null)} footer={<Button onClick={() => setReplace(null)}>Done</Button>}>
          <Banner tone="info" title="One-time code for this employee only">
            Ask {replace.emp.fullName.split(' ')[0]} to scan this with the new phone’s camera. The request will appear under Requests and must still be approved.
            {replace.emp.device ? ' The old phone keeps working until you approve the new one, which then revokes it.' : ''}
          </Banner>
          <div style={{ display: 'grid', placeItems: 'center', gap: 12 }}>
            <QrFrame text={replace.qr.url} label="One-time enrollment QR code" />
            <Countdown qr={replace.qr} skew={live.skew} />
          </div>
        </Modal>
      ) : null}
    </>
  );
}

// ───────────────────────── Devices ─────────────────────────
type DeviceView = Omit<Device, 'publicKey'>;

export function DevicesPage() {
  const { call, can } = useAuth();
  const { busy, run } = useAction();
  const [devices, setDevices] = useState<DeviceView[] | null>(null);
  const [emps, setEmps] = useState<Record<string, string>>({});
  const [q, setQ] = useState('');
  const [rev, setRev] = useState<DeviceView | null>(null);
  const [reason, setReason] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [archDev, setArchDev] = useState<{ dev: DeviceView; reason: string } | null>(null);

  const load = useCallback(() => {
    call<DeviceView[]>('devices.list').then(setDevices).catch(() => undefined);
    call<Employee[]>('employees.list').then((l) => setEmps(Object.fromEntries(l.map((e) => [e.id, e.fullName])))).catch(() => undefined);
  }, [call]);
  useEffect(load, [load]);
  useRefreshOn(['device.changed', 'employee.changed', 'archive.changed'], load);

  const shown = (devices ?? []).filter((d) => {
    const kw = q.trim().toLowerCase();
    return (showArchived || !d.archivedAt) && (!kw || `${d.employeeId} ${emps[d.employeeId] ?? ''} ${d.label} ${d.deviceId}`.toLowerCase().includes(kw));
  });

  return (
    <>
      <Card title="Registered phones" sub="Each phone holds its own private key; only the public key is stored here" action={<>{devices?.some((d) => d.archivedAt) ? <Button onClick={() => setShowArchived(!showArchived)}><Archive size={15} /> {showArchived ? 'Hide' : 'Show'} archived</Button> : null}<div style={{ width: 220 }}><SearchBox value={q} onChange={setQ} placeholder="Search devices" /></div></>} pad={false}>
        {!devices ? (
          <div className="card-b muted">Loading…</div>
        ) : devices.length === 0 ? (
          <Empty icon={<Smartphone size={32} />} title="No phones registered yet">Approved phones appear here.</Empty>
        ) : (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="t">
              <thead><tr><th>Employee</th><th>Device</th><th>Enrolled</th><th>Last seen</th><th>Status</th><th /></tr></thead>
              <tbody>
                {shown.map((d) => (
                  <tr key={d.deviceId}>
                    <td><div className="name">{emps[d.employeeId] ?? d.employeeId}</div><div className="sub">{d.employeeId}</div></td>
                    <td><div>{d.label}</div><div className="sub mono" title={d.deviceId}>{d.deviceId.slice(0, 16)}…</div></td>
                    <td><div>{when(d.enrolledAt)}</div><div className="sub">approved by {d.approvedBy}</div></td>
                    <td>{ago(d.lastSeenAt)}</td>
                    <td>
                      {d.archivedAt ? <Chip tone="grey" icon={<Archive size={13} />}>Archived</Chip> : d.status === 'active' ? <Chip tone="mint">Active</Chip> : <Chip tone="rose">Revoked</Chip>}
                      {d.archivedAt ? <div className="sub">{d.archivedReason}</div> : d.revokedReason ? <div className="sub">{d.revokedReason}</div> : null}
                    </td>
                    <td>
                      {d.status === 'active' ? (
                        <div className="actions"><Button size="sm" variant="danger" disabled={!can('write')} onClick={() => { setReason(''); setRev(d); }}><Ban size={13} /> Revoke</Button></div>
                      ) : d.archivedAt ? (
                        <div className="actions"><Button size="sm" disabled={!can('write')} onClick={() => void run(`unarch-${d.deviceId}`, async () => { await call('devices.restore', { deviceId: d.deviceId }); load(); }, 'Phone restored (still revoked)')}><ArchiveRestore size={13} /> Restore</Button></div>
                      ) : (
                        <div className="actions"><Button size="sm" disabled={!can('write')} onClick={() => setArchDev({ dev: d, reason: '' })}><Archive size={13} /> Archive</Button></div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {archDev ? (
        <Modal
          title="Archive this phone?"
          onClose={() => setArchDev(null)}
          footer={
            <>
              <Button onClick={() => setArchDev(null)}>Cancel</Button>
              <Button variant="danger" loading={busy === 'archdev'} disabled={archDev.reason.trim().length < 3} onClick={async () => { const ok = await run('archdev', () => call('devices.archive', { deviceId: archDev.dev.deviceId, reason: archDev.reason.trim() }), 'Phone archived'); if (ok) { setArchDev(null); load(); } }}>Archive</Button>
            </>
          }
        >
          <div className="muted">The revoked phone is hidden from this list but its record is kept for the audit trail.</div>
          <Field label="Reason"><input className="input" value={archDev.reason} maxLength={200} onChange={(e) => setArchDev({ ...archDev, reason: e.target.value })} autoFocus /></Field>
        </Modal>
      ) : null}
      {rev ? (
        <Modal
          title="Revoke this phone?"
          onClose={() => setRev(null)}
          footer={
            <>
              <Button onClick={() => setRev(null)}>Cancel</Button>
              <Button
                variant="danger"
                loading={busy === 'rev'}
                onClick={async () => {
                  const ok = await run('rev', () => call('devices.revoke', { deviceId: rev.deviceId, reason: reason.trim() || 'Revoked by administrator' }), 'Phone revoked');
                  if (ok) { setRev(null); load(); }
                }}
              >
                Revoke phone
              </Button>
            </>
          }
        >
          <div className="muted">{emps[rev.employeeId] ?? rev.employeeId}’s phone will be rejected immediately — use this for lost or stolen phones. The employee can enroll a replacement from the Employees page.</div>
          <Field label="Reason"><input className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Phone lost" autoFocus /></Field>
        </Modal>
      ) : null}
    </>
  );
}
