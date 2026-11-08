import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { b64u, parseScan, signingMessage } from '../src/shared/protocol';
import { ChallengeAuthority, NonceStore, RegistrationTokens, ReplayGuard } from '../src/server/tokens';
import { NetPolicy } from '../src/server/netpolicy';
import { RateLimiter } from '../src/server/ratelimit';
import { hashPassword, passwordProblems, verifyDeviceSignature, verifyPassword } from '../src/server/crypto';
import { addDays, eachDate, localParts, localToUtcMs, monthRange, weekdayOf } from '../src/server/time';
import { buildDayRecord, classifyCheckIn, classifyCheckOut, foldLog, secondsOfDay } from '../src/server/domain/derive';
import type { AttendanceEvent, CorrectionEvent, Employee } from '../src/shared/types';
import { Phone, startHost } from './helpers';

describe('time helpers', () => {
  it('converts between UTC and the office timezone (Asia/Kathmandu, UTC+5:45)', () => {
    const p = localParts(Date.parse('2026-10-12T03:15:00Z'), 'Asia/Kathmandu');
    expect(p).toMatchObject({ date: '2026-10-12', time: '09:00:00', minutes: 540, weekday: 1 });
    expect(new Date(localToUtcMs('2026-10-12', '09:00:00', 'Asia/Kathmandu')).toISOString()).toBe('2026-10-12T03:15:00.000Z');
  });
  it('handles DST zones both ways', () => {
    const ms = localToUtcMs('2026-07-01', '08:30:00', 'America/New_York');
    expect(new Date(ms).toISOString()).toBe('2026-07-01T12:30:00.000Z');
    expect(localParts(ms, 'America/New_York').time).toBe('08:30:00');
  });
  it('date arithmetic', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(eachDate('2026-10-30', '2026-11-02')).toHaveLength(4);
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(weekdayOf('2026-10-10')).toBe(6);
  });
});

describe('QR challenges', () => {
  const key = randomBytes(32);
  const auth = new ChallengeAuthority(key, 'hostABCDEFGH', 1_000_000);
  it('accepts a fresh token and rejects expired, tampered, foreign and pre-restart tokens', () => {
    const { token, cid } = auth.issue(2_000_000);
    expect(auth.verify(token, 2_005_000, 10_000)).toMatchObject({ ok: true, cid });
    expect(auth.verify(token, 2_010_001, 10_000)).toEqual({ ok: false, code: 'QR_EXPIRED' });
    const parts = token.split('.');
    expect(auth.verify([...parts.slice(0, 2), 'AAAAAAAAAAAAAAAA', ...parts.slice(3)].join('.'), 2_001_000, 10_000)).toEqual({ ok: false, code: 'QR_INVALID' });
    expect(new ChallengeAuthority(randomBytes(32), 'hostABCDEFGH', 0).verify(token, 2_001_000, 10_000)).toEqual({ ok: false, code: 'QR_INVALID' });
    expect(new ChallengeAuthority(key, 'otherHostXYZ', 0).verify(token, 2_001_000, 10_000)).toEqual({ ok: false, code: 'QR_INVALID' });
    expect(auth.verify(token, 1_990_000, 10_000)).toEqual({ ok: false, code: 'QR_INVALID' }); // from the future
    const old = new ChallengeAuthority(key, 'hostABCDEFGH', 2_500_000);
    expect(old.verify(token, 2_001_000, 10_000)).toEqual({ ok: false, code: 'QR_EXPIRED' });
  });
  it('contains no personal data and stays short enough for a small QR', () => {
    const { token } = auth.issue(Date.now());
    expect(token).toMatch(/^PL1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[a-z0-9]+\.[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThan(90);
  });
  it('registration tokens are single-use and expire', () => {
    const reg = new RegistrationTokens(key, 'hostABCDEFGH');
    const { token } = reg.issue({ type: 'registration', issuedBy: 'a', nowMs: 1000, ttlMs: 5000 });
    expect(reg.peek(token, 2000).ok).toBe(true);
    expect(reg.consume(token, 2000).ok).toBe(true);
    expect(reg.consume(token, 2001)).toEqual({ ok: false, reason: 'used' });
    const t2 = reg.issue({ type: 'registration', issuedBy: 'a', nowMs: 1000, ttlMs: 5000 }).token;
    expect(reg.consume(t2, 7000)).toEqual({ ok: false, reason: 'expired' });
    expect(reg.consume('PR1.hostABCDEFGH.zzz.zzz', 1)).toEqual({ ok: false, reason: 'invalid' });
  });
  it('replay guard and nonce store are single-use', () => {
    const g = new ReplayGuard();
    expect(g.claim('k', 0, 1000)).toBe(true);
    expect(g.claim('k', 1, 1000)).toBe(false);
    g.release('k');
    expect(g.claim('k', 2, 1000)).toBe(true);
    const n = new NonceStore();
    const { nonce } = n.issue(0, 1000);
    expect(n.consume(nonce, 10)).toBe(true);
    expect(n.consume(nonce, 11)).toBe(false);
    const late = n.issue(0, 1000).nonce;
    expect(n.consume(late, 5000)).toBe(false);
  });
});

describe('scan parsing', () => {
  it('extracts tokens from URLs and bare strings and rejects junk', () => {
    expect(parseScan('https://192.168.1.5:8443/#a=PL1.h.c.1.m')).toEqual({ kind: 'attendance', token: 'PL1.h.c.1.m' });
    expect(parseScan('PR1.h.t.m')).toEqual({ kind: 'registration', token: 'PR1.h.t.m' });
    expect(parseScan('https://x/#r=PR1.h.t.m')?.kind).toBe('registration');
    expect(parseScan('https://example.com')).toBeNull();
    expect(parseScan('<script>')).toBeNull();
    expect(parseScan('x'.repeat(500))).toBeNull();
  });
  it('base64url round-trips', () => {
    const b = randomBytes(33);
    expect(Buffer.from(b64u.decode(b64u.encode(b)))).toEqual(b);
  });
});

describe('network policy and rate limiter', () => {
  it('allows only configured IPv4 ranges (and maps IPv6-wrapped IPv4)', () => {
    const p = new NetPolicy(['192.168.1.0/24', '10.0.0.0/8']);
    expect(p.allows('192.168.1.77')).toBe(true);
    expect(p.allows('::ffff:10.2.3.4')).toBe(true);
    expect(p.allows('192.168.2.1')).toBe(false);
    expect(p.allows('8.8.8.8')).toBe(false);
    expect(p.allows('2001:db8::1')).toBe(false);
    expect(p.allows(undefined)).toBe(false);
  });
  it('sliding window blocks after max hits and recovers', () => {
    const r = new RateLimiter(3, 1000);
    expect([0, 1, 2].every((i) => r.hit('k', i).allowed)).toBe(true);
    expect(r.hit('k', 3).allowed).toBe(false);
    expect(r.hit('k', 1500).allowed).toBe(true);
  });
});

describe('passwords and signatures', () => {
  it('hashes with scrypt, verifies, and enforces strength', async () => {
    const h = await hashPassword('Correct-Horse-9');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('Correct-Horse-9', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(passwordProblems('short').length).toBeGreaterThan(0);
    expect(passwordProblems('Correct-Horse-9')).toEqual([]);
  });
  it('verifies WebCrypto ECDSA P1363 signatures and rejects tampering', async () => {
    const host = await startHost();
    try {
      const phone = await Phone.create(host.svc);
      const msg = signingMessage({ purpose: 'status', hostId: 'h', deviceId: phone.deviceId, challenge: 'abc' });
      const sig = await phone.sign(msg);
      expect(verifyDeviceSignature(phone.jwk, msg, sig)).toBe(true);
      expect(verifyDeviceSignature(phone.jwk, msg + 'x', sig)).toBe(false);
      expect(verifyDeviceSignature(phone.jwk, msg, sig.slice(2) + 'AA')).toBe(false);
      const other = await Phone.create(host.svc);
      expect(verifyDeviceSignature(other.jwk, msg, sig)).toBe(false);
    } finally {
      await host.stop();
    }
  });
});

describe('attendance derivation', () => {
  const settings = { timezone: 'Asia/Kathmandu', workStart: '09:00', workEnd: '17:00', graceMinutes: 10, workDays: [1, 2, 3, 4, 5], allowOffDayAttendance: true };
  const emp: Employee = { id: 'E1', fullName: 'A B', phone: '+9779800000000', department: '', status: 'active', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
  const ev = (seq: number, id: string, kind: 'check-in' | 'check-out', iso: string): AttendanceEvent => {
    const lp = localParts(Date.parse(iso), settings.timezone);
    const cls = kind === 'check-in' ? classifyCheckIn(secondsOfDay(lp.time), lp.date, settings) : classifyCheckOut(lp.minutes, lp.date, settings);
    return { v: 1, id, type: 'attendance', kind, employeeId: 'E1', deviceId: 'dev_x', ts: iso, tz: settings.timezone, localDate: lp.date, localTime: lp.time, classification: cls.classification, minutes: cls.minutes, verification: 'device-signature', challengeId: 'c', remoteAddr: '1', seq, prevHash: '', hash: '' };
  };
  it('classifies grace, late, early leave and off-days', () => {
    expect(classifyCheckIn(540 * 60, '2026-10-12', settings).classification).toBe('on-time');
    expect(classifyCheckIn(540 * 60 + 1, '2026-10-12', settings)).toEqual({ classification: 'grace', minutes: 1 });
    expect(classifyCheckIn(550 * 60, '2026-10-12', settings)).toEqual({ classification: 'grace', minutes: 10 });
    expect(classifyCheckIn(550 * 60 + 1, '2026-10-12', settings)).toEqual({ classification: 'late', minutes: 11 });
    expect(classifyCheckIn(551 * 60, '2026-10-12', settings)).toEqual({ classification: 'late', minutes: 11 });
    expect(classifyCheckOut(16 * 60, '2026-10-12', settings)).toEqual({ classification: 'early-leave', minutes: 60 });
    expect(classifyCheckOut(17 * 60, '2026-10-12', settings).classification).toBe('normal');
    expect(classifyCheckIn(540 * 60, '2026-10-11', settings).classification).toBe('off-day'); // Sunday
  });
  it('builds a day record with worked time and applies corrections without mutating history', () => {
    const log = [ev(1, 'a', 'check-in', '2026-10-12T03:15:00Z'), ev(2, 'b', 'check-out', '2026-10-12T11:15:00Z')];
    const view = foldLog(log, settings.timezone);
    const rec = buildDayRecord(emp, '2026-10-12', view.events, [], { settings, nowMs: Date.parse('2026-10-12T12:00:00Z') });
    expect(rec).toMatchObject({ status: 'present', state: 'checked-out', workedMinutes: 480, earlyLeave: false, corrected: false });

    const corr: CorrectionEvent = { v: 1, id: 'c1', type: 'correction', op: 'void', employeeId: 'E1', targetEventId: 'b', tz: settings.timezone, reason: 'Wrong tap', adminId: 'adm', adminName: 'Owner', recordedAt: '2026-10-12T11:00:00Z', seq: 3, prevHash: '', hash: '' };
    const view2 = foldLog([...log, corr], settings.timezone);
    const rec2 = buildDayRecord(emp, '2026-10-12', view2.events, view2.history.get('E1|2026-10-12') ?? [], { settings, nowMs: Date.parse('2026-10-13T12:00:00Z') });
    expect(rec2.state).toBe('checked-in');
    expect(rec2.missingCheckOut).toBe(true);
    expect(rec2.corrected).toBe(true);
    expect(rec2.corrections[0]).toMatch(/voided check-out.*Wrong tap/);
    expect(log).toHaveLength(2); // original input untouched
  });
  it('reports absent / pending correctly', () => {
    const noon = Date.parse('2026-10-12T06:15:00Z'); // 12:00 local
    const evening = Date.parse('2026-10-12T14:00:00Z'); // 19:45 local
    expect(buildDayRecord(emp, '2026-10-12', [], [], { settings, nowMs: noon }).status).toBe('pending');
    expect(buildDayRecord(emp, '2026-10-12', [], [], { settings, nowMs: evening }).status).toBe('absent');
    expect(buildDayRecord(emp, '2026-10-11', [], [], { settings, nowMs: noon }).status).toBe('off-day');
  });
});
