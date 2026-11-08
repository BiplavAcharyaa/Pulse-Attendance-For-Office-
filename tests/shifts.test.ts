import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Shift } from '../src/shared/types';
import { detectShift } from '../src/server/domain/shifts';
import { enroll, must, request, startHost, type Phone, type TestHost } from './helpers';

const hosts: TestHost[] = [];
const track = async (h: Promise<TestHost>) => {
  const host = await h;
  hosts.push(host);
  return host;
};
afterEach(async () => {
  while (hosts.length) {
    const h = hosts.pop()!;
    await h.stop().catch(() => undefined);
    await fs.rm(h.dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

const TZ = 'Asia/Kathmandu';
const at = (date: string, hm: string) => Date.parse(`${date}T${hm}:00+05:45`);
const MON = '2026-10-12';
const TUE = '2026-10-13';
const WED = '2026-10-14';
const ALICE = { fullName: 'Alice Sharma', employeeId: 'E-1001', phone: '+977 9800000001' };
const BOB = { fullName: 'Bob Thapa', employeeId: 'E-1002', phone: '+977 9800000002' };
const readEvents = async (h: TestHost) =>
  (await fs.readFile(path.join(h.dir, 'attendance-events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function mkShift(h: TestHost, name: string, start: string, end: string, extra: Record<string, unknown> = {}): Promise<Shift> {
  return must<Shift>(h.admin('shifts.create', { name, start, end, graceMinutes: 10, earlyCheckInMinutes: 60, ...extra }));
}

async function scanAt(h: TestHost, phone: Phone, ms: number, intent: 'auto' | 'check-in' | 'check-out' = 'auto') {
  h.clock.t = ms;
  return phone.scan(h.attendanceToken(), intent);
}

describe('shift management', () => {
  it('creates, edits, activates and deactivates shifts with validation, audit and persistence', async () => {
    let h = await track(startHost({ t: at(MON, '00:00') }));
    const day = await mkShift(h, 'Day', '06:00', '14:00');
    const night = await mkShift(h, 'Night', '22:00', '06:00');
    expect(day).toMatchObject({ overnight: false, active: true });
    expect(night.overnight).toBe(true);

    expect((await h.admin('shifts.create', { name: 'Same', start: '06:00', end: '14:00', graceMinutes: 5, earlyCheckInMinutes: 30 })).ok).toBe(false);
    expect((await h.admin('shifts.create', { name: 'day', start: '07:00', end: '15:00', graceMinutes: 5, earlyCheckInMinutes: 30 })).ok).toBe(false);
    expect((await h.admin('shifts.create', { name: 'Zero', start: '08:00', end: '08:00', graceMinutes: 5, earlyCheckInMinutes: 30 })).ok).toBe(false);
    expect((await h.admin('shifts.create', { name: 'Bad', start: '8am', end: '16:00', graceMinutes: 5, earlyCheckInMinutes: 30 })).ok).toBe(false);
    expect((await h.admin('shifts.create', { name: 'Huge', start: '01:00', end: '23:00', graceMinutes: 5, earlyCheckInMinutes: 120 })).ok).toBe(false);

    const edited = await must<Shift>(h.admin('shifts.update', { id: day.id, patch: { name: 'Morning', start: '07:00', end: '15:00' } }));
    expect(edited).toMatchObject({ name: 'Morning', start: '07:00', end: '15:00' });
    await must(h.admin('shifts.setActive', { id: night.id, active: false }));
    expect((await must<Shift[]>(h.admin('shifts.list'))).find((s) => s.id === night.id)?.active).toBe(false);
    const clone = await mkShift(h, 'Night B', '22:00', '06:00');
    expect((await h.admin('shifts.setActive', { id: night.id, active: true })).ok).toBe(false);
    await must(h.admin('shifts.setActive', { id: clone.id, active: false }));
    await must(h.admin('shifts.setActive', { id: night.id, active: true }));

    const types = h.svc.audit.list({ limit: 200 }).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(['shift.created', 'shift.updated', 'shift.activated', 'shift.deactivated']));

    for (let i = 0; i < 25; i++) await mkShift(h, `Extra ${i}`, `${String(i % 24).padStart(2, '0')}:${i < 24 ? '30' : '45'}`, `${String((i + 3) % 24).padStart(2, '0')}:15`, { earlyCheckInMinutes: 0 });
    expect((await must<Shift[]>(h.admin('shifts.list'))).length).toBe(28);

    h = await track(h.restart());
    expect((await must<Shift[]>(h.admin('shifts.list'))).length).toBe(28);
    const files = await fs.readdir(h.dir);
    expect(files).toContain('shifts.json');
    expect((await h.svc.verifyIntegrity('test')).ok).toBe(true);
  });

  it('restricts shift changes to roles with write access', async () => {
    const h = await track(startHost({ t: at(MON, '00:00') }));
    await mkShift(h, 'Day', '06:00', '14:00');
    await must(h.admin('admins.create', { username: 'viewer', displayName: 'Viewer', password: 'Correct-Horse-9', role: 'auditor' }));
    const aud = await h.svc.adminAuth.login({ username: 'viewer', password: 'Correct-Horse-9' }, 'test');
    expect((await h.admin('shifts.list', undefined, aud.token)).ok).toBe(true);
    const denied = await h.admin('shifts.create', { name: 'X', start: '01:00', end: '02:00', graceMinutes: 1, earlyCheckInMinutes: 0 }, aud.token);
    expect(denied.ok).toBe(false);
  });
});

describe('shift detection', () => {
  const mk = (id: string, start: string, end: string, early = 60, grace = 10): Shift => ({
    id, name: id, start, end, graceMinutes: grace, earlyCheckInMinutes: early, active: true, overnight: end <= start, createdAt: '', updatedAt: '', createdBy: '', updatedBy: '',
  });
  const det = (shifts: Shift[], date: string, hm: string) => detectShift(at(date, hm), TZ, shifts);
  const id = (d: ReturnType<typeof detectShift>) => (d.kind === 'match' ? `${d.instance.shift.id}@${d.instance.date}` : d.kind);

  it('handles boundaries, midnight crossings and ambiguity', () => {
    const ab = [mk('A', '08:00', '16:00'), mk('B', '16:00', '00:00')];
    expect(id(det(ab, MON, '06:59'))).toBe('none');
    expect(id(det(ab, MON, '07:00'))).toBe(`A@${MON}`);
    expect(id(det(ab, MON, '12:00'))).toBe(`A@${MON}`);
    expect(id(det(ab, MON, '15:00'))).toBe(`B@${MON}`);
    expect(id(det(ab, MON, '15:59'))).toBe(`B@${MON}`);
    expect(id(det(ab, MON, '16:00'))).toBe(`B@${MON}`);
    expect(id(det(ab, MON, '23:59'))).toBe(`B@${MON}`);
    expect(id(det(ab, TUE, '00:00'))).toBe('none');

    const night = [mk('N', '22:00', '06:00')];
    expect(id(det(night, MON, '21:00'))).toBe(`N@${MON}`);
    expect(id(det(night, MON, '20:59'))).toBe('none');
    expect(id(det(night, MON, '23:59'))).toBe(`N@${MON}`);
    expect(id(det(night, TUE, '00:00'))).toBe(`N@${MON}`);
    expect(id(det(night, TUE, '05:59'))).toBe(`N@${MON}`);
    expect(id(det(night, TUE, '06:00'))).toBe('none');
    expect(id(det(night, TUE, '21:30'))).toBe(`N@${TUE}`);

    const early = [mk('E', '00:30', '08:30')];
    expect(id(det(early, MON, '23:45'))).toBe(`E@${TUE}`);

    const overlap = [mk('A', '08:00', '16:00'), mk('C', '12:00', '20:00')];
    expect(id(det(overlap, MON, '13:30'))).toBe('ambiguous');
    expect(id(det(overlap, MON, '11:30'))).toBe(`C@${MON}`);
    expect(id(det(overlap, MON, '09:00'))).toBe(`A@${MON}`);
    const twins = [mk('P', '08:00', '16:00', 60, 10), mk('Q', '08:30', '16:30', 60, 10)];
    expect(id(det(twins, MON, '08:15'))).toBe(`Q@${MON}`);
    const tie = [mk('P', '08:00', '12:00', 60, 120), mk('Q', '10:00', '14:00', 60, 120)];
    expect(id(det(tie, MON, '09:00'))).toBe('ambiguous');
    expect(id(detectShift(at(MON, '09:00'), TZ, [{ ...mk('Z', '08:00', '16:00'), active: false }]))).toBe('none');
  });
});

describe('check-in / check-out flow with shifts', () => {
  it('toggles automatically, shows name and action, keeps the detected shift and never auto-checks-out', async () => {
    let h = await track(startHost({ t: at(MON, '00:00') }));
    const phone = await enroll(h, ALICE);
    await mkShift(h, 'Day', '06:00', '14:00');
    h.svc.phone.resetRateLimits();

    const inRes = await scanAt(h, phone, at(MON, '06:20'));
    expect(inRes.status).toBe(200);
    expect(inRes.body.data).toMatchObject({ saved: true, action: 'check-in', employee: { fullName: 'Alice Sharma' }, shift: { name: 'Day' }, event: { kind: 'check-in', classification: 'late', minutes: 20 } });
    expect(inRes.body.data.message).toMatch(/Checked in at 06:20 \(Day\)/);

    expect((await phone.status()).body.data.status).toMatchObject({ state: 'checked-in', nextAction: 'check-out', shiftName: 'Day' });

    const edited = await must<Shift>(h.admin('shifts.update', { id: (await must<Shift[]>(h.admin('shifts.list')))[0].id, patch: { name: 'Renamed', end: '10:00' } }));
    expect(edited.name).toBe('Renamed');
    await must(h.admin('shifts.setActive', { id: edited.id, active: false }));

    h.svc.phone.resetRateLimits();
    h = await track(h.restart());
    phone.svc = h.svc;
    expect((await phone.status()).body.data.status).toMatchObject({ state: 'checked-in', nextAction: 'check-out' });

    h.clock.t = at(MON, '23:00') + 3 * 24 * 3_600_000;
    h.svc.phone.resetRateLimits();
    expect((await phone.status()).body.data.status.state).toBe('checked-in');
    expect((await readEvents(h)).length).toBe(1);
    const stale = (await must<any>(h.admin('attendance.history', { from: MON, to: MON }))).rows[0];
    expect(stale).toMatchObject({ state: 'checked-in', missingCheckOut: true, shiftName: 'Day' });

    const outRes = await scanAt(h, phone, at(MON, '13:30') + 3 * 24 * 3_600_000);
    expect(outRes.status).toBe(200);
    expect(outRes.body.data).toMatchObject({ action: 'check-out', employee: { fullName: 'Alice Sharma' }, shift: { name: 'Day' }, event: { kind: 'check-out', classification: 'overtime' } });
    const ev = await readEvents(h);
    expect(ev.map((e) => e.kind)).toEqual(['check-in', 'check-out']);
    expect(ev[1].sessionId).toBe(ev[0].id);
    expect(ev[1].shift.name).toBe('Day');
    expect(ev[0]).toMatchObject({ workDate: MON, deviceId: phone.deviceId, verification: 'device-signature' });
    expect(ev[0].shift).toMatchObject({ start: '06:00', end: '14:00' });
    const row = (await must<any>(h.admin('attendance.history', { from: MON, to: MON }))).rows[0];
    expect(row).toMatchObject({ state: 'checked-out', missingCheckOut: false, shiftName: 'Day', workedMinutes: 460, overtimeStatus: 'pending', overtimeMinutes: 0 });
  });

  it('does not modify attendance for invalid scans', async () => {
    const h = await track(startHost({ t: at(MON, '00:00') }));
    const phone = await enroll(h, ALICE);
    await mkShift(h, 'Day', '06:00', '14:00');
    h.svc.phone.resetRateLimits();
    h.clock.t = at(MON, '08:00');

    const stale = h.attendanceToken();
    h.clock.t += 60_000;
    expect((await phone.scan(stale, 'auto')).body.error.code).toBe('QR_EXPIRED');
    const forged = h.attendanceToken().replace(/\.[A-Za-z0-9_-]+$/, '.AAAAAAAAAAAAAAAAAAAAAA');
    expect((await phone.scan(forged, 'auto')).body.error.code).toBe('QR_INVALID');
    const body = await phone.scanBody(h.attendanceToken(), 'auto');
    expect((await request(h.svc, 'POST', '/api/attendance', { ...body, intent: 'check-in' })).body.error.code).toBe('SIGNATURE_INVALID');
    expect((await scanAt(h, phone, at(MON, '03:00'))).body.error.code).toBe('NO_SHIFT_OPEN');
    expect((await scanAt(h, phone, at(MON, '15:00'))).body.error.code).toBe('NO_SHIFT_OPEN');
    expect(await readEvents(h)).toHaveLength(0);
    expect((await phone.status()).body.data.status.state).toBe('not-arrived');
  });

  it('rejects an ambiguous shift match safely and records nothing', async () => {
    const h = await track(startHost({ t: at(MON, '00:00') }));
    const phone = await enroll(h, ALICE);
    await mkShift(h, 'A', '08:00', '16:00');
    await mkShift(h, 'C', '12:00', '20:00');
    h.svc.phone.resetRateLimits();
    const r = await scanAt(h, phone, at(MON, '13:30'));
    expect(r.body.error.code).toBe('SHIFT_AMBIGUOUS');
    expect(await readEvents(h)).toHaveLength(0);
    expect(h.svc.audit.list({ limit: 50 }).some((a) => a.type === 'attendance.rejected')).toBe(true);
  });

  it('blocks duplicates: idempotent retries, concurrent submissions and a double scan', async () => {
    const h = await track(startHost({ t: at(MON, '00:00') }));
    const phone = await enroll(h, ALICE);
    await mkShift(h, 'Day', '06:00', '14:00');
    h.svc.phone.resetRateLimits();
    h.clock.t = at(MON, '06:05');

    const key = 'idem-key-0001';
    const body = await phone.scanBody(h.attendanceToken(), 'auto', undefined, key);
    const [a, b] = await Promise.all([request(h.svc, 'POST', '/api/attendance', body), request(h.svc, 'POST', '/api/attendance', body)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a, b].filter((r) => r.body.data.duplicate).length).toBe(1);
    expect(a.body.data.event.id).toBe(b.body.data.event.id);
    h.clock.t += 120_000;
    const retry = await request(h.svc, 'POST', '/api/attendance', body);
    expect(retry.status).toBe(200);
    expect(retry.body.data).toMatchObject({ duplicate: true, action: 'check-in' });
    expect(retry.body.data.event.id).toBe(a.body.data.event.id);
    const tampered = await request(h.svc, 'POST', '/api/attendance', { ...body, clientNonce: 'AAAAAAAAAAAA' });
    expect(tampered.status).toBeGreaterThanOrEqual(400);
    expect(await readEvents(h)).toHaveLength(1);

    h.clock.t = at(MON, '13:30');
    const t1 = h.attendanceToken();
    const t2 = h.attendanceToken();
    const [r1, r2] = await Promise.all([phone.scan(t1, 'auto'), phone.scan(t2, 'auto')]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect([r1, r2].find((r) => r.status === 409)!.body.error.code).toBe('TOO_SOON');
    const ev = await readEvents(h);
    expect(ev.map((e) => e.kind)).toEqual(['check-in', 'check-out']);

    h.clock.t += 5 * 60_000;
    expect((await phone.scan(h.attendanceToken(), 'check-out')).body.error.code).toBe('NOT_CHECKED_IN');
    expect((await phone.scan(h.attendanceToken(), 'auto')).body.error.code).toBe('DAY_COMPLETE');
    expect(await readEvents(h)).toHaveLength(2);
  });

  it('allows only one active session per employee', async () => {
    const h = await track(startHost({ t: at(MON, '00:00') }));
    const phones = [await enroll(h, ALICE), await enroll(h, BOB)];
    await mkShift(h, 'Day', '06:00', '14:00');
    h.svc.phone.resetRateLimits();
    h.clock.t = at(MON, '06:05');
    await must(h.admin('settings.update', { allowMultipleSessions: true, minIntervalSeconds: 0 }));
    const token = h.attendanceToken();
    const rs = await Promise.all(phones.map((p) => p.scan(token, 'check-in')));
    expect(rs.map((r) => r.status)).toEqual([200, 200]);
    h.clock.t += 20_000;
    const again = await Promise.all([phones[0].scan(h.attendanceToken(), 'check-in'), phones[0].scan(h.attendanceToken(), 'check-in')]);
    expect(again.map((r) => r.status)).toEqual([409, 409]);
    expect(again.every((r) => r.body.error.code === 'ALREADY_CHECKED_IN')).toBe(true);
    const ev = await readEvents(h);
    expect(ev.filter((e) => e.employeeId === 'E-1001')).toHaveLength(1);
  });
});

describe('overnight shifts', () => {
  it('keeps one session across midnight, preserves the shift and reports by work date', async () => {
    const h = await track(startHost({ t: at(MON, '00:00') }));
    const phone = await enroll(h, ALICE);
    await mkShift(h, 'Night', '22:00', '06:00');
    h.svc.phone.resetRateLimits();

    expect((await scanAt(h, phone, at(MON, '20:00'))).body.error.code).toBe('NO_SHIFT_OPEN');
    const inRes = await scanAt(h, phone, at(MON, '22:05'));
    expect(inRes.body.data).toMatchObject({ action: 'check-in', shift: { name: 'Night' }, event: { classification: 'on-time' } });

    h.svc.phone.resetRateLimits();
    h.clock.t = at(TUE, '02:00');
    const ov = await must<any>(h.admin('dashboard.overview'));
    expect(ov.counts.checkedIn).toBe(1);
    expect(ov.rows.find((r: any) => r.employeeId === 'E-1001')).toMatchObject({ state: 'checked-in', date: MON, shiftName: 'Night', missingCheckOut: false });
    expect((await phone.status()).body.data.status).toMatchObject({ state: 'checked-in', nextAction: 'check-out' });

    const mid = (await must<any>(h.admin('attendance.history', { from: MON, to: TUE }))).rows.filter((r: any) => r.employeeId === 'E-1001');
    expect(mid.map((r: any) => r.date)).toContain(MON);
    expect(mid.find((r: any) => r.date === MON)).toMatchObject({ state: 'checked-in', missingCheckOut: false });

    const outRes = await scanAt(h, phone, at(TUE, '06:20'));
    expect(outRes.status).toBe(200);
    expect(outRes.body.data).toMatchObject({ action: 'check-out', shift: { name: 'Night' }, event: { classification: 'normal', localDate: TUE } });
    expect(outRes.body.data.message).toMatch(/Worked 8h 15m/);

    const ev = await readEvents(h);
    expect(ev[0]).toMatchObject({ localDate: MON, workDate: MON });
    expect(ev[1]).toMatchObject({ localDate: TUE, workDate: MON, sessionId: ev[0].id });

    const monRow = (await must<any>(h.admin('attendance.history', { from: MON, to: MON, employeeId: 'E-1001' }))).rows[0];
    expect(monRow).toMatchObject({ date: MON, state: 'checked-out', workedMinutes: 495, checkInLocal: '22:05:00', checkOutLocal: '06:20:00', shiftName: 'Night' });
    expect(monRow.sessions[0]).toMatchObject({ checkInDate: MON, checkOutDate: TUE });
    const tueRows = (await must<any>(h.admin('attendance.history', { from: TUE, to: TUE, employeeId: 'E-1001' }))).rows;
    expect(tueRows.every((r: any) => r.events.length === 0)).toBe(true);

    h.clock.t = at(TUE, '22:30');
    h.svc.phone.resetRateLimits();
    const next = await phone.scan(h.attendanceToken(), 'auto');
    expect(next.body.data).toMatchObject({ action: 'check-in', shift: { name: 'Night' } });
    expect((await readEvents(h))[2].workDate).toBe(TUE);
  });

  it('accepts a check-in after midnight for the shift that started the previous day and flags missing check-outs from shift timing', async () => {
    const h = await track(startHost({ t: at(MON, '00:00') }));
    const phone = await enroll(h, ALICE);
    await mkShift(h, 'Night', '23:30', '07:30');
    h.svc.phone.resetRateLimits();
    const r = await scanAt(h, phone, at(TUE, '00:15'));
    expect(r.body.data).toMatchObject({ action: 'check-in', event: { classification: 'late', minutes: 45 } });
    expect((await readEvents(h))[0].workDate).toBe(MON);

    h.clock.t = at(TUE, '07:29');
    let row = (await must<any>(h.admin('attendance.history', { from: MON, to: MON }))).rows.find((x: any) => x.employeeId === 'E-1001');
    expect(row.missingCheckOut).toBe(false);
    h.clock.t = at(TUE, '07:31');
    row = (await must<any>(h.admin('attendance.history', { from: MON, to: MON, status: 'missing-checkout' }))).rows.find((x: any) => x.employeeId === 'E-1001');
    expect(row).toMatchObject({ missingCheckOut: true, state: 'checked-in' });
    expect((await readEvents(h)).length).toBe(1);
    h.clock.t = at(WED, '09:00');
    h.svc.phone.resetRateLimits();
    const out = await phone.scan(h.attendanceToken(), 'auto');
    expect(out.body.data).toMatchObject({ action: 'check-out', shift: { name: 'Night' } });
  });

  it('supports corrections on sessions that cross midnight', async () => {
    const h = await track(startHost({ t: at(MON, '00:00') }));
    const phone = await enroll(h, ALICE);
    await mkShift(h, 'Night', '22:00', '06:00');
    h.svc.phone.resetRateLimits();
    await scanAt(h, phone, at(MON, '22:00'));
    h.clock.t = at(TUE, '07:00');
    const add = await must<any>(h.admin('corrections.apply', { op: 'add', employeeId: 'E-1001', kind: 'check-out', date: TUE, time: '06:05', reason: 'Forgot to scan out' }));
    expect(add).toMatchObject({ op: 'add', workDate: MON, classification: 'normal' });
    expect((await h.admin('corrections.apply', { op: 'add', employeeId: 'E-1001', kind: 'check-out', date: TUE, time: '06:10', reason: 'Second checkout attempt' })).ok).toBe(false);
    const row = (await must<any>(h.admin('attendance.history', { from: MON, to: MON }))).rows.find((x: any) => x.employeeId === 'E-1001');
    expect(row).toMatchObject({ state: 'checked-out', checkOutLocal: '06:05:00', corrected: true, workedMinutes: 485 });
    expect((await h.admin('corrections.apply', { op: 'add', employeeId: 'E-1001', kind: 'check-in', date: TUE, time: '12:00', reason: 'Outside any shift window' })).ok).toBe(false);
  });
});

describe('attendance reports', () => {
  it('filters by employee, date, shift and status', async () => {
    const h = await track(startHost({ t: at(MON, '00:00') }));
    const alice = await enroll(h, ALICE);
    const bob = await enroll(h, BOB);
    const day = await mkShift(h, 'Day', '06:00', '14:00');
    const night = await mkShift(h, 'Night', '22:00', '06:00');
    h.svc.phone.resetRateLimits();

    await scanAt(h, alice, at(MON, '06:00'));
    await scanAt(h, alice, at(MON, '14:00'));
    await scanAt(h, bob, at(MON, '22:30'));
    h.svc.phone.resetRateLimits();
    await scanAt(h, bob, at(TUE, '06:00'));
    h.clock.t = at(TUE, '12:00');

    const q = async (args: Record<string, unknown>) => (await must<any>(h.admin('attendance.history', { from: MON, to: TUE, ...args }))).rows.filter((r: any) => r.events.length > 0);
    expect((await q({})).length).toBe(2);
    expect((await q({ employeeId: 'E-1001' })).map((r: any) => r.employeeId)).toEqual(['E-1001']);
    expect((await q({ shiftId: day.id })).map((r: any) => r.employeeId)).toEqual(['E-1001']);
    expect((await q({ shiftId: night.id })).map((r: any) => r.employeeId)).toEqual(['E-1002']);
    expect((await q({ shiftId: night.id })).map((r: any) => r.date)).toEqual([MON]);
    expect((await q({ status: 'checked-out' })).length).toBe(2);
    expect((await q({ status: 'present' })).length).toBe(2);
    expect((await q({ status: 'missing-checkout' })).length).toBe(0);
    expect((await q({ from: TUE, to: TUE })).length).toBe(0);
    expect((await q({ from: MON, to: MON, shiftId: 'none' })).length).toBe(0);
  });

  it('exposes audit information and keeps one session id per overnight session', async () => {
    const h = await track(startHost({ t: at(MON, '00:00') }));
    const alice = await enroll(h, ALICE);
    await mkShift(h, 'Night', '22:00', '06:00');
    h.svc.phone.resetRateLimits();
    await scanAt(h, alice, at(MON, '22:00'));
    await scanAt(h, alice, at(TUE, '06:00'));
    const row = (await must<any>(h.admin('attendance.history', { from: MON, to: MON, employeeId: 'E-1001' }))).rows[0];
    expect(row.events).toHaveLength(2);
    for (const e of row.events) {
      expect(e).toMatchObject({ deviceId: alice.deviceId, source: 'device', shiftName: 'Night' });
      expect(typeof e.remoteAddr).toBe('string');
      expect(e.remoteAddr.length).toBeGreaterThan(0);
    }
    expect(row.events[0].sessionId).toBe(row.events[1].sessionId);
  });

  it('exports shift and check-out date columns', async () => {
    const h = await track(startHost({ t: at(MON, '00:00') }));
    const alice = await enroll(h, ALICE);
    await mkShift(h, 'Night', '22:00', '06:00');
    h.svc.phone.resetRateLimits();
    await scanAt(h, alice, at(MON, '22:00'));
    await scanAt(h, alice, at(TUE, '06:00'));
    const rows = (await must<any>(h.admin('attendance.history', { from: MON, to: MON }))).rows;
    expect(rows.find((r: any) => r.employeeId === 'E-1001').shifts).toEqual([{ id: expect.any(String), name: 'Night' }]);
    const res = await must<any>(h.admin('export.run', { kind: 'range', from: MON, to: TUE }));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(res.filePath);
    const ws = wb.getWorksheet('Attendance')!;
    const headers = (ws.getRow(1).values as any[]).map((v) => String(v ?? ''));
    const col = (name: string) => headers.indexOf(name);
    const rowIdx = Array.from({ length: ws.rowCount - 1 }, (_, i) => i + 2).find((i) => String(ws.getRow(i).getCell(col('Employee ID')).value) === 'E-1001' && String(ws.getRow(i).getCell(col('Date')).value) === MON)!;
    const row = ws.getRow(rowIdx);
    expect(String(row.getCell(col('Shift')).value)).toBe('Night');
    expect(String(row.getCell(col('Check-out Date')).value)).toBe(TUE);
    expect(String(row.getCell(col('Check-out')).value)).toBe('06:00:00');
  });
});

describe('dynamic shift windows and approvals', () => {
  const setup = async (start = '06:00', end = '12:00') => {
    const h = await track(startHost({ t: at(MON, '00:00') }));
    const phone = await enroll(h, ALICE);
    await mkShift(h, 'Morning', start, end);
    h.svc.phone.resetRateLimits();
    return { h, phone };
  };

  it('classifies check-in bands and opens one hour before start', async () => {
    const { h, phone } = await setup();
    expect((await scanAt(h, phone, at(MON, '04:59'))).body.error.code).toBe('NO_SHIFT_OPEN');
    const early = await scanAt(h, phone, at(MON, '05:00'));
    expect(early.body.data.event.classification).toBe('on-time');
    await must(h.admin('corrections.apply', { op: 'void', eventId: early.body.data.event.id, reason: 'Reset for next case' }));
    const cases: Array<[string, string]> = [['06:00', 'on-time'], ['06:10', 'grace'], ['06:11', 'late'], ['06:30', 'late'], ['07:00', 'late']];
    for (const [hm, cls] of cases) {
      const h2 = await track(startHost({ t: at(MON, '00:00') }));
      const p2 = await enroll(h2, ALICE);
      await mkShift(h2, 'Morning', '06:00', '12:00');
      h2.svc.phone.resetRateLimits();
      const r = await scanAt(h2, p2, at(MON, hm));
      expect([hm, r.body.data.event.classification, r.body.data.pendingApproval]).toEqual([hm, cls, false]);
    }
  });

  it('requires approval after the check-in window, with mandatory reason, admin and status in the log', async () => {
    const { h, phone } = await setup();
    const r = await scanAt(h, phone, at(MON, '07:30'));
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ pendingApproval: true, event: { classification: 'late', approval: { kind: 'late-check-in', status: 'pending' } } });
    let row = (await must<any>(h.admin('attendance.history', { from: MON, to: MON }))).rows[0];
    expect(row).toMatchObject({ state: 'not-arrived', status: 'pending', approvalPending: true });
    expect((await scanAt(h, phone, at(MON, '07:45'))).body.error.code).toBe('APPROVAL_PENDING');
    const eventId = r.body.data.event.id;
    expect((await h.admin('approvals.decide', { eventId, decision: 'approve', reason: 'ok' })).ok).toBe(false);
    await must(h.admin('approvals.decide', { eventId, decision: 'approve', reason: 'Bus broke down, confirmed by supervisor' }));
    expect((await h.admin('approvals.decide', { eventId, decision: 'reject', reason: 'Changed my mind' })).ok).toBe(false);
    row = (await must<any>(h.admin('attendance.history', { from: MON, to: MON }))).rows[0];
    expect(row).toMatchObject({ state: 'checked-in', status: 'late', classification: 'late', approvalPending: false });
    expect(row.approvals[0]).toMatchObject({ status: 'approved', decidedByName: 'Owner One', reason: 'Bus broke down, confirmed by supervisor' });
    const log = await readEvents(h);
    expect(log.map((e) => e.type)).toEqual(['attendance', 'approval']);
    expect(log[1]).toMatchObject({ decision: 'approved', adminName: 'Owner One', targetEventId: eventId });
    expect(h.svc.audit.list({ limit: 20 }).some((a) => a.type === 'approval.approved')).toBe(true);
  });

  it('rejected late check-in records no attendance and cannot be re-requested', async () => {
    const { h, phone } = await setup();
    const r = await scanAt(h, phone, at(MON, '08:00'));
    await must(h.admin('approvals.decide', { eventId: r.body.data.event.id, decision: 'reject', reason: 'Not on site that morning' }));
    const row = (await must<any>(h.admin('attendance.history', { from: MON, to: MON }))).rows[0];
    expect(row).toMatchObject({ state: 'not-arrived', checkIn: undefined, approvalPending: false });
    expect(row.approvals[0].status).toBe('rejected');
    h.clock.t = at(MON, '09:00');
    expect((await scanAt(h, phone, at(MON, '09:00'))).body.error.code).toBe('APPROVAL_REJECTED');
  });

  it('enforces check-out windows, early leave and overtime approval', async () => {
    const { h, phone } = await setup();
    await scanAt(h, phone, at(MON, '06:00'));
    expect((await scanAt(h, phone, at(MON, '10:59'))).body.error.code).toBe('CHECKOUT_NOT_OPEN');
    const early = await scanAt(h, phone, at(MON, '11:30'));
    expect(early.body.data.event).toMatchObject({ classification: 'early-leave', minutes: 30 });
    const row = (await must<any>(h.admin('attendance.history', { from: MON, to: MON }))).rows[0];
    expect(row).toMatchObject({ earlyLeave: true, minutesEarly: 30, workedMinutes: 330 });
  });

  it('on-time checkout through 13:00; later needs overtime approval and hours depend on the decision', async () => {
    const run = async (outAt: string, decision?: 'approve' | 'reject') => {
      const { h, phone } = await setup();
      await scanAt(h, phone, at(MON, '06:00'));
      const out = await scanAt(h, phone, at(MON, outAt));
      let row = (await must<any>(h.admin('attendance.history', { from: MON, to: MON }))).rows[0];
      if (decision) {
        await must(h.admin('approvals.decide', { eventId: out.body.data.event.id, decision, reason: 'Finished urgent delivery' }));
        row = (await must<any>(h.admin('attendance.history', { from: MON, to: MON }))).rows[0];
      }
      return { out, row };
    };
    const a = await run('12:00');
    expect(a.out.body.data.event.classification).toBe('normal');
    const b = await run('13:00');
    expect(b.out.body.data.event.classification).toBe('normal');
    expect(b.row.workedMinutes).toBe(420);
    const c = await run('13:20');
    expect(c.out.body.data.event).toMatchObject({ classification: 'overtime', approval: { kind: 'overtime', status: 'pending' } });
    expect(c.row).toMatchObject({ workedMinutes: 360, overtimeStatus: 'pending', overtimeMinutes: 0, state: 'checked-out' });
    const d = await run('13:20', 'approve');
    expect(d.row).toMatchObject({ workedMinutes: 440, overtimeMinutes: 80, overtimeStatus: 'approved', checkOutLocal: '13:20:00' });
    const e = await run('13:20', 'reject');
    expect(e.row).toMatchObject({ workedMinutes: 360, overtimeMinutes: 0, overtimeStatus: 'rejected', checkOutLocal: '13:20:00' });
  });

  it('applies the same rules to overnight shifts across midnight', async () => {
    const { h, phone } = await setup('22:00', '06:00');
    const inRes = await scanAt(h, phone, at(MON, '22:40'));
    expect(inRes.body.data.event.classification).toBe('late');
    expect((await scanAt(h, phone, at(TUE, '04:30'))).body.error.code).toBe('CHECKOUT_NOT_OPEN');
    const out = await scanAt(h, phone, at(TUE, '06:45'));
    expect(out.body.data.event).toMatchObject({ classification: 'normal', localDate: TUE });
    const row = (await must<any>(h.admin('attendance.history', { from: MON, to: MON }))).rows[0];
    expect(row.workedMinutes).toBe(485);
  });

  it('restricts approval decisions to roles with write access', async () => {
    const { h, phone } = await setup();
    const r = await scanAt(h, phone, at(MON, '08:00'));
    await must(h.admin('admins.create', { username: 'viewer', displayName: 'Viewer', password: 'Correct-Horse-9', role: 'auditor' }));
    const aud = await h.svc.adminAuth.login({ username: 'viewer', password: 'Correct-Horse-9' }, 'test');
    expect((await h.admin('approvals.list', { status: 'pending' }, aud.token)).ok).toBe(true);
    expect((await h.admin('approvals.decide', { eventId: r.body.data.event.id, decision: 'approve', reason: 'Trying anyway' }, aud.token)).ok).toBe(false);
  });
});

describe('data protection', () => {
  it('archives and restores employees, devices and shifts without ever deleting them', async () => {
    const h = await track(startHost({ t: at(MON, '09:00') }));
    const phone = await enroll(h, ALICE);
    const shift = await mkShift(h, 'Day', '06:00', '14:00');
    expect((await h.admin('employees.archive', { id: 'E-1001', reason: 'Left company' })).ok).toBe(false);
    expect((await h.admin('shifts.archive', { id: shift.id, reason: 'Obsolete' })).ok).toBe(false);
    expect((await h.admin('devices.archive', { deviceId: phone.deviceId, reason: 'Old phone' })).ok).toBe(false);

    await must(h.admin('employees.deactivate', { id: 'E-1001', reason: 'Left company' }));
    await must(h.admin('employees.archive', { id: 'E-1001', reason: 'Left company' }));
    await must(h.admin('devices.revoke', { deviceId: phone.deviceId, reason: 'Left company' }));
    await must(h.admin('devices.archive', { deviceId: phone.deviceId, reason: 'Left company' }));
    await must(h.admin('shifts.setActive', { id: shift.id, active: false }));
    await must(h.admin('shifts.archive', { id: shift.id, reason: 'Obsolete' }));

    const emps = await must<any[]>(h.admin('employees.list'));
    expect(emps.find((e) => e.id === 'E-1001')).toMatchObject({ status: 'inactive', archivedBy: 'owner', archivedReason: 'Left company' });
    expect((await h.admin('employees.reactivate', { id: 'E-1001' })).ok).toBe(false);
    expect((await h.admin('shifts.setActive', { id: shift.id, active: true })).ok).toBe(false);
    expect((await must<any[]>(h.admin('devices.list')))[0].archivedAt).toBeTruthy();

    await must(h.admin('employees.restore', { id: 'E-1001' }));
    await must(h.admin('shifts.restore', { id: shift.id }));
    await must(h.admin('devices.restore', { deviceId: phone.deviceId }));
    expect((await must<any[]>(h.admin('employees.list'))).find((e) => e.id === 'E-1001').archivedAt).toBeUndefined();
    const types = h.svc.audit.list({ limit: 100 }).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(['employee.archived', 'employee.restored', 'device.archived', 'device.restored', 'shift.archived', 'shift.restored']));
  });

  it('refuses any change that would remove a stored record', async () => {
    const h = await track(startHost({ t: at(MON, '09:00') }));
    await enroll(h, ALICE);
    await mkShift(h, 'Day', '06:00', '14:00');
    await expect(h.svc.employeesStore.update((d) => { d.employees.pop(); })).rejects.toMatchObject({ code: 'DATA_PROTECTED' });
    await expect(h.svc.devicesStore.update((d) => { d.devices.pop(); })).rejects.toMatchObject({ code: 'DATA_PROTECTED' });
    await expect(h.svc.devicesStore.update((d) => { d.requests.pop(); })).rejects.toMatchObject({ code: 'DATA_PROTECTED' });
    await expect(h.svc.shiftsStore.update((d) => { d.shifts.pop(); })).rejects.toMatchObject({ code: 'DATA_PROTECTED' });
    await expect(h.svc.adminsStore.update((d) => { d.admins.pop(); })).rejects.toMatchObject({ code: 'DATA_PROTECTED' });
    expect((await must<any[]>(h.admin('employees.list'))).length).toBe(1);
  });
});
