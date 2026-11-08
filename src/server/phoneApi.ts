import { z } from 'zod';
import { ERROR_MESSAGES, isPermanentToken, signingMessage } from '../shared/protocol';
import type { Device } from '../shared/types';
import { AttendanceService } from './domain/attendance';
import { verifyDeviceSignature } from './crypto';
import type { PulseContext } from './context';
import { PulseError } from './errors';
import { normalizeIp } from './netpolicy';
import { RateLimiter } from './ratelimit';

export interface RequestCtx {
  ip: string;
}

const b64uRe = /^[A-Za-z0-9_-]+$/;
const deviceIdSchema = z.string().regex(/^dev_[A-Za-z0-9_-]{22}$/);
const sigSchema = z.string().regex(b64uRe).length(86); // 64-byte P1363 signature, base64url
const tokenSchema = z.string().max(300).regex(/^[A-Za-z0-9_.-]+$/);

const attendanceBody = z.object({
  deviceId: deviceIdSchema,
  token: tokenSchema,
  intent: z.enum(['check-in', 'check-out', 'auto']),
  clientNonce: z.string().regex(b64uRe).min(8).max(64),
  signature: sigSchema,
  idempotencyKey: z.string().regex(b64uRe).min(8).max(64).optional(),
});
type AttendanceBody = z.infer<typeof attendanceBody>;
const statusBody = z.object({ deviceId: deviceIdSchema, nonce: z.string().regex(b64uRe).max(64), signature: sigSchema });
const registerStatusBody = z.object({ requestId: z.string().max(60), pollSecret: z.string().regex(b64uRe).max(64) });
const registerBody = z.object({ token: tokenSchema }).passthrough();

function err(code: string, status: number, message?: string, details?: Record<string, unknown>): PulseError {
  return new PulseError(code, message ?? ERROR_MESSAGES[code] ?? code, status, details);
}

/** Everything a phone may ask the host to do. Transport-independent (HTTP and tests call this directly). */
export class PhoneApi {
  private registrationLimiter = new RateLimiter(5, 10 * 60_000);
  private peekLimiter = new RateLimiter(30, 60_000);
  private pollLimiter = new RateLimiter(120, 60_000);
  private nonceLimiter = new RateLimiter(60, 60_000);
  private submitLimiter = new RateLimiter(30, 60_000);
  private failureLimiterIp = new RateLimiter(10, 5 * 60_000);
  private failureLimiterDevice = new RateLimiter(15, 5 * 60_000);
  private readonly idem = new Map<string, { exp: number; sig: string; token: string; intent: string; nonce: string; promise: Promise<unknown> }>();

  constructor(private readonly ctx: PulseContext) {}

  /** Clears all throttling counters (administrator recovery after a lock-out, and test harnesses). */
  resetRateLimits(): void {
    this.registrationLimiter = new RateLimiter(5, 10 * 60_000);
    this.peekLimiter = new RateLimiter(30, 60_000);
    this.pollLimiter = new RateLimiter(120, 60_000);
    this.nonceLimiter = new RateLimiter(60, 60_000);
    this.submitLimiter = new RateLimiter(30, 60_000);
    this.failureLimiterIp = new RateLimiter(10, 5 * 60_000);
    this.failureLimiterDevice = new RateLimiter(15, 5 * 60_000);
  }

  // ───────────── guards ─────────────
  private ip(c: RequestCtx): string {
    return normalizeIp(c.ip);
  }

  private async networkGate(c: RequestCtx): Promise<void> {
    if (!this.ctx.netPolicy.allows(c.ip)) {
      await this.ctx.audit.recordThrottled(`netdeny:${this.ip(c)}`, {
        type: 'security.network-denied',
        severity: 'warning',
        actor: 'anonymous',
        summary: `Request from ${this.ip(c)} refused by the network policy`,
        details: { ip: this.ip(c) },
      });
      throw err('NETWORK_DENIED', 403);
    }
  }

  private async rateGate(limiter: RateLimiter, key: string, c: RequestCtx, what: string): Promise<void> {
    const r = limiter.hit(key, this.ctx.now());
    if (!r.allowed) {
      await this.ctx.audit.recordThrottled(`rate:${what}:${this.ip(c)}`, {
        type: 'security.rate-limited',
        severity: 'notice',
        actor: 'anonymous',
        summary: `${what} rate limit hit by ${this.ip(c)}`,
        details: { ip: this.ip(c), what },
      });
      throw err('RATE_LIMITED', 429, undefined, { retryAfterMs: r.retryAfterMs });
    }
  }

  private async failureGate(c: RequestCtx, deviceId?: string): Promise<void> {
    const t = this.ctx.now();
    const a = this.failureLimiterIp.blocked(`ip:${this.ip(c)}`, t);
    const b = deviceId ? this.failureLimiterDevice.blocked(`dev:${deviceId}`, t) : { blocked: false, retryAfterMs: 0 };
    if (a.blocked || b.blocked) {
      await this.ctx.audit.recordThrottled(`lockout:${this.ip(c)}:${deviceId ?? ''}`, {
        type: 'security.rate-limited',
        severity: 'warning',
        actor: deviceId ? `device:${deviceId}` : 'anonymous',
        summary: `Too many failed verifications from ${this.ip(c)}${deviceId ? ` / ${deviceId}` : ''}; temporarily blocked`,
        details: { ip: this.ip(c), deviceId },
      });
      throw err('RATE_LIMITED', 429, undefined, { retryAfterMs: Math.max(a.retryAfterMs, b.retryAfterMs) });
    }
  }

  private recordFailure(c: RequestCtx, deviceId?: string): void {
    const t = this.ctx.now();
    this.failureLimiterIp.record(`ip:${this.ip(c)}`, t);
    if (deviceId) this.failureLimiterDevice.record(`dev:${deviceId}`, t);
  }

  private async securityEvent(type: string, c: RequestCtx, summary: string, deviceId?: string, extra: Record<string, unknown> = {}): Promise<void> {
    await this.ctx.audit.recordThrottled(`${type}:${this.ip(c)}:${deviceId ?? ''}`, {
      type,
      severity: 'warning',
      actor: deviceId ? `device:${deviceId}` : 'anonymous',
      summary,
      details: { ip: this.ip(c), deviceId, ...extra },
    });
  }

  private parse<T>(schema: z.ZodType<T>, body: unknown): T {
    const r = schema.safeParse(body);
    if (!r.success) throw err('BAD_REQUEST', 400);
    return r.data;
  }

  // ───────────── public info ─────────────
  info() {
    const s = this.ctx.settings();
    return {
      name: 'PULSE',
      protocol: 1,
      hostId: this.ctx.hostId,
      orgName: s.orgName,
      timezone: s.timezone,
      serverTime: new Date(this.ctx.now()).toISOString(),
      rotationSeconds: s.rotationSeconds,
      acceptWindowSeconds: s.acceptWindowSeconds,
    };
  }

  // ───────────── registration ─────────────
  async peekRegistration(body: unknown, c: RequestCtx) {
    await this.networkGate(c);
    await this.rateGate(this.peekLimiter, `peek:${this.ip(c)}`, c, 'Registration lookup');
    const { token } = this.parse(z.object({ token: tokenSchema }), body);
    const r = this.ctx.regTokens.peek(token, this.ctx.now());
    if (!r.ok) throw err('TOKEN_INVALID', 400, r.reason === 'expired' ? 'This registration code has expired. Ask the administrator for a new one.' : 'This registration code is not valid or was already used.');
    const emp = r.record.employeeId ? this.ctx.employees.get(r.record.employeeId) : undefined;
    return { type: r.record.type, employee: emp ? { id: emp.id, fullName: emp.fullName } : undefined };
  }

  async register(body: unknown, c: RequestCtx) {
    await this.networkGate(c);
    await this.rateGate(this.registrationLimiter, `reg:${this.ip(c)}`, c, 'Registration');
    const base = this.parse(registerBody, body);
    const consumed = this.ctx.regTokens.consume(base.token, this.ctx.now());
    if (!consumed.ok) {
      await this.securityEvent('security.registration-token-rejected', c, `Registration attempt with a ${consumed.reason} code from ${this.ip(c)}`, undefined, { reason: consumed.reason });
      throw err(
        'TOKEN_INVALID',
        400,
        consumed.reason === 'expired' ? 'This registration code has expired. Ask the administrator for a new one.' : 'This registration code is not valid or was already used.',
      );
    }
    try {
      const { token: _t, ...rest } = base as Record<string, unknown> & { token: string };
      void _t;
      const out = await this.ctx.devices.createRequest(rest, consumed.record, this.ip(c));
      this.ctx.emit({ type: 'registration.token', data: { used: true, expiresAt: consumed.record.expiresAt } });
      this.ctx.onRegistrationConsumed();
      return out;
    } catch (e) {
      this.ctx.regTokens.restore(consumed.record.tid); // let the person fix a typo with the same QR
      throw e;
    }
  }

  async registrationStatus(body: unknown, c: RequestCtx) {
    await this.networkGate(c);
    await this.rateGate(this.pollLimiter, `poll:${this.ip(c)}`, c, 'Registration status');
    const b = this.parse(registerStatusBody, body);
    return this.ctx.devices.requestStatus(b.requestId, b.pollSecret);
  }

  // ───────────── device authentication ─────────────
  async nonce(c: RequestCtx) {
    await this.networkGate(c);
    await this.rateGate(this.nonceLimiter, `nonce:${this.ip(c)}`, c, 'Nonce');
    return this.ctx.nonces.issue(this.ctx.now());
  }

  /**
   * Verifies the device record, its state and the signature. Used for status requests and the live socket.
   * Throws coded errors; never returns an unverified device.
   */
  private async authenticate(purpose: 'status' | 'live', b: { deviceId: string; nonce: string; signature: string }, c: RequestCtx): Promise<Device> {
    await this.failureGate(c, b.deviceId);
    if (!this.ctx.nonces.consume(b.nonce, this.ctx.now())) {
      this.recordFailure(c, b.deviceId);
      throw err('SIGNATURE_INVALID', 401);
    }
    const dev = this.ctx.devices.getDevice(b.deviceId);
    if (!dev) {
      this.recordFailure(c, b.deviceId);
      await this.securityEvent('security.unknown-device', c, `Unknown device ${b.deviceId} attempted to authenticate`, b.deviceId);
      throw err('DEVICE_UNKNOWN', 401);
    }
    const msg = signingMessage({ purpose, hostId: this.ctx.hostId, deviceId: dev.deviceId, challenge: b.nonce });
    if (!verifyDeviceSignature(dev.publicKey, msg, b.signature)) {
      this.recordFailure(c, b.deviceId);
      await this.securityEvent('security.invalid-signature', c, `Invalid signature from device ${dev.deviceId}`, dev.deviceId, { purpose });
      throw err('SIGNATURE_INVALID', 401);
    }
    if (dev.status === 'revoked') {
      await this.securityEvent('security.revoked-device', c, `Revoked device ${dev.deviceId} (${dev.employeeId}) attempted to authenticate`, dev.deviceId, { employeeId: dev.employeeId });
      throw err('DEVICE_REVOKED', 403);
    }
    return dev;
  }

  async deviceStatus(body: unknown, c: RequestCtx) {
    await this.networkGate(c);
    const b = this.parse(statusBody, body);
    const dev = await this.authenticate('status', b, c);
    const emp = this.ctx.employees.require(dev.employeeId);
    if (emp.status !== 'active') throw err('EMPLOYEE_INACTIVE', 403);
    this.ctx.devices.touch(dev.deviceId);
    const s = this.ctx.settings();
    return {
      employee: { id: emp.id, fullName: emp.fullName, department: emp.department },
      device: { deviceId: dev.deviceId, label: dev.label, enrolledAt: dev.enrolledAt },
      status: this.ctx.attendance.statusFor(emp.id),
      serverTime: new Date(this.ctx.now()).toISOString(),
      timezone: s.timezone,
      orgName: s.orgName,
    };
  }

  /** Authenticates a live-socket hello. Returns the device so the transport can bind the socket to it. */
  async authenticateLive(body: unknown, c: RequestCtx): Promise<Device> {
    await this.networkGate(c);
    const b = this.parse(statusBody, body);
    return this.authenticate('live', b, c);
  }

  // ───────────── attendance ─────────────
  async submitAttendance(body: unknown, c: RequestCtx) {
    await this.networkGate(c);
    await this.failureGate(c);
    await this.rateGate(this.submitLimiter, `sub:${this.ip(c)}`, c, 'Attendance submission');
    const b = this.parse(attendanceBody, body);
    await this.failureGate(c, b.deviceId);
    if (!b.idempotencyKey) return this.processAttendance(b, c);

    const key = `${b.deviceId}|${b.idempotencyKey}`;
    const nowMs = this.ctx.now();
    for (const [k, v] of this.idem) if (v.exp <= nowMs) this.idem.delete(k);
    const hit = this.idem.get(key);
    if (hit) {
      if (hit.sig !== b.signature || hit.token !== b.token || hit.intent !== b.intent || hit.nonce !== b.clientNonce) throw err('BAD_REQUEST', 400);
      const out = (await hit.promise) as Record<string, unknown>;
      return { ...out, duplicate: true as const };
    }
    const promise = this.processAttendance(b, c);
    this.idem.set(key, { exp: nowMs + 10 * 60_000, sig: b.signature, token: b.token, intent: b.intent, nonce: b.clientNonce, promise });
    promise.catch(() => {
      if (this.idem.get(key)?.promise === promise) this.idem.delete(key);
    });
    return promise;
  }

  private async processAttendance(b: AttendanceBody, c: RequestCtx) {
    const nowMs = this.ctx.now();
    const s = this.ctx.settings();

    // 1) challenge: signed by the host, fresh, from this process run
    const permanent = isPermanentToken(b.token);
    const activeMode = this.ctx.qrMode.activeMode();
    let cid: string;
    if (permanent) {
      const pv = this.ctx.qrMode.verifyPermanent(b.token);
      if (!pv.ok) {
        if (pv.code === 'QR_INVALID') {
          this.recordFailure(c, b.deviceId);
          await this.securityEvent('security.invalid-qr', c, `Invalid attendance QR submitted from ${this.ip(c)}`, b.deviceId);
        }
        throw err(pv.code, pv.code === 'QR_EXPIRED' ? 410 : 400);
      }
      if (activeMode !== 'permanent') {
        await this.securityEvent('security.qr-mode-mismatch', c, `Permanent QR code submitted while Timer-Based mode is active (${this.ip(c)})`, b.deviceId, { submitted: 'permanent', active: activeMode });
        throw err('QR_INACTIVE', 410);
      }
      cid = `perm-g${pv.generation}`;
    } else {
      const ch = this.ctx.authority.verify(b.token, nowMs, s.acceptWindowSeconds * 1000);
      if (!ch.ok) {
        if (ch.code === 'QR_INVALID') {
          this.recordFailure(c, b.deviceId);
          await this.securityEvent('security.invalid-qr', c, `Invalid attendance QR submitted from ${this.ip(c)}`, b.deviceId);
        }
        throw err(ch.code, ch.code === 'QR_EXPIRED' ? 410 : 400);
      }
      if (activeMode !== 'timer') {
        await this.securityEvent('security.qr-mode-mismatch', c, `Rotating QR code submitted while Permanent mode is active (${this.ip(c)})`, b.deviceId, { submitted: 'timer', active: activeMode });
        throw err('QR_INACTIVE', 410);
      }
      cid = ch.cid;
    }

    // 2) device must be known and the signature must verify
    const dev = this.ctx.devices.getDevice(b.deviceId);
    if (!dev) {
      this.recordFailure(c, b.deviceId);
      await this.securityEvent('security.unknown-device', c, `Unknown device ${b.deviceId} submitted attendance`, b.deviceId);
      throw err('DEVICE_UNKNOWN', 401);
    }
    const msg = signingMessage({ purpose: 'attendance', hostId: this.ctx.hostId, deviceId: dev.deviceId, challenge: b.token, extra: `${b.intent}|${b.clientNonce}` });
    if (!verifyDeviceSignature(dev.publicKey, msg, b.signature)) {
      this.recordFailure(c, b.deviceId);
      await this.securityEvent('security.invalid-signature', c, `Invalid attendance signature from device ${dev.deviceId}`, dev.deviceId, { employeeId: dev.employeeId });
      throw err('SIGNATURE_INVALID', 401);
    }
    if (dev.status === 'revoked') {
      await this.securityEvent('security.revoked-device', c, `Revoked device ${dev.deviceId} (${dev.employeeId}) attempted attendance`, dev.deviceId, { employeeId: dev.employeeId });
      throw err('DEVICE_REVOKED', 403);
    }

    // 3) replay protection: each (challenge, device) pair and each client nonce works exactly once
    const ttl = (s.acceptWindowSeconds + 30) * 1000;
    const pairKey = `ch:${cid}:${dev.deviceId}`;
    const nonceKey = `cn:${dev.deviceId}:${b.clientNonce}`;
    if (permanent) {
      if (!this.ctx.nonces.consume(b.clientNonce, nowMs)) {
        this.recordFailure(c, dev.deviceId);
        await this.securityEvent('security.replay', c, `Permanent QR scan without a valid server nonce from device ${dev.deviceId}`, dev.deviceId, { employeeId: dev.employeeId });
        throw err('NONCE_INVALID', 409);
      }
    } else {
      if (!this.ctx.replay.claim(pairKey, nowMs, ttl)) {
        this.recordFailure(c, dev.deviceId);
        await this.securityEvent('security.replay', c, `Replayed attendance scan from device ${dev.deviceId}`, dev.deviceId, { employeeId: dev.employeeId });
        throw err('REPLAY', 409);
      }
      if (!this.ctx.replay.claim(nonceKey, nowMs, ttl)) {
        this.ctx.replay.release(pairKey);
        this.recordFailure(c, dev.deviceId);
        await this.securityEvent('security.replay', c, `Replayed client nonce from device ${dev.deviceId}`, dev.deviceId, { employeeId: dev.employeeId });
        throw err('REPLAY', 409);
      }
    }
    if (this.ctx.qrMode.activeMode() !== activeMode) {
      if (!permanent) {
        this.ctx.replay.release(pairKey);
        this.ctx.replay.release(nonceKey);
      }
      throw err('QR_INACTIVE', 410);
    }

    // 4) employee status, rules and durable save (all inside the attendance lock)
    try {
      const result = await this.ctx.attendance.record({
        employeeId: dev.employeeId,
        deviceId: dev.deviceId,
        intent: b.intent,
        challengeId: cid,
        remoteAddr: this.ip(c),
        idempotencyKey: b.idempotencyKey,
      });
      this.ctx.clearStorageError();
      this.ctx.devices.touch(dev.deviceId);
      return {
        saved: true as const,
        action: result.event.kind,
        message: result.message,
        shift: result.shiftName ? { id: result.event.shift?.id, name: result.shiftName } : undefined,
        pendingApproval: result.pendingApproval,
        warning: result.warning,
        duplicate: result.duplicate ? (true as const) : undefined,
        event: { id: result.event.id, kind: result.event.kind, ts: result.event.ts, localDate: result.event.localDate, localTime: result.event.localTime, classification: result.event.classification, minutes: result.event.minutes, approval: result.event.approval ? { kind: result.event.approval.kind, status: result.event.approval.status } : undefined },
        employee: { id: result.employee.id, fullName: result.employee.fullName },
        status: this.ctx.attendance.statusFor(result.employee.id),
      };
    } catch (e) {
      // Nothing was saved: free the scan so the person can retry with the code on screen.
      if (!permanent) {
        this.ctx.replay.release(pairKey);
        this.ctx.replay.release(nonceKey);
      }
      this.ctx.noteStorageError(e);
      const pe = AttendanceService.asPhoneError(e);
      this.ctx.emit({ type: 'attendance.rejected', data: { code: pe.code, message: pe.message, employeeId: dev.employeeId, at: new Date(this.ctx.now()).toISOString() } });
      if (!['ALREADY_CHECKED_IN', 'NOT_CHECKED_IN', 'DAY_COMPLETE', 'TOO_SOON', 'TOO_EARLY', 'OFF_DAY', 'NO_SHIFT_OPEN', 'CHECKOUT_NOT_OPEN', 'APPROVAL_PENDING', 'APPROVAL_REJECTED'].includes(pe.code)) {
        await this.securityEvent(pe.code.startsWith('STORAGE') || pe.code === 'CLOCK_SUSPECT' ? 'system.attendance-not-saved' : 'attendance.rejected', c, `Attendance for ${dev.employeeId} rejected: ${pe.code}`, dev.deviceId, { employeeId: dev.employeeId, code: pe.code });
      }
      throw pe;
    }
  }
}
