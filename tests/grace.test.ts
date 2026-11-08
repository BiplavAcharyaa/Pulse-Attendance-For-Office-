import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { arrivalClass } from '../src/shared/shiftRules';
import type { AdminView, Device, Employee, Settings, Shift } from '../src/shared/types';
import { AttendanceService, type LogEventBody } from '../src/server/domain/attendance';
import { MaintenanceService } from '../src/server/domain/maintenance';
import { JsonlLog } from '../src/server/storage/jsonl';
import { defaultSettings } from '../src/server/schemas';

const T0 = Date.parse('2026-10-01T00:00:00Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function shift(over: Partial<Shift> = {}): Shift {
  return {
    id: 'shf_day',
    name: 'Morning',
    start: '06:00',
    end: '14:00',
    graceMinutes: 15,
    checkInCloseMinutes: 120,
    earlyCheckInMinutes: 60,
    checkOutOpenMinutes: 60,
    checkOutCloseMinutes: 60,
    active: true,
    overnight: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 't',
    updatedBy: 't',
    ...over,
  };
}

const emp = (id: string, name: string): Employee => ({ id, fullName: name, phone: '9800000000', department: 'Ops', status: 'active', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });

async function make(shifts: Shift[]) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-grace-'));
  const log = new JsonlLog<LogEventBody>(path.join(dir, 'events.jsonl'), Buffer.alloc(32, 7));
  await log.load();
  const clock = { t: T0 };
  const people = new Map<string, Employee>([['E1', emp('E1', 'Asha Rai')], ['E2', emp('E2', 'Bikash Gurung')]]);
  const employees = { require: (id: string) => people.get(id)!, get: (id: string) => people.get(id), list: () => [...people.values()] };
  const settings: Settings = { ...defaultSettings('testhost12'), timezone: 'UTC', workDays: [0, 1, 2, 3, 4, 5, 6], minIntervalSeconds: 0 };
  const audit = { record: async () => undefined };
  const clockGuard = { check() {}, suspect: false, flag() {} };
  const live: unknown[] = [];
  const svc = new AttendanceService(log, employees as never, () => settings, () => clock.t, audit as never, (e) => live.push(e), clockGuard as never, () => shifts);
  let n = 0;
  const scan = (id: string, intent: 'check-in' | 'check-out' | 'auto', at: number, key?: string) => {
    clock.t = at;
    return svc.record({ employeeId: id, deviceId: `dev_${id}`, intent, challengeId: `c${n++}`, remoteAddr: '127.0.0.1', idempotencyKey: key });
  };
  return { svc, log, clock, scan, shifts, live, dir };
}

const at = (day: number, hhmm: string, sec = 0) => {
  const [h, m] = hhmm.split(':').map(Number);
  return T0 + (day - 1) * DAY + h * HOUR + m * MIN + sec * 1000;
};

describe('classification boundaries', () => {
  const start = Date.parse('2026-10-01T06:00:00Z');
  it('splits on time, grace and late at exact boundaries', () => {
    expect(arrivalClass(start - 1000, start, 15)).toBe('on-time');
    expect(arrivalClass(start, start, 15)).toBe('on-time');
    expect(arrivalClass(start + 1000, start, 15)).toBe('grace');
    expect(arrivalClass(start + 15 * MIN, start, 15)).toBe('grace');
    expect(arrivalClass(start + 15 * MIN + 1000, start, 15)).toBe('late');
  });

  it('records the classification from the server clock and shift', async () => {
    const h = await make([shift()]);
    const cases: Array<[string, number, string]> = [
      ['E1', at(1, '05:59', 59), 'on-time'],
      ['E2', at(1, '06:15', 0), 'grace'],
    ];
    for (const [id, t, want] of cases) {
      const r = await h.scan(id, 'check-in', t);
      expect(r.event.classification).toBe(want);
    }
    const late = await h.scan('E1', 'check-out', at(1, '14:00')).then(() => h.scan('E1', 'check-in', at(2, '06:15', 1)));
    expect(late.event.classification).toBe('late');
  });

  it('keeps stored classification when the shift grace period changes later', async () => {
    const s = shift();
    const h = await make([s]);
    const r = await h.scan('E1', 'check-in', at(1, '06:10'));
    expect(r.event.classification).toBe('grace');
    s.graceMinutes = 0;
    const row = h.svc.range('2026-10-01', '2026-10-01', 'E1', at(1, '07:00'))[0];
    expect(row.classification).toBe('grace');
    expect(row.shifts[0].name).toBe('Morning');
    expect(row.employeeId).toBe('E1');
    expect(row.checkInLocal).toBe('06:10:00');
  });
});

describe('monthly warnings', () => {
  async function days(h: Awaited<ReturnType<typeof make>>, id: string, plan: Array<[number, string]>) {
    const out = [];
    for (const [day, hhmm] of plan) {
      out.push(await h.scan(id, 'check-in', at(day, hhmm)));
      await h.scan(id, 'check-out', at(day, '14:00'));
    }
    return out;
  }

  it('warns from the 4th grace and the 3rd late, and on check-out', async () => {
    const h = await make([shift()]);
    const r = await days(h, 'E1', [[1, '06:10'], [2, '06:10'], [3, '06:10'], [4, '06:10']]);
    expect(r[2].warning).toBeUndefined();
    expect(r[3].warning?.graceExceeded).toBe(true);
    expect(r[3].warning?.graceCount).toBe(4);
    expect(r[3].warning?.employeeName).toBe('Asha Rai');
    expect(r[3].warning?.employeeId).toBe('E1');

    const l = await days(h, 'E2', [[11, '06:30'], [12, '06:30'], [13, '06:30']]);
    expect(l[1].warning).toBeUndefined();
    expect(l[2].warning?.lateExceeded).toBe(true);
    expect(l[2].warning?.graceExceeded).toBe(false);

    const out = await h.scan('E2', 'check-in', at(15, '07:00'));
    expect(out.warning?.lateCount).toBe(4);
    const co = await h.scan('E2', 'check-out', at(15, '14:00'));
    expect(co.event.kind).toBe('check-out');
    expect(co.warning?.lateExceeded).toBe(true);
    expect(co.warning?.violations.length).toBe(1);
  });

  it('reports both violations together and reflects them in the monthly report', async () => {
    const h = await make([shift()]);
    await days(h, 'E1', [[1, '06:10'], [2, '06:10'], [3, '06:10'], [4, '06:10'], [5, '06:40'], [6, '06:40']]);
    const r = await h.scan('E1', 'check-in', at(7, '06:40'));
    expect(r.warning?.graceExceeded).toBe(true);
    expect(r.warning?.lateExceeded).toBe(true);
    expect(r.warning?.violations.length).toBe(2);
    const rep = h.svc.monthlyReport('2026-10');
    expect(rep.exceeding.map((x) => x.employeeId)).toEqual(['E1']);
    expect(rep.rows[0]).toMatchObject({ grace: 4, late: 3 });
  });

  it('does not inflate counts through duplicate scans, retries or concurrency', async () => {
    const h = await make([shift()]);
    const a = await h.scan('E1', 'check-in', at(1, '06:10'), 'idem-key-0001');
    const b = await h.scan('E1', 'check-in', at(1, '06:10', 30), 'idem-key-0001');
    expect(b.duplicate).toBe(true);
    expect(b.event.id).toBe(a.event.id);
    await expect(h.scan('E1', 'check-in', at(1, '06:11'))).rejects.toMatchObject({ code: 'ALREADY_CHECKED_IN' });
    expect(h.log.count).toBe(1);

    h.clock.t = at(2, '06:10');
    const results = await Promise.allSettled([0, 1, 2].map(() => h.svc.record({ employeeId: 'E2', deviceId: 'dev_E2', intent: 'check-in', challengeId: 'x', remoteAddr: '1' })));
    expect(results.filter((x) => x.status === 'fulfilled').length).toBe(1);
    expect(h.svc.monthlyReport('2026-10').rows.find((x) => x.employeeId === 'E2')?.grace).toBe(1);
  });

  it('counts a repeat check-in within the same shift once', async () => {
    const h = await make([shift()]);
    await h.scan('E1', 'check-in', at(1, '06:10'));
    await h.scan('E1', 'check-out', at(1, '13:30'));
    const rep = h.svc.monthlyReport('2026-10');
    expect(rep.rows[0].grace).toBe(1);
  });

  it('assigns overnight sessions to the shift start date across month boundaries', async () => {
    const night = shift({ id: 'shf_night', name: 'Night', start: '22:00', end: '06:00', overnight: true });
    const h = await make([night]);
    const jan31 = Date.parse('2026-10-31T22:10:00Z');
    h.clock.t = jan31;
    const inn = await h.scan('E1', 'check-in', jan31);
    expect(inn.event.classification).toBe('grace');
    expect(inn.event.workDate).toBe('2026-10-31');
    const outAt = Date.parse('2026-11-01T06:00:00Z');
    await h.scan('E1', 'check-out', outAt);
    expect(h.svc.monthlyReport('2026-10').rows[0].grace).toBe(1);
    expect(h.svc.monthlyReport('2026-11').rows.length).toBe(0);
  });

  it('keeps months separate', async () => {
    const h = await make([shift()]);
    await days(h, 'E1', [[1, '06:10'], [2, '06:10'], [3, '06:10']]);
    const nov = Date.parse('2026-11-02T06:10:00Z');
    const r = await h.scan('E1', 'check-in', nov);
    expect(r.warning).toBeUndefined();
    expect(h.svc.monthlyReport('2026-11').rows[0].grace).toBe(1);
  });
});

describe('cleanup safeguards', () => {
  const admin = (o: Partial<AdminView>): AdminView => ({ id: 'a', username: 'x', displayName: 'X', role: 'admin', createdAt: '2026-01-01T00:00:00Z', disabled: false, ...o });
  const dev = (o: Partial<Device & { employeeName?: string }>): Device & { employeeName?: string } => ({
    deviceId: 'dev_a', employeeId: 'E1', publicKey: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' }, label: '', userAgent: '', status: 'active', enrolledAt: '2026-01-01T00:00:00Z', approvedBy: 'o', requestId: 'r', ...o,
  });

  function build(admins: AdminView[], devices: Array<Device & { employeeName?: string }>, backupFails = false) {
    const calls: string[] = [];
    const svc = new MaintenanceService({
      admins: () => admins,
      devices: {
        listDevices: () => devices,
        listRequests: () => [],
        archive: async (id: string) => { calls.push(`archive-device:${id}`); },
        reject: async () => undefined,
      } as never,
      employees: { get: (id: string) => (id === 'E1' ? emp('E1', 'A') : undefined) } as never,
      audit: { record: async () => undefined } as never,
      now: () => Date.parse('2026-10-01T00:00:00Z'),
      lastDeviceUse: () => new Map([['dev_used', '2026-09-30T00:00:00Z']]),
      backup: async () => { if (backupFails) throw new Error('disk'); calls.push('backup'); return { dir: '/b' }; },
      archiveAdmin: async (id: string) => { calls.push(`archive-admin:${id}`); },
      purgeSessions: () => 0,
    });
    return { svc, calls };
  }

  it('archives only never-used test admins and stale revoked devices, flags the rest', async () => {
    const { svc, calls } = build(
      [
        admin({ id: 'own', username: 'test', role: 'owner' }),
        admin({ id: 't1', username: 'test1', disabled: true }),
        admin({ id: 't2', username: 'demo', lastLoginAt: '2026-02-01T00:00:00Z' }),
        admin({ id: 'real', username: 'priya', lastLoginAt: '2026-09-01T00:00:00Z' }),
        admin({ id: 'new', username: 'tmp', createdAt: '2026-09-30T00:00:00Z' }),
      ],
      [
        dev({ deviceId: 'dev_old', status: 'revoked', revokedAt: '2026-06-01T00:00:00Z' }),
        dev({ deviceId: 'dev_recent', status: 'revoked', revokedAt: '2026-09-25T00:00:00Z' }),
        dev({ deviceId: 'dev_used', status: 'active' }),
        dev({ deviceId: 'dev_dup1', employeeId: 'E1', status: 'active' }),
      ],
    );
    const plan = svc.plan();
    expect(plan.items.map((i) => i.id).sort()).toEqual(['dev_old', 't1']);
    expect(plan.flagged.map((f) => f.id)).toEqual(expect.arrayContaining(['t2', 'new', 'dev_used', 'dev_dup1']));
    expect(plan.items.some((i) => i.id === 'own' || i.id === 'real')).toBe(false);
    const res = await svc.apply('owner');
    expect(calls[0]).toBe('backup');
    expect(res.applied.length).toBe(2);
    expect(res.backupDir).toBe('/b');
  });

  it('changes nothing when the backup fails', async () => {
    const { svc, calls } = build([admin({ id: 't1', username: 'test1', disabled: true })], [], true);
    await expect(svc.apply('owner')).rejects.toMatchObject({ code: 'CLEANUP_ABORTED' });
    expect(calls).toEqual([]);
  });
});
