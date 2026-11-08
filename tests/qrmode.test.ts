import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isPermanentToken, parseScan } from '../src/shared/protocol';
import { enroll, must, request, startHost, type TestHost } from './helpers';

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

const ALICE = { fullName: 'Alice Sharma', employeeId: 'E-1001', phone: '+977 9800000001' };
const tokenOf = (h: TestHost) => parseScan(h.svc.terminal.getCurrent().url)!.token;
const qrMode = (h: TestHost) => must<any>(h.admin('qrmode.get'));

describe('QR code modes: selection, persistence and exclusivity', () => {
  it('defaults to the timer mode and keeps rotating exactly as before', async () => {
    const h = await track(startHost());
    expect((await qrMode(h)).activeMode).toBe('timer');
    const a = h.svc.terminal.rotate();
    h.clock.t += 3000;
    const b = h.svc.terminal.rotate();
    expect(a.url).not.toBe(b.url);
    expect(a.qrMode).toBe('timer');
    expect(a.rotationMs).toBe(3000);
    await must(h.admin('settings.update', { rotationSeconds: 7 }));
    expect(h.svc.terminal.getCurrent().rotationMs).toBe(7000);
  });

  it('permanent mode shows one unchanging code that is not an expiring challenge', async () => {
    const h = await track(startHost());
    const r = await must<any>(h.admin('qrmode.set', { mode: 'permanent' }));
    expect(r.qrMode.activeMode).toBe('permanent');
    expect(r.qr.qrMode).toBe('permanent');
    const first = tokenOf(h);
    expect(isPermanentToken(first)).toBe(true);
    expect(first).not.toMatch(/E-\d|Alice|@/);
    h.clock.t += 24 * 3600_000;
    h.svc.terminal.rotate();
    expect(tokenOf(h)).toBe(first);
    expect(h.svc.terminal.getCurrent().expiresAt).toBe(0);
  });

  it('the permanent code and the selected mode survive browser refreshes and server restarts', async () => {
    const h = await track(startHost());
    await must(h.admin('qrmode.set', { mode: 'permanent' }));
    const token = tokenOf(h);
    const h2 = await track(h.restart());
    expect((await qrMode(h2)).activeMode).toBe('permanent');
    expect(tokenOf(h2)).toBe(token);
    h2.svc.terminal.rotate();
    expect(tokenOf(h2)).toBe(token);
    const raw = JSON.parse(await fs.readFile(path.join(h2.dir, 'qr-mode.json'), 'utf8'));
    expect(raw).toMatchObject({ schemaVersion: 1, activeMode: 'permanent' });
  });

  it('timer mode persists across a restart too', async () => {
    const h = await track(startHost());
    await must(h.admin('qrmode.set', { mode: 'permanent' }));
    await must(h.admin('qrmode.set', { mode: 'timer' }));
    const h2 = await track(h.restart());
    expect((await qrMode(h2)).activeMode).toBe('timer');
    expect(h2.svc.terminal.getCurrent().qrMode).toBe('timer');
  });

  it('switching is mutually exclusive and idempotent; the admin view reports exactly one active mode', async () => {
    const h = await track(startHost());
    const v0 = await qrMode(h);
    await must(h.admin('qrmode.set', { mode: 'timer' }));
    expect((await qrMode(h)).revision).toBe(v0.revision);
    const p = await must<any>(h.admin('qrmode.set', { mode: 'permanent' }));
    expect(p.qrMode.activeMode).toBe('permanent');
    const t = await must<any>(h.admin('qrmode.set', { mode: 'timer' }));
    expect(t.qrMode.activeMode).toBe('timer');
    expect(t.qr.qrMode).toBe('timer');
    expect(t.qrMode.revision).toBe(v0.revision + 2);
  });

  it('concurrent administrators cannot leave both modes active, and stale changes are refused', async () => {
    const h = await track(startHost());
    const rev = (await qrMode(h)).revision;
    const results = await Promise.all([
      h.admin('qrmode.set', { mode: 'permanent', expectedRevision: rev }),
      h.admin('qrmode.set', { mode: 'timer', expectedRevision: rev }),
      h.admin('qrmode.set', { mode: 'permanent', expectedRevision: rev }),
    ]);
    const okCount = results.filter((r) => r.ok).length;
    const conflicts = results.filter((r) => !r.ok && r.error.code === 'QR_MODE_CONFLICT').length;
    expect(okCount).toBeGreaterThanOrEqual(1);
    expect(okCount + conflicts).toBe(3);
    const after = await qrMode(h);
    expect(['timer', 'permanent']).toContain(after.activeMode);
    const raw = JSON.parse(await fs.readFile(path.join(h.dir, 'qr-mode.json'), 'utf8'));
    expect(raw.activeMode).toBe(after.activeMode);

    const unpinned = await Promise.all(Array.from({ length: 12 }, (_, i) => h.admin('qrmode.set', { mode: i % 2 ? 'timer' : 'permanent' })));
    expect(unpinned.every((r) => r.ok)).toBe(true);
    const final = await qrMode(h);
    expect(h.svc.terminal.getCurrent().qrMode).toBe(final.activeMode);
    expect(JSON.parse(await fs.readFile(path.join(h.dir, 'qr-mode.json'), 'utf8')).activeMode).toBe(final.activeMode);
  });

  it('regenerating replaces the permanent code and the old one stops working', async () => {
    const h = await track(startHost());
    await must(h.admin('qrmode.set', { mode: 'permanent' }));
    const old = tokenOf(h);
    const r = await must<any>(h.admin('qrmode.regeneratePermanent'));
    expect(r.qrMode.permanentGeneration).toBe(2);
    const fresh = tokenOf(h);
    expect(fresh).not.toBe(old);
    expect(h.svc.qrMode.verifyPermanent(old)).toEqual({ ok: false, code: 'QR_EXPIRED' });
    expect(h.svc.qrMode.verifyPermanent(fresh).ok).toBe(true);
    const stale = await h.admin('qrmode.regeneratePermanent', { expectedRevision: 0 });
    expect(stale.ok).toBe(false);
    expect((stale as any).error.code).toBe('QR_MODE_CONFLICT');
  });

  it('only administrators with write access can change the mode, and changes are audited', async () => {
    const h = await track(startHost());
    await must(h.admin('admins.create', { username: 'auditor1', displayName: 'Audit One', role: 'auditor', password: 'Another-Pass-77x' }));
    const aud = await h.svc.adminAuth.login({ username: 'auditor1', password: 'Another-Pass-77x' }, 'test');
    const denied = await h.admin('qrmode.set', { mode: 'permanent' }, aud.token);
    expect(denied.ok).toBe(false);
    expect((await h.admin('qrmode.get', undefined, aud.token)).ok).toBe(true);
    expect((await h.admin('qrmode.regeneratePermanent', {}, aud.token)).ok).toBe(false);
    expect((await h.admin('qrmode.set', { mode: 'bogus' })).ok).toBe(false);
    expect((await h.admin('qrmode.set', { mode: 'permanent' }, 'not-a-session')).ok).toBe(false);
    await must(h.admin('qrmode.set', { mode: 'permanent' }));
    const log = await fs.readFile(path.join(h.dir, 'audit-log.jsonl'), 'utf8');
    expect(log).toMatch(/qr-mode\.changed/);
  });

  it('a corrupted mode file falls back to the safe timer default', async () => {
    const h = await track(startHost());
    await must(h.admin('qrmode.set', { mode: 'permanent' }));
    await h.stop();
    await fs.writeFile(path.join(h.dir, 'qr-mode.json'), JSON.stringify({ schemaVersion: 1, revision: 5, activeMode: 'permanent', permanent: null, changedAt: 'x', changedBy: 'y' }));
    await fs.rm(path.join(h.dir, 'qr-mode.json.bak'), { force: true });
    const h2 = await track(startHost({ dir: h.dir, t: h.clock.t }));
    expect((await qrMode(h2)).activeMode).toBe('timer');
  });
});

describe('QR validation on the server per mode', () => {
  it('permanent mode: accepts the permanent code with a fresh server nonce, rejects rotating codes, replays and forgeries', async () => {
    const h = await track(startHost());
    const phone = await enroll(h, ALICE);
    const timerToken = tokenOf(h);
    await must(h.admin('qrmode.set', { mode: 'permanent' }));
    const perm = tokenOf(h);

    let r = await phone.scan(timerToken, 'check-in');
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe('QR_INACTIVE');

    const noNonce = await phone.scan(perm, 'check-in');
    expect(noNonce.status).toBe(409);
    expect(noNonce.body.error.code).toBe('NONCE_INVALID');
    h.svc.phone.resetRateLimits();

    const tampered = perm.slice(0, -2) + (perm.endsWith('AA') ? 'BB' : 'AA');
    r = await phone.scanPermanent(tampered, 'check-in');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('QR_INVALID');
    h.svc.phone.resetRateLimits();

    const body = await phone.scanBody(perm, 'check-in', await phone.serverNonce());
    r = await request(h.svc, 'POST', '/api/attendance', body);
    expect(r.status).toBe(200);
    expect(r.body.data.event.kind).toBe('check-in');
    expect(r.body.data.employee.id).toBe('E-1001');

    h.clock.t += 120_000;
    r = await request(h.svc, 'POST', '/api/attendance', body);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('NONCE_INVALID');

    h.clock.t += 120_000;
    r = await phone.scanPermanent(perm, 'check-out');
    expect(r.status).toBe(200);
    expect(r.body.data.event.kind).toBe('check-out');
  });

  it('a permanent scan works again the next day with the very same code', async () => {
    const h = await track(startHost());
    const phone = await enroll(h, ALICE);
    await must(h.admin('qrmode.set', { mode: 'permanent' }));
    const perm = tokenOf(h);
    expect((await phone.scanPermanent(perm, 'check-in')).status).toBe(200);
    h.clock.t += 60_000 * 60 * 8;
    expect((await phone.scanPermanent(perm, 'check-out')).status).toBe(200);
    const h2 = await track(h.restart());
    h2.clock.t += 60_000 * 60 * 16;
    const phone2 = Object.assign(Object.create(Object.getPrototypeOf(phone)), phone, { svc: h2.svc });
    expect((await phone2.scanPermanent(tokenOf(h2), 'check-in')).status).toBe(200);
  });

  it('timer mode: permanent codes are rejected and rotating codes keep their expiry and replay rules', async () => {
    const h = await track(startHost());
    const phone = await enroll(h, ALICE);
    await must(h.admin('qrmode.set', { mode: 'permanent' }));
    const perm = tokenOf(h);
    await must(h.admin('qrmode.set', { mode: 'timer' }));

    let r = await phone.scanPermanent(perm, 'check-in');
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe('QR_INACTIVE');
    h.svc.phone.resetRateLimits();

    const token = h.attendanceToken();
    h.clock.t += 60_000;
    r = await phone.scan(token, 'check-in');
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe('QR_EXPIRED');
    h.svc.phone.resetRateLimits();

    const live = h.attendanceToken();
    const body = await phone.scanBody(live, 'check-in');
    r = await request(h.svc, 'POST', '/api/attendance', body);
    expect(r.status).toBe(200);
    r = await request(h.svc, 'POST', '/api/attendance', body);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('REPLAY');
  });

  it('switching modes invalidates codes of the previous mode immediately', async () => {
    const h = await track(startHost());
    const phone = await enroll(h, ALICE);
    const timerToken = tokenOf(h);
    await must(h.admin('qrmode.set', { mode: 'permanent' }));
    const r = await phone.scan(timerToken, 'check-in');
    expect(r.body.error.code).toBe('QR_INACTIVE');
    await must(h.admin('qrmode.set', { mode: 'timer' }));
    h.svc.phone.resetRateLimits();
    const again = await phone.scan(timerToken, 'check-in');
    expect(again.status).toBe(200);
  });

  it('the permanent QR carries no employee information', async () => {
    const h = await track(startHost());
    await enroll(h, ALICE);
    await must(h.admin('qrmode.set', { mode: 'permanent' }));
    const url = h.svc.terminal.getCurrent().url;
    expect(url).not.toMatch(/Alice|Sharma|E-1001|9800000001/);
    const parts = tokenOf(h).split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('PP1');
  });
});
