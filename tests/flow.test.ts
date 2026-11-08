import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { parseScan } from '../src/shared/protocol';
import { signingMessage } from '../src/shared/protocol';
import { faults } from '../src/server/storage/faults';
import { enroll, MONDAY_9AM, must, Phone, request, sleep, startHost, type TestHost } from './helpers';

const hosts: TestHost[] = [];
const track = async (h: Promise<TestHost>) => {
  const host = await h;
  hosts.push(host);
  return host;
};
afterEach(async () => {
  faults.failNext = null;
  faults.failOps = null;
  while (hosts.length) {
    const h = hosts.pop()!;
    await h.stop().catch(() => undefined);
    await fs.rm(h.dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

const ALICE = { fullName: 'Alice Sharma', employeeId: 'E-1001', phone: '+977 9800000001' };
const BOB = { fullName: 'Bob Thapa', employeeId: 'E-1002', phone: '+977 9800000002' };
const min = (m: number) => m * 60_000;
const readLines = async (h: TestHost, f: string) => (await fs.readFile(path.join(h.dir, f), 'utf8')).trim().split('\n').filter(Boolean);

describe('registration, approval and device lifecycle', () => {
  it('registers through the one-time QR, needs admin approval, and stores only the public key', async () => {
    const h = await track(startHost());
    const phone = await Phone.create(h.svc);

    // no / bad token
    let r = await phone.register('PR1.bogus.token.mac', ALICE);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('TOKEN_INVALID');

    await must(h.admin('terminal.setMode', { mode: 'registration' }));
    const token = parseScan(h.svc.terminal.getCurrent().url)!.token;
    r = await phone.register(token, ALICE);
    expect(r.status).toBe(200);

    // pending until approved
    expect((await phone.registrationStatus()).body.data.status).toBe('pending');
    expect(await must(h.admin('requests.list', { status: 'pending' }))).toHaveLength(1);
    // the same QR cannot be used twice
    const second = await (await Phone.create(h.svc)).register(token, BOB);
    expect(second.status).toBe(400);

    const dev = await must<any>(h.admin('requests.approve', { requestId: phone.requestId }));
    expect(dev.deviceId).toBe(phone.deviceId);
    const status = (await phone.registrationStatus()).body.data;
    expect(status).toMatchObject({ status: 'approved', deviceId: phone.deviceId, employee: { id: 'E-1001', fullName: 'Alice Sharma' } });

    const devicesFile = await fs.readFile(path.join(h.dir, 'devices.json'), 'utf8');
    expect(devicesFile).toContain(phone.jwk.x);
    expect(JSON.parse(devicesFile).devices[0].publicKey).not.toHaveProperty('d');
    expect(await readLines(h, 'audit-log.jsonl').then((l) => l.join('\n'))).toMatch(/registration\.approved/);
  });

  it('rejection is final and recorded; poll secret is required to read status', async () => {
    const h = await track(startHost());
    const phone = await Phone.create(h.svc);
    await must(h.admin('terminal.setMode', { mode: 'registration' }));
    await phone.register(parseScan(h.svc.terminal.getCurrent().url)!.token, ALICE);
    await must(h.admin('requests.reject', { requestId: phone.requestId, reason: 'Not an employee' }));
    expect((await phone.registrationStatus()).body.data).toMatchObject({ status: 'rejected', reason: 'Not an employee' });
    const wrong = await request(h.svc, 'POST', '/api/register/status', { requestId: phone.requestId, pollSecret: 'AAAAAAAAAAAAAAAAAAAA' });
    expect(wrong.status).toBe(404);
    const again = await h.admin('requests.approve', { requestId: phone.requestId });
    expect(again.ok).toBe(false);
  });

  it('blocks a second registration for an employee who already has a phone, then supports admin-authorized replacement and revocation', async () => {
    const h = await track(startHost());
    const old = await enroll(h, ALICE);
    expect((await old.status()).body.data.employee.fullName).toBe('Alice Sharma');

    // a plain second registration is refused and the QR stays usable
    await must(h.admin('terminal.setMode', { mode: 'registration' }));
    const token = parseScan(h.svc.terminal.getCurrent().url)!.token;
    const fresh = await Phone.create(h.svc);
    const dup = await fresh.register(token, ALICE);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMPLOYEE_HAS_DEVICE');

    // replacement enrollment authorised by the admin
    await must(h.admin('devices.issueReplacement', { employeeId: 'E-1001' }));
    const repToken = parseScan(h.svc.terminal.getCurrent().url)!.token;
    const peek = await request(h.svc, 'POST', '/api/register/peek', { token: repToken });
    expect(peek.body.data).toMatchObject({ type: 'replacement', employee: { id: 'E-1001' } });
    const r = await fresh.register(repToken, { ...ALICE, employeeId: 'WRONG-ID' }); // ID comes from the token, not the phone
    expect(r.status).toBe(200);
    const reqs = await must<any[]>(h.admin('requests.list', { status: 'pending' }));
    expect(reqs[0]).toMatchObject({ type: 'replacement', employeeId: 'E-1001' });
    await must(h.admin('requests.approve', { requestId: fresh.requestId }));

    // the old phone is now revoked, the new one works
    const oldStatus = await old.status();
    expect(oldStatus.status).toBe(403);
    expect(oldStatus.body.error.code).toBe('DEVICE_REVOKED');
    expect((await fresh.status()).status).toBe(200);
    h.svc.terminal.setMode('attendance', 'test');
    expect((await old.scan(h.attendanceToken(), 'check-in')).body.error.code).toBe('DEVICE_REVOKED');

    // explicit revocation of the replacement (lost phone)
    await must(h.admin('devices.revoke', { deviceId: fresh.deviceId, reason: 'Lost phone' }));
    expect((await fresh.status()).body.error.code).toBe('DEVICE_REVOKED');
    expect((await h.svc.audit.list({ limit: 50 })).map((a) => a.type)).toEqual(expect.arrayContaining(['device.revoked', 'registration.approved', 'registration.requested']));
  });

  it('deactivated employees cannot record attendance; unknown devices are refused', async () => {
    const h = await track(startHost());
    const phone = await enroll(h, ALICE);
    await must(h.admin('employees.deactivate', { id: 'E-1001', reason: 'Left the company' }));
    const r = await phone.scan(h.attendanceToken(), 'check-in');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('EMPLOYEE_INACTIVE');
    const stranger = await Phone.create(h.svc);
    expect((await stranger.scan(h.attendanceToken(), 'check-in')).body.error.code).toBe('DEVICE_UNKNOWN');
  });
});

describe('live QR attendance', () => {
  it('saves a durable event before answering and exposes status', async () => {
    const h = await track(startHost());
    const phone = await enroll(h, ALICE);
    const before = (await readLines(h, 'attendance-events.jsonl')).length;
    const r = await phone.scan(h.attendanceToken(), 'check-in');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ saved: true, event: { kind: 'check-in', classification: 'on-time', localTime: '09:00:00' } });
    const lines = await readLines(h, 'attendance-events.jsonl');
    expect(lines).toHaveLength(before + 1);
    expect(JSON.parse(lines[lines.length - 1]).id).toBe(r.body.data.event.id);
    const s = (await phone.status()).body.data;
    expect(s.status).toMatchObject({ state: 'checked-in', nextAction: 'check-out' });
    expect(s.employee.id).toBe('E-1001');
  });

  it('rejects replays, expired codes, forged codes and bad signatures', async () => {
    const h = await track(startHost());
    const phone = await enroll(h, ALICE);
    const token = h.attendanceToken();

    const body = await phone.scanBody(token, 'check-in');
    expect((await request(h.svc, 'POST', '/api/attendance', body)).status).toBe(200);
    const replay = await request(h.svc, 'POST', '/api/attendance', body);
    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('REPLAY');
    // same challenge, new client nonce: still a replay of (challenge, device)
    h.clock.t += min(2);
    const again = await phone.scan(token, 'check-out'); // token is now 2 min old
    expect(again.body.error.code).toBe('QR_EXPIRED');

    // expiry boundary (10 s window)
    const t1 = h.attendanceToken();
    h.clock.t += 9_000;
    const ok = await phone.scan(t1, 'check-out');
    expect(ok.status).toBe(200);
    const t2 = h.attendanceToken();
    h.clock.t += 10_500;
    expect((await phone.scan(t2, 'check-in')).status).toBe(410);

    // forged token
    const forged = h.attendanceToken().replace(/\.[A-Za-z0-9_-]+$/, '.AAAAAAAAAAAAAAAAAAAAAA');
    const f = await phone.scan(forged, 'check-in');
    expect(f.status).toBe(400);
    expect(f.body.error.code).toBe('QR_INVALID');

    // signature by a different key
    const mallory = await Phone.create(h.svc);
    const fresh = h.attendanceToken();
    const evil = await mallory.scanBody(fresh, 'check-in');
    const bad = await request(h.svc, 'POST', '/api/attendance', { ...evil, deviceId: phone.deviceId });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('SIGNATURE_INVALID');
    // signature over a different intent is invalid too
    const swapped = await phone.scanBody(fresh, 'check-in');
    const sw = await request(h.svc, 'POST', '/api/attendance', { ...swapped, intent: 'check-out' });
    expect(sw.body.error.code).toBe('SIGNATURE_INVALID');
    const sec = h.svc.audit.list({ limit: 100, securityOnly: true }).map((a) => a.type);
    expect(sec).toEqual(expect.arrayContaining(['security.replay', 'security.invalid-signature', 'security.invalid-qr']));
  });

  it('enforces check-in/check-out sequencing, cooldown, duplicate prevention and day completion', async () => {
    const h = await track(startHost());
    const phone = await enroll(h, ALICE);
    const code = async (intent: 'check-in' | 'check-out') => {
      const b = (await phone.scan(h.attendanceToken(), intent)).body;
      return b.ok ? b.data : b;
    };

    expect((await code('check-out')).error.code).toBe('NOT_CHECKED_IN');
    expect((await code('check-in')).saved).toBe(true);
    h.clock.t += 5_000;
    expect((await code('check-in')).error.code).toBe('ALREADY_CHECKED_IN');
    expect((await code('check-out')).error.code).toBe('TOO_SOON'); // inside the 60 s cooldown
    h.clock.t += min(8 * 60);
    const out = await code('check-out');
    expect(out.saved).toBe(true);
    expect(out.event.classification).toBe('normal');
    h.clock.t += min(2);
    expect((await code('check-in')).error.code).toBe('DAY_COMPLETE');
    expect((await code('check-out')).error.code).toBe('NOT_CHECKED_IN');
    const events = (await readLines(h, 'attendance-events.jsonl')).map((l) => JSON.parse(l));
    expect(events.map((e) => e.kind)).toEqual(['check-in', 'check-out']);
  });

  it('applies late, early-leave, too-early and grace rules using host time in the office timezone', async () => {
    const h = await track(startHost({ t: Date.parse('2026-10-11T22:00:00Z') })); // 03:45 local
    const phone = await enroll(h, ALICE);
    const bob = await enroll(h, BOB);
    const carol = await enroll(h, { fullName: 'Carol Rai', employeeId: 'E-1003', phone: '+977 9800000003' });

    h.clock.t = Date.parse('2026-10-11T23:00:00Z'); // 04:45 local — before the 06:00 opening
    expect((await phone.scan(h.attendanceToken(), 'check-in')).body.error.code).toBe('TOO_EARLY');

    h.clock.t = Date.parse('2026-10-12T03:25:00Z'); // 09:10:00 — end of the grace period
    expect((await phone.scan(h.attendanceToken(), 'check-in')).body.data.event.classification).toBe('grace');
    h.clock.t = Date.parse('2026-10-12T03:30:00Z'); // 09:15 — late by 15
    const late = await bob.scan(h.attendanceToken(), 'check-in');
    expect(late.body.data.event).toMatchObject({ classification: 'late', minutes: 15 });
    expect(late.body.data.message).toMatch(/late by 15 min/);
    h.clock.t = Date.parse('2026-10-12T10:15:00Z'); // 16:00 — leaves 60 min early
    const early = await phone.scan(h.attendanceToken(), 'check-out');
    expect(early.body.data.event).toMatchObject({ classification: 'early-leave', minutes: 60 });
    void carol;

    const day = (await must<any>(h.admin('dashboard.overview'))).rows.find((r: any) => r.employeeId === 'E-1001');
    expect(day).toMatchObject({ status: 'present', state: 'checked-out', earlyLeave: true, minutesEarly: 60, workedMinutes: 410 });
  });

  it('handles 22 phones scanning the same QR simultaneously and a double-tap from one phone', async () => {
    const h = await track(startHost());
    const phones: Phone[] = [];
    for (let i = 1; i <= 22; i++) phones.push(await enroll(h, { fullName: `Employee ${String(i).padStart(2, '0')}`, employeeId: `E-${2000 + i}`, phone: `+9779800000${String(100 + i)}` }));
    const token = h.attendanceToken();
    const results = await Promise.all(phones.map((p) => p.scan(token, 'check-in')));
    expect(results.map((r) => r.status)).toEqual(Array(22).fill(200));
    const events = (await readLines(h, 'attendance-events.jsonl')).map((l) => JSON.parse(l));
    expect(events).toHaveLength(22);
    expect(new Set(events.map((e) => e.id)).size).toBe(22);
    expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
    expect((await h.svc.attendanceLog.verifyFromDisk()).ok).toBe(true);
    const o = await must<any>(h.admin('dashboard.overview'));
    expect(o.counts).toMatchObject({ total: 22, present: 22, checkedIn: 22, late: 0, absent: 0 });

    // one phone, two different valid codes at once → exactly one event is saved
    h.clock.t += min(9 * 60);
    const a = h.attendanceToken();
    const b = h.attendanceToken();
    const [r1, r2] = await Promise.all([phones[0].scan(a, 'check-out'), phones[0].scan(b, 'check-out')]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(['NOT_CHECKED_IN', 'TOO_SOON']).toContain([r1, r2].find((r) => r.status === 409)!.body.error.code);
  });

  it('survives a restart: events are recovered and codes issued before the restart are refused', async () => {
    let h = await track(startHost());
    const phone = await enroll(h, ALICE);
    const oldToken = h.attendanceToken();
    expect((await phone.scan(oldToken, 'check-in')).status).toBe(200);
    const staleToken = h.attendanceToken();
    h.clock.t += 1000;
    h = await track(h.restart());
    phone.svc = h.svc;
    expect(h.svc.attendance.eventCount).toBe(1);
    const st = await phone.status();
    expect(st.status).toBe(200);
    expect(st.body.data.status.state).toBe('checked-in');
    const r = await phone.scan(staleToken, 'check-out');
    expect(r.body.error.code).toBe('QR_EXPIRED');
    h.clock.t += min(10 * 60);
    expect((await phone.scan(h.attendanceToken(), 'check-out')).status).toBe(200);
    expect(h.svc.attendanceLog.loadProblems).toEqual([]);
  });

  it('never acknowledges a record that was not saved (disk full) and recovers once space returns', async () => {
    const h = await track(startHost());
    const phone = await enroll(h, ALICE);
    const token = h.attendanceToken();
    const body = await phone.scanBody(token, 'check-in');
    faults.failNext = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    faults.failOps = new Set(['append']);
    const bad = await request(h.svc, 'POST', '/api/attendance', body);
    expect(bad.status).toBe(507);
    expect(bad.body.error.code).toBe('STORAGE_FULL');
    expect(bad.body.error.message).toMatch(/NOT recorded/);
    expect((await readLines(h, 'attendance-events.jsonl')).length).toBe(0);
    expect((await h.svc.health()).storage).toMatchObject({ diskFull: true, status: 'critical' });
    // retry with the same still-valid scan works and clears the alarm
    const ok = await request(h.svc, 'POST', '/api/attendance', body);
    expect(ok.status).toBe(200);
    expect((await h.svc.health()).storage.diskFull).toBe(false);
    expect((await readLines(h, 'attendance-events.jsonl')).length).toBe(1);
  });

  it('refuses new events when the host clock goes backwards until an administrator acknowledges', async () => {
    const h = await track(startHost({ t: MONDAY_9AM - 2 * 3_600_000 }));
    const phone = await enroll(h, ALICE);
    h.clock.t = MONDAY_9AM;
    expect((await phone.scan(h.attendanceToken(), 'check-in')).status).toBe(200);
    const last = h.clock.t;
    h.clock.t = last - 3_600_000;
    const r = await phone.scan(h.attendanceToken(), 'check-out');
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('CLOCK_SUSPECT');
    expect((await h.svc.health()).clock.suspect).toBe(true);
    h.clock.t = last + min(9 * 60);
    expect((await phone.scan(h.attendanceToken(), 'check-out')).body.error.code).toBe('CLOCK_SUSPECT'); // still blocked
    await must(h.admin('host.acknowledgeClock'));
    expect((await phone.scan(h.attendanceToken(), 'check-out')).status).toBe(200);
    expect(h.svc.audit.list({ type: 'system.clock-change' }).length).toBeGreaterThan(0);
  });

  it('rotates the displayed QR on the configured interval', async () => {
    const h = await track(startHost());
    await must(h.admin('settings.update', { rotationSeconds: 1 }));
    const seen: string[] = [];
    h.svc.bus.on('live', (e) => e.type === 'qr' && seen.push(e.data.url));
    h.svc.terminal.start();
    await sleep(2400);
    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(new Set(seen).size).toBe(seen.length);
    for (const u of seen) expect(parseScan(u)?.kind).toBe('attendance');
    h.svc.terminal.stop();
  });
});

describe('manual corrections', () => {
  it('records attributable correction events, never rewrites history, and rejects invalid sequences', async () => {
    const h = await track(startHost());
    const phone = await enroll(h, ALICE);
    expect((await phone.scan(h.attendanceToken(), 'check-in')).status).toBe(200);
    const original = await fs.readFile(path.join(h.dir, 'attendance-events.jsonl'), 'utf8');

    // forgot to check out: add one
    h.clock.t += min(9 * 60);
    const add = await must<any>(h.admin('corrections.apply', { op: 'add', employeeId: 'E-1001', kind: 'check-out', date: '2026-10-12', time: '17:05', reason: 'Phone battery died' }));
    expect(add).toMatchObject({ op: 'add', adminName: 'Owner One', classification: 'normal' });
    let day = (await must<any>(h.admin('attendance.history', { from: '2026-10-12', to: '2026-10-12' }))).rows[0];
    expect(day).toMatchObject({ state: 'checked-out', checkOutLocal: '17:05:00', corrected: true, verification: 'device-signature' });
    expect(day.corrections[0]).toMatch(/Owner One added check-out at 17:05 — Phone battery died/);

    // history is append-only: the original bytes are an exact prefix
    const afterAdd = await fs.readFile(path.join(h.dir, 'attendance-events.jsonl'), 'utf8');
    expect(afterAdd.startsWith(original)).toBe(true);

    // invalid: a second check-out in a row, reason too short, future date
    expect((await h.admin('corrections.apply', { op: 'add', employeeId: 'E-1001', kind: 'check-out', date: '2026-10-12', time: '17:30', reason: 'duplicate attempt' })).ok).toBe(false);
    expect((await h.admin('corrections.apply', { op: 'add', employeeId: 'E-1001', kind: 'check-in', date: '2026-10-12', time: '08:00', reason: 'x' })).ok).toBe(false);
    const fut = await h.admin('corrections.apply', { op: 'add', employeeId: 'E-1001', kind: 'check-in', date: '2026-10-20', time: '08:00', reason: 'Future date test' });
    expect(fut).toMatchObject({ ok: false, error: { code: 'INVALID_CORRECTION' } });

    // amend the check-in time, then void the added check-out
    const inId = day.checkInEventId;
    await must(h.admin('corrections.apply', { op: 'amend', eventId: inId, date: '2026-10-12', time: '08:55', reason: 'Scanned late, arrived earlier' }));
    day = (await must<any>(h.admin('attendance.history', { from: '2026-10-12', to: '2026-10-12' }))).rows[0];
    expect(day.checkInLocal).toBe('08:55:00');
    await must(h.admin('corrections.apply', { op: 'void', eventId: day.checkOutEventId, reason: 'Entered by mistake' }));
    day = (await must<any>(h.admin('attendance.history', { from: '2026-10-12', to: '2026-10-12' }))).rows[0];
    expect(day.state).toBe('checked-in');
    expect(day.corrections).toHaveLength(3);
    expect((await readLines(h, 'attendance-events.jsonl')).length).toBe(4);
    expect(h.svc.audit.list({ limit: 100 }).filter((a) => a.type.startsWith('correction.'))).toHaveLength(3);
    expect((await h.svc.attendanceLog.verifyFromDisk()).ok).toBe(true);
  });
});

describe('Excel export', () => {
  it('produces correctly formatted workbooks, never alters source records, and repeats cleanly', async () => {
    const h = await track(startHost());
    const alice = await enroll(h, ALICE);
    const bob = await enroll(h, BOB);
    await enroll(h, { fullName: 'Carol Rai', employeeId: 'E-1003', phone: '+977 9800000003' }); // never attends → absent
    expect((await alice.scan(h.attendanceToken(), 'check-in')).status).toBe(200);
    h.clock.t += min(20);
    expect((await bob.scan(h.attendanceToken(), 'check-in')).body.data.event.classification).toBe('late');
    h.clock.t += min(8 * 60);
    expect((await alice.scan(h.attendanceToken(), 'check-out')).status).toBe(200);
    await must(h.admin('corrections.apply', { op: 'add', employeeId: 'E-1002', kind: 'check-out', date: '2026-10-12', time: '17:00', reason: 'Forgot to scan out' }));
    h.clock.t += min(60);

    const hashes = async () =>
      Object.fromEntries(await Promise.all(['employees.json', 'devices.json', 'attendance-events.jsonl'].map(async (f) => [f, createHash('sha256').update(await fs.readFile(path.join(h.dir, f))).digest('hex')])));
    const before = await hashes();
    const events: any[] = [];
    h.svc.bus.on('live', (e) => e.type === 'export.progress' && events.push(e.data));

    const daily = await must<any>(h.admin('export.run', { kind: 'daily', date: '2026-10-12' }));
    expect(daily).toMatchObject({ state: 'done', progress: 100, rows: 3 });
    expect(events.some((e) => e.state === 'running' && e.progress > 0 && e.progress < 100)).toBe(true);
    expect(path.dirname(daily.filePath)).toBe(h.svc.exportsDir);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(daily.filePath);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Report', 'Attendance']);
    const ws = wb.getWorksheet('Attendance')!;
    expect(ws.getRow(1).values).toEqual(expect.arrayContaining(['Employee ID', 'Employee Name', 'Phone', 'Date', 'Check-in', 'Check-out', 'Attendance Status', 'Verification Status', 'Device ID', 'Check-in Event ID', 'Correction History']));
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(ws.autoFilter).toBeTruthy();
    const rows = Array.from({ length: ws.rowCount - 1 }, (_, i) => ws.getRow(i + 2).values as any[]).map((v) => v.filter((x) => x !== undefined));
    const byId = Object.fromEntries(rows.map((r) => [r[0], r]));
    expect(byId['E-1001'].join('|')).toMatch(/On time/);
    expect(byId['E-1002'].join('|')).toMatch(/Late \(20 min\)/);
    expect(byId['E-1002'].join('|')).toMatch(/Forgot to scan out/);
    expect(byId['E-1003'].join('|')).toMatch(/Pending|Absent/);
    expect(byId['E-1001'].join('|')).toMatch(/dev_/);

    const complete = await must<any>(h.admin('export.run', { kind: 'complete' }));
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.readFile(complete.filePath);
    expect(wb2.worksheets.map((w) => w.name)).toEqual(['Report', 'Attendance', 'Employees', 'Registered Devices', 'Audit Log', 'Event Log']);
    expect(wb2.getWorksheet('Employees')!.rowCount).toBe(4);
    expect(wb2.getWorksheet('Registered Devices')!.rowCount).toBe(4);
    expect(wb2.getWorksheet('Audit Log')!.rowCount).toBeGreaterThan(5);

    const monthly = await must<any>(h.admin('export.run', { kind: 'monthly', month: '2026-10' }));
    const emp = await must<any>(h.admin('export.run', { kind: 'employee', employeeId: 'E-1002', from: '2026-10-01', to: '2026-10-31' }));
    const range = await must<any>(h.admin('export.run', { kind: 'range', from: '2026-10-12', to: '2026-10-12' }));
    expect(emp.rows).toBeGreaterThan(0);
    expect(new Set([daily.filePath, complete.filePath, monthly.filePath, emp.filePath, range.filePath]).size).toBe(5);
    const daily2 = await must<any>(h.admin('export.run', { kind: 'daily', date: '2026-10-12' }));
    expect(daily2.filePath).not.toBe(daily.filePath); // repeat export → new file, nothing overwritten

    expect(await hashes()).toEqual(before); // source-of-truth files untouched by exporting
    expect((await h.admin('export.run', { kind: 'range', from: '2026-10-12' })).ok).toBe(false);
    expect((await h.admin('export.run', { kind: 'range', from: '2026-10-20', to: '2026-10-01' })).ok).toBe(false);
  });

  it('reports a failed export with a clear error and leaves no partial file', async () => {
    const h = await track(startHost());
    await enroll(h, ALICE);
    faults.failNext = Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    faults.failOps = new Set(['__never__']);
    // simulate an unwritable export folder
    await fs.rm(h.svc.exportsDir, { recursive: true, force: true });
    await fs.writeFile(h.svc.exportsDir, 'i am a file, not a folder');
    const r = await h.admin('export.run', { kind: 'daily', date: '2026-10-12' });
    expect(r.ok).toBe(false);
    expect(h.svc.exporter.status.state).toBe('failed');
    expect(h.svc.exporter.status.error).toBeTruthy();
    await fs.rm(h.svc.exportsDir, { force: true });
    await fs.mkdir(h.svc.exportsDir);
    expect((await h.admin('export.run', { kind: 'daily', date: '2026-10-12' })).ok).toBe(true);
  });
});

describe('administrator authentication and roles', () => {
  it('has no default credentials, allows setup once, and rate-limits failed sign-ins', async () => {
    const h = await track(startHost());
    const fresh = await track(startHost({ extra: {} }));
    expect((await fresh.svc.admin.call('auth.status', undefined, {})).data).toEqual({ setupRequired: false });
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-auth-'));
    const { PulseService } = await import('../src/server/service');
    const raw = await PulseService.create({ dataDir: dir, bindOverride: '127.0.0.1', httpsPortOverride: 0, setupPortOverride: 0, disableTimers: true });
    expect((await raw.admin.call('auth.status', undefined, {})).data).toEqual({ setupRequired: true });
    expect((await raw.admin.call('auth.login', undefined, { username: 'admin', password: 'admin' })).ok).toBe(false);
    expect((await raw.admin.call('auth.setup', undefined, { username: 'boss', displayName: 'Boss', password: 'short' })).ok).toBe(false);
    expect((await raw.admin.call('auth.setup', undefined, { username: 'boss', displayName: 'Boss', password: 'Sufficient-Pass-1' })).ok).toBe(true);
    expect((await raw.admin.call('auth.setup', undefined, { username: 'evil', displayName: 'Evil', password: 'Sufficient-Pass-1' })).ok).toBe(false);
    const text = await fs.readFile(path.join(dir, 'admins.json'), 'utf8');
    expect(text).not.toContain('Sufficient-Pass-1');
    expect(text).toContain('scrypt$');
    await raw.stop();
    await fs.rm(dir, { recursive: true, force: true });

    for (let i = 0; i < 5; i++) expect((await h.svc.admin.call('auth.login', undefined, { username: 'owner', password: 'wrong' + i }, 'local')).error?.code).toBe('BAD_CREDENTIALS');
    const locked = await h.svc.admin.call('auth.login', undefined, { username: 'owner', password: 'Correct-Horse-9' }, 'local');
    expect(locked).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    expect(h.svc.audit.list({ limit: 50 }).map((a) => a.type)).toEqual(expect.arrayContaining(['security.admin-login-failed', 'security.admin-login-locked']));
  });

  it('rejects unauthenticated calls, expired sessions and calls above the caller’s role', async () => {
    const h = await track(startHost());
    expect(await h.svc.admin.call('employees.list', undefined, {})).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(await h.svc.admin.call('employees.list', 'not-a-token', {})).toMatchObject({ ok: false, error: { code: 'UNAUTHENTICATED' } });
    expect(await h.svc.admin.call('does.not.exist', h.session.token, {})).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(await h.svc.admin.call('__proto__', h.session.token, {})).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });

    await must(h.admin('admins.create', { username: 'auditor1', displayName: 'Audrey', role: 'auditor', password: 'Auditor-Pass-123' }));
    await must(h.admin('admins.create', { username: 'clerk1', displayName: 'Clark', role: 'admin', password: 'Clerk-Pass-12345' }));
    const aud = (await must<any>(h.svc.admin.call('auth.login', undefined, { username: 'auditor1', password: 'Auditor-Pass-123' }))).token;
    const clk = (await must<any>(h.svc.admin.call('auth.login', undefined, { username: 'clerk1', password: 'Clerk-Pass-12345' }))).token;
    expect((await h.svc.admin.call('employees.list', aud, {})).ok).toBe(true);
    expect((await h.svc.admin.call('export.run', aud, { kind: 'daily', date: '2026-10-12' })).ok).toBe(true);
    for (const m of ['employees.create', 'requests.approve', 'devices.revoke', 'corrections.apply', 'host.backup', 'terminal.setMode']) {
      expect(await h.svc.admin.call(m, aud, {}), m).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    expect((await h.svc.admin.call('employees.create', clk, { id: 'E-9', fullName: 'New Person', phone: '+9779811111111' })).ok).toBe(true);
    for (const m of ['settings.update', 'admins.list', 'admins.create']) {
      expect(await h.svc.admin.call(m, clk, {}), m).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    // idle expiry
    h.clock.t += 16 * 60_000;
    expect(await h.svc.admin.call('employees.list', aud, {})).toMatchObject({ ok: false, error: { code: 'SESSION_EXPIRED' } });
    // logout kills the session
    const again = (await must<any>(h.svc.admin.call('auth.login', undefined, { username: 'clerk1', password: 'Clerk-Pass-12345' }))).token;
    await must(h.svc.admin.call('auth.logout', again, {}));
    expect(await h.svc.admin.call('employees.list', again, {})).toMatchObject({ ok: false });
  });

  it('validates settings and applies changes (timezone, hours, grace)', async () => {
    const h = await track(startHost());
    expect((await h.admin('settings.update', { workStart: '18:00', workEnd: '09:00' })).ok).toBe(false);
    expect((await h.admin('settings.update', { timezone: 'Mars/Olympus' })).ok).toBe(false);
    expect((await h.admin('settings.update', { allowedCidrs: ['not-a-cidr'] })).ok).toBe(false);
    expect((await h.admin('settings.update', { hostId: 'x' })).ok).toBe(false);
    const s = await must<any>(h.admin('settings.update', { graceMinutes: 30, workStart: '09:30', workEnd: '18:00' }));
    expect(s).toMatchObject({ graceMinutes: 30, workStart: '09:30' });
    expect(JSON.parse(await fs.readFile(path.join(h.dir, 'settings.json'), 'utf8')).graceMinutes).toBe(30);
    expect(h.svc.audit.list({ type: 'settings.changed' })).toHaveLength(1);
  });
});

describe('network and transport security', () => {
  it('serves HTTPS with a certificate chained to the local CA, covering the LAN address', async () => {
    const h = await track(startHost());
    const r = await request(h.svc, 'GET', '/api/info');
    expect(r.status).toBe(200); // request() verifies the chain against the generated CA
    expect(r.body.data).toMatchObject({ name: 'PULSE', rotationSeconds: 3, acceptWindowSeconds: 10 });
    expect(h.svc.tls.names).toEqual(expect.arrayContaining(['127.0.0.1', 'localhost']));
    expect(Date.parse(h.svc.tls.leafExpires) - h.clock.t).toBeLessThan(825 * 86400_000);
    expect(h.svc.tls.caFingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect((await fs.stat(path.join(h.dir, 'host-secrets.json'))).mode & 0o077).toBe(0);
    const ca = await request(h.svc, 'GET', '/pulse-ca.pem');
    expect(ca.raw).toContain('BEGIN CERTIFICATE');
    expect(ca.raw).not.toContain('PRIVATE KEY');
    // restart reuses the CA (phones keep trusting it)
    const fp = h.svc.tls.caFingerprint;
    const h2 = await track(h.restart());
    expect(h2.svc.tls.caFingerprint).toBe(fp);
  });

  it('refuses unknown Host headers, clients outside the network policy, oversized or non-JSON bodies, and unknown routes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-web-'));
    await fs.mkdir(path.join(root, 'web', 'assets'), { recursive: true });
    await fs.writeFile(path.join(root, 'web', 'mobile.html'), '<!doctype html><title>m</title>');
    await fs.writeFile(path.join(root, 'web', 'index.html'), '<!doctype html><title>ADMIN</title>');
    await fs.writeFile(path.join(root, 'web', 'assets', 'a.js'), 'console.log(1)');
    await fs.writeFile(path.join(root, 'secret.js'), 'SECRET');
    const h = await track(startHost({ extra: { webRoot: path.join(root, 'web') } }));

    expect((await request(h.svc, 'GET', '/api/info', undefined, { host: 'evil.example.com' })).status).toBe(421);
    expect((await request(h.svc, 'POST', '/api/attendance', { a: 1 }, { host: 'attacker.test' })).status).toBe(421);
    expect((await request(h.svc, 'GET', '/api/nope')).status).toBe(405);
    expect((await request(h.svc, 'POST', '/api/admin/employees.list', {})).status).toBe(404);
    expect((await request(h.svc, 'POST', '/api/attendance', undefined, { rawBody: 'x'.repeat(20_000), headers: { 'Content-Type': 'application/json' } })).status).toBe(413);
    expect((await request(h.svc, 'POST', '/api/attendance', undefined, { rawBody: 'a=1', headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
    expect((await request(h.svc, 'POST', '/api/attendance', undefined, { rawBody: '{bad json' })).status).toBe(400);
    expect((await request(h.svc, 'POST', '/api/attendance', { deviceId: 'x' })).body.error.code).toBe('BAD_REQUEST');

    // static serving: mobile app only, no traversal, no admin page, no data files
    const page = await request(h.svc, 'GET', '/');
    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(page.headers['permissions-policy']).toMatch(/camera=\(self\)/);
    expect((await request(h.svc, 'GET', '/assets/a.js')).status).toBe(200);
    for (const bad of ['/index.html'.replace('/index.html', '/../secret.js'), '/..%2fsecret.js', '/%2e%2e/secret.js', '/host-secrets.json', '/settings.json', '/assets/../../secret.js', '/index.html']) {
      const r = await request(h.svc, 'GET', bad);
      expect(r.status === 404 || r.raw !== 'SECRET', bad).toBe(true);
      expect(r.raw).not.toContain('SECRET');
      expect(r.raw).not.toContain('ADMIN');
    }

    // network policy
    await must(h.admin('settings.update', { allowedCidrs: ['10.99.0.0/16'] }));
    expect((await request(h.svc, 'GET', '/api/info')).status).toBe(403);
    expect(h.svc.audit.list({ type: 'security.network-denied' }).length).toBeGreaterThan(0);
    await fs.rm(root, { recursive: true, force: true });
  });

  it('throttles registration spam and repeated failed verifications', async () => {
    const h = await track(startHost());
    const phone = await Phone.create(h.svc);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await phone.register('PR1.x.y.z', ALICE)).status);
    expect(codes.slice(0, 5)).toEqual(Array(5).fill(400));
    expect(codes.slice(5)).toEqual([429, 429]);

    const h2 = await track(startHost());
    const real = await enroll(h2, ALICE);
    const mallory = await Phone.create(h2.svc);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const body = await mallory.scanBody(h2.attendanceToken(), 'check-in');
      statuses.push((await request(h2.svc, 'POST', '/api/attendance', { ...body, deviceId: real.deviceId })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
    const sec = h2.svc.audit.securityOverview();
    expect(sec.total).toBeGreaterThan(0);
    expect(sec.flaggedDevices[0].deviceId).toBe(real.deviceId);
  });

  it('streams registration decisions and revocations to phones over WebSocket, and refuses bad handshakes', async () => {
    const h = await track(startHost());
    const connect = () => new WebSocket(`wss://127.0.0.1:${h.svc.http.httpsPort}/ws`, { ca: h.svc.tls.caCertPem, servername: 'localhost', headers: { Host: `127.0.0.1:${h.svc.http.httpsPort}` } });
    const next = (ws: WebSocket) => new Promise<any>((res, rej) => { ws.once('message', (m) => res(JSON.parse(m.toString()))); ws.once('close', (c) => rej(new Error('closed ' + c))); });

    // registration watcher
    const phone = await Phone.create(h.svc);
    await must(h.admin('terminal.setMode', { mode: 'registration' }));
    await phone.register(parseScan(h.svc.terminal.getCurrent().url)!.token, ALICE);
    const w1 = connect();
    await new Promise((r) => w1.once('open', r));
    w1.send(JSON.stringify({ type: 'watch', requestId: phone.requestId, pollSecret: phone.pollSecret }));
    expect((await next(w1)).status).toBe('pending');
    const pushed = next(w1);
    await must(h.admin('requests.approve', { requestId: phone.requestId }));
    expect((await pushed).type).toBe('registration-changed');
    w1.close();

    // device socket: signed hello, then revocation push
    const w2 = connect();
    await new Promise((r) => w2.once('open', r));
    const nonce = (await request(h.svc, 'GET', '/api/device/nonce')).body.data.nonce;
    const signature = await phone.sign(signingMessage({ purpose: 'live', hostId: h.svc.hostId, deviceId: phone.deviceId, challenge: nonce }));
    w2.send(JSON.stringify({ type: 'hello', deviceId: phone.deviceId, nonce, signature }));
    expect((await next(w2)).type).toBe('ready');
    expect((await h.svc.health()).wsClients).toBe(1);
    const closed = new Promise<number>((res) => w2.once('close', (c) => res(c)));
    const msg = next(w2);
    await must(h.admin('devices.revoke', { deviceId: phone.deviceId, reason: 'Lost phone' }));
    expect((await msg).type).toBe('revoked');
    expect(await closed).toBe(4003);

    // bad signature is refused
    const w3 = connect();
    await new Promise((r) => w3.once('open', r));
    const n2 = (await request(h.svc, 'GET', '/api/device/nonce')).body.data.nonce;
    w3.send(JSON.stringify({ type: 'hello', deviceId: phone.deviceId, nonce: n2, signature: 'A'.repeat(86) }));
    expect((await next(w3)).type).toBe('error');

    // cross-origin websocket refused
    const evil = new WebSocket(`wss://127.0.0.1:${h.svc.http.httpsPort}/ws`, { ca: h.svc.tls.caCertPem, servername: 'localhost', headers: { Origin: 'https://evil.example', Host: `127.0.0.1:${h.svc.http.httpsPort}` } });
    await new Promise<void>((res) => { evil.once('unexpected-response', () => res()); evil.once('error', () => res()); });
  });

  it('keeps the administrator live channel on loopback, authenticated, origin-checked and privacy-trimmed', async () => {
    const h = await track(startHost());
    const phone = await enroll(h, ALICE);
    const url = h.svc.live.url;
    expect(url.startsWith('ws://127.0.0.1:')).toBe(true);
    const open = (origin: string) => new Promise<WebSocket>((res, rej) => {
      const w = new WebSocket(url, { headers: { Origin: origin } });
      w.once('open', () => res(w));
      w.once('unexpected-response', () => rej(new Error('rejected')));
      w.once('error', () => rej(new Error('error')));
    });
    await expect(open('https://evil.example')).rejects.toThrow();
    await expect(open('')).rejects.toThrow();

    const collect = (w: WebSocket) => { const out: any[] = []; w.on('message', (m) => out.push(JSON.parse(m.toString()))); return out; };
    const bad = await open('app://pulse');
    const badMsgs = collect(bad);
    bad.send(JSON.stringify({ type: 'auth', token: 'nope' }));
    await sleep(150);
    expect(badMsgs[0]).toMatchObject({ type: 'error', code: 'UNAUTHENTICATED' });

    const adminWs = await open('app://pulse');
    const aMsgs = collect(adminWs);
    adminWs.send(JSON.stringify({ type: 'auth', token: h.session.token }));
    const termWs = await open('app://pulse');
    const tMsgs = collect(termWs);
    termWs.send(JSON.stringify({ type: 'auth', terminalKey: h.svc.terminalKey }));
    await sleep(150);
    expect(aMsgs[0]).toMatchObject({ type: 'ready', role: 'admin' });
    expect(tMsgs[0]).toMatchObject({ type: 'ready', role: 'terminal' });

    expect((await phone.scan(h.attendanceToken(), 'check-in')).status).toBe(200);
    await sleep(200);
    const aSaved = aMsgs.find((m) => m.event?.type === 'attendance.saved');
    const tSaved = tMsgs.find((m) => m.event?.type === 'attendance.saved');
    expect(aSaved.event.data.event.employeeId).toBe('E-1001');
    expect(tSaved.event.data.event.employeeId).toBe('');
    expect(tSaved.event.data.event.deviceId).toBe('');
    expect(JSON.stringify(tMsgs)).not.toContain(phone.deviceId);
    expect(tMsgs.some((m) => m.event?.type === 'audit' || m.event?.type === 'request.created')).toBe(false);
    adminWs.close();
    termWs.close();
  });
});

describe('integrity, backup and recovery', () => {
  it('detects tampering, takes backups and recovers a torn log on restart', async () => {
    let h = await track(startHost());
    const phone = await enroll(h, ALICE);
    expect((await phone.scan(h.attendanceToken(), 'check-in')).status).toBe(200);
    const ok = await must<any>(h.admin('host.verifyIntegrity'));
    expect(ok.ok).toBe(true);
    const bk = await must<any>(h.admin('host.backup'));
    expect(bk.files).toEqual(expect.arrayContaining(['employees.json', 'devices.json', 'attendance-events.jsonl', 'audit-log.jsonl']));

    // an edit made with the file closed to the app is caught by the next check
    const f = path.join(h.dir, 'attendance-events.jsonl');
    const txt = await fs.readFile(f, 'utf8');
    await fs.writeFile(f, txt.replace('"check-in"', '"check-out"'));
    const bad = await must<any>(h.admin('host.verifyIntegrity'));
    expect(bad.ok).toBe(false);
    expect(bad.files.find((x: any) => x.file === 'attendance-events.jsonl').problems.join(' ')).toMatch(/modified after writing/);
    expect((await h.svc.health()).storage.status).toBe('critical');
    await fs.writeFile(f, txt); // restore

    // crash in the middle of an append
    await fs.appendFile(f, '{"id":"evt_torn","type":"attendance"');
    h = await track(h.restart());
    expect(h.svc.attendance.eventCount).toBe(1);
    expect(h.svc.recoveryNotes.some((n) => /interrupted write/.test(n.message))).toBe(true);
    expect(h.svc.attendanceLog.recoveryNotes.join(' ')).toMatch(/interrupted write/);
    expect((await h.svc.health()).storage.status).not.toBe('ok');
    expect((await fs.readdir(h.dir)).some((n) => n.startsWith('attendance-events.jsonl.torn-'))).toBe(true);

    // corrupt employees.json → restored from the last good copy (one change older), noted loudly
    await must(h.admin('employees.create', { id: 'E-7777', fullName: 'Late Joiner', phone: '+9779811111111' }));
    await fs.writeFile(path.join(h.dir, 'employees.json'), '{{{ corrupt');
    h = await track(h.restart());
    expect(h.svc.employees.list().map((e) => e.id)).toContain('E-1001');
    expect(h.svc.recoveryNotes.some((n) => /restored from its last good backup/.test(n.message))).toBe(true);
    expect((await fs.readdir(path.join(h.dir, 'backups'))).some((n) => n.endsWith('-auto'))).toBe(true); // daily automatic copy exists
  });
});
