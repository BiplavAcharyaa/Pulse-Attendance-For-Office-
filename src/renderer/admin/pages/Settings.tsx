import { Archive, ArchiveRestore, DatabaseBackup, KeyRound, Save, ShieldCheck, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AdminRole, AdminView, CleanupPlan, CleanupResult, HostHealth, Settings } from '../../../shared/types';
import { useAuth } from '../api';
import { Banner, Button, Card, Chip, Field, Modal, useAction, useToast, when } from '../ui';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function SettingsPage() {
  const { call, can, auth } = useAuth();
  const { busy, run } = useAction();
  const toast = useToast();
  const [saved, setSaved] = useState<Settings | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [text, setText] = useState({ hostnames: '', cidrs: '' });
  const [health, setHealth] = useState<HostHealth | null>(null);
  const [nets, setNets] = useState<Array<{ name: string; address: string; virtual: boolean }>>([]);
  const [admins, setAdmins] = useState<AdminView[]>([]);
  const [newAdmin, setNewAdmin] = useState<{ username: string; displayName: string; role: AdminRole; password: string } | null>(null);
  const [pw, setPw] = useState<{ current: string; next: string } | null>(null);
  const [reset, setReset] = useState<{ admin: AdminView; password: string } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [arch, setArch] = useState<{ admin: AdminView; reason: string } | null>(null);
  const [plan, setPlan] = useState<CleanupPlan | null>(null);
  const [cleanResult, setCleanResult] = useState<CleanupResult | null>(null);

  const apply = (s: Settings) => {
    setSaved(s);
    setForm(s);
    setText({ hostnames: s.hostnames.join(', '), cidrs: s.allowedCidrs.join(', ') });
  };
  const load = useCallback(() => {
    call<Settings>('settings.get').then(apply).catch(() => undefined);
    call<HostHealth>('host.health').then(setHealth).catch(() => undefined);
    call<{ candidates: Array<{ name: string; address: string; virtual: boolean }> }>('host.network').then((n) => setNets(n.candidates)).catch(() => undefined);
    if (can('admins')) call<AdminView[]>('admins.list').then(setAdmins).catch(() => undefined);
  }, [call, can]);
  useEffect(load, [load]);

  if (!form || !saved) return <div className="muted">Loading…</div>;
  const canEdit = can('settings');
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setForm({ ...form, [k]: v });
  const num = (k: keyof Settings) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, (e.target.value === '' ? 0 : Number(e.target.value)) as never);
  const list = (s: string) => s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

  const patch = (): Partial<Settings> => {
    const { schemaVersion: _a, hostId: _b, ...rest } = form;
    void _a; void _b;
    return { ...rest, hostnames: list(text.hostnames), allowedCidrs: list(text.cidrs) };
  };
  const networkChanged = form.bindAddress !== saved.bindAddress || form.httpsPort !== saved.httpsPort || form.setupHttpPort !== saved.setupHttpPort || text.hostnames !== saved.hostnames.join(', ');
  const dirty = JSON.stringify(patch()) !== JSON.stringify({ ...(({ schemaVersion, hostId, ...r }) => (void schemaVersion, void hostId, r))(saved) });

  const save = async () => {
    const s = await run('save', () => call<Settings>('settings.update', patch()), networkChanged ? 'Settings saved — network changes apply after restarting PULSE' : 'Settings saved');
    if (s) { apply(s); load(); }
  };

  return (
    <div className="col" style={{ gap: 18 }}>
      {!canEdit ? <Banner tone="info" title="Read-only">Only the owner account can change settings.</Banner> : null}

      <Card title="Working hours & rules" sub="Used to classify check-ins as on time, grace or late when no shift is active. Each shift has its own grace period.">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))' }}>
          <Field label="Organisation name"><input className="input" disabled={!canEdit} value={form.orgName} maxLength={80} onChange={(e) => set('orgName', e.target.value)} /></Field>
          <Field label="Time zone" hint="IANA name, e.g. Asia/Kathmandu"><input className="input" disabled={!canEdit} value={form.timezone} onChange={(e) => set('timezone', e.target.value)} /></Field>
          <Field label="Work starts"><input className="input" type="time" disabled={!canEdit} value={form.workStart} onChange={(e) => set('workStart', e.target.value)} /></Field>
          <Field label="Work ends"><input className="input" type="time" disabled={!canEdit} value={form.workEnd} onChange={(e) => set('workEnd', e.target.value)} /></Field>
          <Field label="Grace period (minutes)"><input className="input" type="number" min={0} max={240} disabled={!canEdit} value={form.graceMinutes} onChange={num('graceMinutes')} /></Field>
          <Field label="Check-in opens (minutes before start)"><input className="input" type="number" min={0} max={720} disabled={!canEdit} value={form.earliestCheckInMinutes} onChange={num('earliestCheckInMinutes')} /></Field>
          <Field label="Minimum gap between scans (seconds)"><input className="input" type="number" min={0} max={3600} disabled={!canEdit} value={form.minIntervalSeconds} onChange={num('minIntervalSeconds')} /></Field>
        </div>
        <div style={{ height: 14 }} />
        <Field label="Working days">
          <div className="row wrap">
            {DAYS.map((d, i) => {
              const on = form.workDays.includes(i);
              return (
                <button key={d} type="button" className={`btn sm ${on ? 'primary' : ''}`} disabled={!canEdit} aria-pressed={on} onClick={() => set('workDays', on ? form.workDays.filter((x) => x !== i) : [...form.workDays, i].sort())}>{d}</button>
              );
            })}
          </div>
        </Field>
        <div className="row wrap" style={{ marginTop: 14, gap: 22 }}>
          <label className="row"><input type="checkbox" disabled={!canEdit} checked={form.allowMultipleSessions} onChange={(e) => set('allowMultipleSessions', e.target.checked)} /> Allow several check-in/out sessions per day</label>
          <label className="row"><input type="checkbox" disabled={!canEdit} checked={form.allowOffDayAttendance} onChange={(e) => set('allowOffDayAttendance', e.target.checked)} /> Accept attendance on non-working days</label>
        </div>
      </Card>

      <Card title="QR code timing & privacy">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))' }}>
          <Field label="QR rotation (seconds)"><input className="input" type="number" min={1} max={30} disabled={!canEdit} value={form.rotationSeconds} onChange={num('rotationSeconds')} /></Field>
          <Field label="Acceptance window (seconds)" hint="How long a rotated code still works after it is replaced on screen"><input className="input" type="number" min={3} max={60} disabled={!canEdit} value={form.acceptWindowSeconds} onChange={num('acceptWindowSeconds')} /></Field>
          <Field label="Registration QR validity (minutes)"><input className="input" type="number" min={1} max={60} disabled={!canEdit} value={form.registrationTokenMinutes} onChange={num('registrationTokenMinutes')} /></Field>
          <Field label="Admin idle timeout (minutes)"><input className="input" type="number" min={1} max={240} disabled={!canEdit} value={form.sessionIdleMinutes} onChange={num('sessionIdleMinutes')} /></Field>
        </div>
        <div className="row wrap" style={{ marginTop: 14, gap: 22 }}>
          <label className="row"><input type="checkbox" disabled={!canEdit} checked={form.terminalShowsNames} onChange={(e) => set('terminalShowsNames', e.target.checked)} /> Show employee names on the reception display</label>
          <label className="row"><input type="checkbox" disabled={!canEdit} checked={form.includePhoneInExports} onChange={(e) => set('includePhoneInExports', e.target.checked)} /> Include phone numbers in Excel exports</label>
        </div>
      </Card>

      <Card title="Network" sub="Phones connect to this PC over HTTPS on your office network">
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))' }}>
          <Field label="LAN address" hint="Leave on automatic unless the PC has several adapters">
            <select className="select" disabled={!canEdit} value={form.bindAddress} onChange={(e) => set('bindAddress', e.target.value)}>
              <option value="">Automatic{health ? ` (${health.lanAddress})` : ''}</option>
              {nets.map((n) => <option key={n.address} value={n.address}>{n.address} — {n.name}{n.virtual ? ' (virtual)' : ''}</option>)}
              {form.bindAddress && !nets.some((n) => n.address === form.bindAddress) ? <option value={form.bindAddress}>{form.bindAddress}</option> : null}
            </select>
          </Field>
          <Field label="HTTPS port (phones)"><input className="input" type="number" min={0} max={65535} disabled={!canEdit} value={form.httpsPort} onChange={num('httpsPort')} /></Field>
          <Field label="Certificate setup port (HTTP)" hint="Serves only the certificate download page"><input className="input" type="number" min={0} max={65535} disabled={!canEdit} value={form.setupHttpPort} onChange={num('setupHttpPort')} /></Field>
        </div>
        <div style={{ height: 14 }} />
        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
          <Field label="Extra host names for the certificate" hint="Comma-separated, e.g. pulse.office.local"><input className="input" disabled={!canEdit} value={text.hostnames} onChange={(e) => setText({ ...text, hostnames: e.target.value })} /></Field>
          <Field label="Allowed phone networks (CIDR)" hint="Phones outside these ranges are rejected"><input className="input mono" disabled={!canEdit} value={text.cidrs} onChange={(e) => setText({ ...text, cidrs: e.target.value })} /></Field>
        </div>
        {networkChanged ? <div style={{ marginTop: 12 }}><Banner tone="warn" title="Network changes apply after PULSE is restarted">Existing phone links stay valid if the address does not change. If the LAN address changes, re-trust the certificate on phones only if the host names change.</Banner></div> : null}
      </Card>

      <div className="row" style={{ position: 'sticky', bottom: 0, background: 'var(--bg)', padding: '10px 0', justifyContent: 'flex-end' }}>
        {dirty ? <span className="muted">Unsaved changes</span> : null}
        <Button onClick={() => apply(saved)} disabled={!dirty}>Discard</Button>
        <Button variant="primary" disabled={!canEdit || !dirty} loading={busy === 'save'} onClick={() => void save()}><Save size={15} /> Save settings</Button>
      </div>

      <Card title="Data & backups" sub={health?.storage.dataDir}>
        <div className="row wrap" style={{ gap: 12 }}>
          <Button disabled={!can('write')} loading={busy === 'backup'} onClick={() => void run('backup', async () => { const r = await call<{ dir: string; files: string[] }>('host.backup'); toast.ok(`Backup saved (${r.files.length} files) in ${r.dir}`); })}><DatabaseBackup size={15} /> Back up now</Button>
          <span className="muted">Automatic daily backups keep the 14 most recent. Copy the <span className="mono">backups</span> folder to another drive regularly.</span>
        </div>
        {health ? (
          <dl className="kv" style={{ marginTop: 16 }}>
            <dt>Free disk space</dt><dd>{health.storage.freeMB == null ? 'unknown' : `${health.storage.freeMB.toLocaleString()} MB`}</dd>
            <dt>Attendance events</dt><dd>{health.storage.attendanceEvents.toLocaleString()}</dd>
            <dt>Audit entries</dt><dd>{health.storage.auditEntries.toLocaleString()}</dd>
            <dt>Secret storage</dt><dd>{health.secretsProtection === 'os-protected' ? <Chip tone="mint" icon={<ShieldCheck size={13} />}>Protected by Windows</Chip> : <Chip tone="amber">File permissions only</Chip>}</dd>
          </dl>
        ) : null}
      </Card>

      {can('admins') ? (
        <Card title="Cleanup" sub="Archives obsolete test accounts and stale device records. A backup is taken first, and nothing is deleted.">
          <div className="row wrap" style={{ gap: 12 }}>
            <Button loading={busy === 'plan'} onClick={() => void run('plan', async () => { setCleanResult(null); setPlan(await call<CleanupPlan>('maintenance.plan')); })}><Archive size={15} /> Review cleanup</Button>
            {plan && plan.items.length ? <Button variant="primary" loading={busy === 'clean'} onClick={() => void run('clean', async () => { const r = await call<CleanupResult>('maintenance.apply'); setCleanResult(r); setPlan(null); load(); }, 'Cleanup finished')}>Back up and apply {plan.items.length} change{plan.items.length === 1 ? '' : 's'}</Button> : null}
          </div>
          {plan ? (
            <div style={{ marginTop: 14 }} className="col">
              {plan.items.length === 0 && plan.flagged.length === 0 ? <div className="muted">Nothing to clean up.</div> : null}
              {plan.items.length ? (
                <div className="table-wrap"><table className="t"><thead><tr><th>Will be archived</th><th>Reason</th></tr></thead><tbody>{plan.items.map((i) => <tr key={`${i.action}-${i.id}`}><td>{i.label}</td><td>{i.reason}</td></tr>)}</tbody></table></div>
              ) : null}
              {plan.flagged.length ? (
                <div className="table-wrap"><table className="t"><thead><tr><th>Needs your review (not changed)</th><th>Reason</th></tr></thead><tbody>{plan.flagged.map((f) => <tr key={`${f.kind}-${f.id}`}><td>{f.label}</td><td>{f.reason}</td></tr>)}</tbody></table></div>
              ) : null}
            </div>
          ) : null}
          {cleanResult ? (
            <div style={{ marginTop: 14 }} className="muted">
              {cleanResult.applied.length} archived or closed, {cleanResult.skipped.length} skipped, {cleanResult.flagged.length} flagged for review. {cleanResult.backupDir ? <>Backup: <span className="mono">{cleanResult.backupDir}</span></> : null}
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card title="Phone certificate" sub="Phones must trust this office certificate once so the camera can be used over HTTPS">
        {health ? (
          <dl className="kv">
            <dt>Phone address</dt><dd>{health.httpsUrl}</dd>
            <dt>Setup page</dt><dd>{health.setupUrl}</dd>
            <dt>CA fingerprint (SHA-256)</dt><dd className="mono">{health.tls.caFingerprint}</dd>
            <dt>Certificate expires</dt><dd>{when(health.tls.leafExpires)}</dd>
            <dt>Valid for</dt><dd>{health.tls.names.join(', ')}</dd>
          </dl>
        ) : null}
        <div className="muted" style={{ marginTop: 12 }}>Open the setup page on each phone, install the certificate, then follow the on-screen steps. The README explains Android and iPhone steps in detail.</div>
      </Card>

      <Card
        title="Administrator accounts"
        sub={`Signed in as ${auth?.admin.displayName} (${auth?.admin.role})`}
        action={<>
          {admins.some((a) => a.archivedAt) ? <Button onClick={() => setShowArchived(!showArchived)}><Archive size={15} /> {showArchived ? 'Hide' : 'Show'} archived</Button> : null}
          <Button onClick={() => setPw({ current: '', next: '' })}><KeyRound size={15} /> Change my password</Button>
          {can('admins') ? <Button variant="primary" onClick={() => setNewAdmin({ username: '', displayName: '', role: 'admin', password: '' })}><UserPlus size={15} /> Add admin</Button> : null}
        </>}
        pad={false}
      >
        {can('admins') ? (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0 }}>
            <table className="t">
              <thead><tr><th>Account</th><th>Role</th><th>Last sign-in</th><th>Status</th><th /></tr></thead>
              <tbody>
                {admins.filter((a) => showArchived || !a.archivedAt).map((a) => (
                  <tr key={a.id} style={a.archivedAt ? { opacity: 0.7 } : undefined}>
                    <td><div className="name">{a.displayName}</div><div className="sub">{a.username}</div></td>
                    <td><Chip tone={a.role === 'owner' ? 'navy' : a.role === 'admin' ? 'blue' : 'grey'}>{a.role}</Chip></td>
                    <td>{a.lastLoginAt ? when(a.lastLoginAt) : 'never'}</td>
                    <td>{a.archivedAt ? <Chip tone="grey" icon={<Archive size={13} />}>Archived</Chip> : a.disabled ? <Chip tone="rose">Disabled</Chip> : <Chip tone="mint">Active</Chip>}{a.archivedReason ? <div className="sub">{a.archivedReason}</div> : null}</td>
                    <td>
                      <div className="actions">
                        {a.archivedAt ? (
                          <Button size="sm" loading={busy === `r-${a.id}`} onClick={() => void run(`r-${a.id}`, async () => { await call('admins.restore', { id: a.id }); load(); }, 'Account restored (still disabled)')}><ArchiveRestore size={13} /> Restore</Button>
                        ) : (
                          <>
                            <Button size="sm" onClick={() => setReset({ admin: a, password: '' })}>Reset password</Button>
                            {a.role !== 'owner' && a.id !== auth?.admin.id ? <Button size="sm" onClick={() => setArch({ admin: a, reason: '' })}><Archive size={13} /> Archive</Button> : null}
                          </>
                        )}
                        {!a.archivedAt && a.id !== auth?.admin.id ? (
                          <Button size="sm" variant={a.disabled ? undefined : 'danger'} onClick={() => void run(`d-${a.id}`, async () => { await call('admins.setDisabled', { id: a.id, disabled: !a.disabled }); load(); }, a.disabled ? 'Account enabled' : 'Account disabled')}>{a.disabled ? 'Enable' : 'Disable'}</Button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="card-b muted">Only the owner can manage administrator accounts.</div>
        )}
      </Card>

      {newAdmin ? (
        <Modal title="Add administrator" onClose={() => setNewAdmin(null)} footer={<><Button onClick={() => setNewAdmin(null)}>Cancel</Button><Button variant="primary" loading={busy === 'newadmin'} onClick={async () => { const ok = await run('newadmin', () => call('admins.create', newAdmin), 'Administrator added'); if (ok) { setNewAdmin(null); load(); } }}>Create account</Button></>}>
          <Field label="Username"><input className="input" autoCapitalize="none" value={newAdmin.username} onChange={(e) => setNewAdmin({ ...newAdmin, username: e.target.value })} autoFocus /></Field>
          <Field label="Display name"><input className="input" value={newAdmin.displayName} onChange={(e) => setNewAdmin({ ...newAdmin, displayName: e.target.value })} /></Field>
          <Field label="Role" hint="Admin: manage people and attendance. Auditor: read and export only. Owner: everything including settings.">
            <select className="select" value={newAdmin.role} onChange={(e) => setNewAdmin({ ...newAdmin, role: e.target.value as AdminRole })}><option value="admin">Admin</option><option value="auditor">Auditor</option><option value="owner">Owner</option></select>
          </Field>
          <Field label="Initial password" hint="At least 12 characters with upper- and lower-case letters and a digit"><input className="input" type="password" autoComplete="new-password" value={newAdmin.password} onChange={(e) => setNewAdmin({ ...newAdmin, password: e.target.value })} /></Field>
        </Modal>
      ) : null}

      {pw ? (
        <Modal title="Change my password" onClose={() => setPw(null)} footer={<><Button onClick={() => setPw(null)}>Cancel</Button><Button variant="primary" loading={busy === 'pw'} onClick={async () => { const ok = await run('pw', () => call('auth.changePassword', pw), 'Password changed'); if (ok) setPw(null); }}>Change password</Button></>}>
          <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoFocus /></Field>
          <Field label="New password"><input className="input" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></Field>
        </Modal>
      ) : null}

      {arch ? (
        <Modal title={`Archive ${arch.admin.username}?`} onClose={() => setArch(null)} footer={<><Button onClick={() => setArch(null)}>Cancel</Button><Button variant="danger" loading={busy === 'arch'} disabled={arch.reason.trim().length < 3} onClick={async () => { const ok = await run('arch', () => call('admins.archive', { id: arch.admin.id, reason: arch.reason.trim() }), 'Account archived'); if (ok) { setArch(null); load(); } }}>Archive</Button></>}>
          <div className="muted">The account is disabled and hidden from this list. It is never deleted and can be restored at any time.</div>
          <Field label="Reason"><input className="input" value={arch.reason} maxLength={200} onChange={(e) => setArch({ ...arch, reason: e.target.value })} autoFocus /></Field>
        </Modal>
      ) : null}

      {reset ? (
        <Modal title={`Reset password — ${reset.admin.username}`} onClose={() => setReset(null)} footer={<><Button onClick={() => setReset(null)}>Cancel</Button><Button variant="primary" loading={busy === 'reset'} onClick={async () => { const ok = await run('reset', () => call('admins.resetPassword', { id: reset.admin.id, password: reset.password }), 'Password reset'); if (ok) setReset(null); }}>Reset</Button></>}>
          <Field label="New password"><input className="input" type="password" autoComplete="new-password" value={reset.password} onChange={(e) => setReset({ ...reset, password: e.target.value })} autoFocus /></Field>
        </Modal>
      ) : null}
    </div>
  );
}
