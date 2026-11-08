import { Archive, ArchiveRestore, Moon, Pencil, Plus, Power, Sun } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SHIFT_RULES } from '../../../shared/shiftRules';
import type { Shift } from '../../../shared/types';
import { useAuth, useRefreshOn } from '../api';
import { Banner, Button, Card, Chip, Empty, Field, Modal, useAction } from '../ui';

interface Form {
  id?: string;
  name: string;
  start: string;
  end: string;
  graceMinutes: number;
  checkInCloseMinutes: number;
  earlyCheckInMinutes: number;
  checkOutOpenMinutes: number;
  checkOutCloseMinutes: number;
  active: boolean;
}

const blank: Form = { name: '', start: '09:00', end: '17:00', active: true, ...DEFAULT_SHIFT_RULES };

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fmt = (m: number) => {
  const x = ((m % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
};

function Windows({ f }: { f: Pick<Form, 'start' | 'end' | 'graceMinutes' | 'checkInCloseMinutes' | 'earlyCheckInMinutes' | 'checkOutOpenMinutes' | 'checkOutCloseMinutes'> }) {
  const s = toMin(f.start);
  const e = toMin(f.end);
  const dur = e > s ? e - s : e + 1440 - s;
  const outOpen = Math.max(s, s + dur - f.checkOutOpenMinutes);
  return (
    <div className="sub" style={{ lineHeight: 1.6 }}>
      <div>Check-in {fmt(s - f.earlyCheckInMinutes)} · on time to {fmt(s)} · grace to {fmt(s + f.graceMinutes)} · late to {fmt(s + f.checkInCloseMinutes)} · then admin approval</div>
      <div>Check-out {fmt(outOpen)} · early leave before {fmt(e)} · on time to {fmt(e + f.checkOutCloseMinutes)} · then overtime approval</div>
    </div>
  );
}

const num = (v: string) => Math.max(0, Number(v) || 0);

export function ShiftsPage() {
  const { call, can } = useAuth();
  const { busy, run } = useAction();
  const [shifts, setShifts] = useState<Shift[] | null>(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState<Form | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [arch, setArch] = useState<{ shift: Shift; reason: string } | null>(null);

  const load = useCallback(() => {
    call<Shift[]>('shifts.list')
      .then((s) => { setShifts(s); setError(''); })
      .catch((e: Error) => setError(e.message));
  }, [call]);
  useEffect(load, [load]);
  useRefreshOn(['shifts.changed'], load);

  const canWrite = can('write');
  const overnight = form ? form.end <= form.start : false;
  const shown = (shifts ?? []).filter((s) => showArchived || !s.archivedAt);
  const archivedCount = (shifts ?? []).filter((s) => s.archivedAt).length;

  const save = async () => {
    if (!form) return;
    const { id, active, ...fields } = form;
    const ok = await run(
      'save',
      () => (id ? call('shifts.update', { id, patch: fields }) : call('shifts.create', { ...fields, active })),
      id ? 'Shift updated' : 'Shift created',
    );
    if (ok) { setForm(null); load(); }
  };

  const toggle = async (s: Shift) => {
    const ok = await run(`toggle-${s.id}`, () => call('shifts.setActive', { id: s.id, active: !s.active }), s.active ? 'Shift deactivated' : 'Shift activated');
    if (ok) load();
  };

  const field = (label: string, key: keyof Form, max: number) => (
    <div className="grow">
      <Field label={label}>
        <input className="input" type="number" min={0} max={max} value={form![key] as number} onChange={(e) => setForm({ ...form!, [key]: num(e.target.value) })} />
      </Field>
    </div>
  );

  return (
    <>
      <Card
        title="Shifts"
        sub="Employees are matched to a shift automatically from the check-in time. Attendance windows are calculated from each shift's own start and end."
        pad={false}
        action={
          <>
            {archivedCount ? <Button onClick={() => setShowArchived(!showArchived)}><Archive size={14} /> {showArchived ? 'Hide' : 'Show'} archived ({archivedCount})</Button> : null}
            {canWrite ? <Button variant="primary" onClick={() => setForm({ ...blank })}><Plus size={14} /> New shift</Button> : null}
          </>
        }
      >
        {error ? <div className="card-b" style={{ color: 'var(--rose-ink)' }}>{error}</div> : null}
        {!shifts ? (
          <div className="card-b muted">Loading…</div>
        ) : shown.length === 0 ? (
          <Empty icon={<Sun size={32} />} title="No shifts yet">Without active shifts, the single work-hours rule in Settings applies to everyone.</Empty>
        ) : (
          <div className="table-wrap" style={{ border: 0, borderRadius: 0, borderTop: '1px solid var(--border)' }}>
            <table className="t">
              <thead><tr><th>Shift</th><th>Time</th><th>Attendance windows</th><th>Status</th><th /></tr></thead>
              <tbody>
                {shown.map((s) => (
                  <tr key={s.id} style={s.archivedAt ? { opacity: 0.7 } : undefined}>
                    <td>
                      <div className="row">
                        {s.overnight ? <Moon size={16} /> : <Sun size={16} />}
                        <div><div className="name">{s.name}</div>{s.overnight ? <div className="sub">Ends the next day</div> : null}</div>
                      </div>
                    </td>
                    <td className="num">{s.start} – {s.end}</td>
                    <td><Windows f={s} /></td>
                    <td>
                      {s.archivedAt ? <Chip tone="grey" icon={<Archive size={13} />}>Archived</Chip> : s.active ? <Chip tone="mint">Active</Chip> : <Chip tone="grey">Inactive</Chip>}
                      {s.archivedReason ? <div className="sub">{s.archivedReason}</div> : null}
                    </td>
                    <td>
                      <div className="actions">
                        {s.archivedAt ? (
                          <Button size="sm" disabled={!canWrite} loading={busy === `restore-${s.id}`} onClick={() => void run(`restore-${s.id}`, async () => { await call('shifts.restore', { id: s.id }); load(); }, 'Shift restored (inactive)')}><ArchiveRestore size={13} /> Restore</Button>
                        ) : (
                          <>
                            <Button size="sm" disabled={!canWrite} onClick={() => setForm({ id: s.id, name: s.name, start: s.start, end: s.end, graceMinutes: s.graceMinutes, checkInCloseMinutes: s.checkInCloseMinutes, earlyCheckInMinutes: s.earlyCheckInMinutes, checkOutOpenMinutes: s.checkOutOpenMinutes, checkOutCloseMinutes: s.checkOutCloseMinutes, active: s.active })}><Pencil size={13} /> Edit</Button>
                            <Button size="sm" variant={s.active ? 'danger' : 'mint'} disabled={!canWrite} loading={busy === `toggle-${s.id}`} onClick={() => void toggle(s)}><Power size={13} /> {s.active ? 'Deactivate' : 'Activate'}</Button>
                            {!s.active ? <Button size="sm" disabled={!canWrite} onClick={() => setArch({ shift: s, reason: '' })}><Archive size={13} /> Archive</Button> : null}
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

      {form ? (
        <Modal
          title={form.id ? `Edit ${form.name || 'shift'}` : 'New shift'}
          onClose={() => setForm(null)}
          wide
          footer={
            <>
              <Button onClick={() => setForm(null)}>Cancel</Button>
              <Button variant="primary" loading={busy === 'save'} disabled={!form.name.trim() || form.start === form.end} onClick={() => void save()}>Save shift</Button>
            </>
          }
        >
          <Field label="Name"><input className="input" value={form.name} maxLength={60} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus /></Field>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <div className="grow"><Field label="Starts"><input className="input" type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></Field></div>
            <div className="grow"><Field label="Ends"><input className="input" type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></Field></div>
          </div>
          {overnight && form.start !== form.end ? <Banner tone="info" title="Overnight shift">This shift ends on the following day.</Banner> : null}
          <div className="row" style={{ alignItems: 'flex-end' }}>
            {field('Check-in opens (min before start)', 'earlyCheckInMinutes', 720)}
            {field('Grace period (min after start)', 'graceMinutes', 240)}
          </div>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            {field('Check-in closes (min after start)', 'checkInCloseMinutes', 720)}
            <div className="grow" />
          </div>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            {field('Check-out opens (min before end)', 'checkOutOpenMinutes', 720)}
            {field('Check-out closes (min after end)', 'checkOutCloseMinutes', 720)}
          </div>
          {form.start !== form.end ? <Windows f={form} /> : null}
          {!form.id ? (
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active
            </label>
          ) : null}
          <div className="muted" style={{ fontSize: 12 }}>Changes apply to future check-ins. Sessions already open keep the shift rules they were detected with.</div>
        </Modal>
      ) : null}

      {arch ? (
        <Modal
          title={`Archive ${arch.shift.name}?`}
          onClose={() => setArch(null)}
          footer={
            <>
              <Button onClick={() => setArch(null)}>Cancel</Button>
              <Button variant="danger" loading={busy === 'archive'} disabled={arch.reason.trim().length < 3} onClick={async () => { const ok = await run('archive', () => call('shifts.archive', { id: arch.shift.id, reason: arch.reason.trim() }), 'Shift archived'); if (ok) { setArch(null); load(); } }}>Archive</Button>
            </>
          }
        >
          <div className="muted">The shift is hidden from this list and can no longer be detected. It is never deleted: past attendance keeps its shift details and you can restore it at any time.</div>
          <Field label="Reason"><input className="input" value={arch.reason} maxLength={200} onChange={(e) => setArch({ ...arch, reason: e.target.value })} autoFocus /></Field>
        </Modal>
      ) : null}
    </>
  );
}
