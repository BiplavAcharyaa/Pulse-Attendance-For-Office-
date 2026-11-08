import { createHash, randomBytes } from 'node:crypto';
import type { Device, LiveEvent, PublicKeyJwk, RegistrationRequest, RegistrationRequestView, RequestType } from '../../shared/types';
import { deviceIdFromJwk, importPublicKey, sha256Hex } from '../crypto';
import { PulseError } from '../errors';
import { newId } from '../ids';
import { employeeIdSchema, formatZodError, fullNameSchema, jwkSchema, phoneSchema, type DevicesFile } from '../schemas';
import type { JsonStore } from '../storage/jsonStore';
import type { RegistrationTokenRecord } from '../tokens';
import type { AuditService } from './audit';
import { normalizeName, type EmployeeService } from './employees';
import { z } from 'zod';

const MAX_PENDING = 100;

const registerSchema = z.object({
  fullName: fullNameSchema,
  employeeId: employeeIdSchema,
  phone: phoneSchema,
  publicKey: jwkSchema,
  userAgent: z.string().max(300).default(''),
});

export function describeUserAgent(ua: string): string {
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) {
    const m = /Android[^;]*;\s*([^;)]+?)(?:\sBuild|\)|;)/i.exec(ua);
    return m ? `Android — ${m[1].trim().slice(0, 40)}` : 'Android phone';
  }
  return ua ? 'Mobile browser' : 'Unknown device';
}

export function toRequestView(r: RegistrationRequest): RegistrationRequestView {
  const { pollSecretHash: _omit, ...rest } = r;
  void _omit;
  return rest;
}

export class DeviceService {
  /** lastSeen is intentionally in-memory only (avoids rewriting devices.json on every scan). */
  private readonly lastSeen = new Map<string, string>();

  constructor(
    private readonly store: JsonStore<DevicesFile>,
    private readonly employees: EmployeeService,
    private readonly audit: AuditService,
    private readonly emit: (e: LiveEvent) => void,
    private readonly now: () => number,
  ) {}

  listDevices(): Array<Device & { lastSeenAt?: string; employeeName?: string }> {
    return this.store.data.devices.map((d) => ({
      ...d,
      lastSeenAt: this.lastSeen.get(d.deviceId) ?? d.lastSeenAt,
      employeeName: this.employees.get(d.employeeId)?.fullName,
    }));
  }

  getDevice(deviceId: string): Device | undefined {
    return this.store.data.devices.find((d) => d.deviceId === deviceId);
  }

  activeDeviceFor(employeeId: string): Device | undefined {
    return this.store.data.devices.find((d) => d.employeeId.toLowerCase() === employeeId.toLowerCase() && d.status === 'active');
  }

  touch(deviceId: string): void {
    this.lastSeen.set(deviceId, new Date(this.now()).toISOString());
  }

  listRequests(status?: RegistrationRequest['status']): RegistrationRequestView[] {
    return this.store.data.requests
      .filter((r) => !status || r.status === status)
      .map(toRequestView)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  pendingCount(): number {
    return this.store.data.requests.filter((r) => r.status === 'pending').length;
  }

  async createRequest(input: unknown, token: RegistrationTokenRecord, remoteAddr: string): Promise<{ requestId: string; pollSecret: string }> {
    const parsed = registerSchema.safeParse(input);
    if (!parsed.success) throw new PulseError('VALIDATION', formatZodError(parsed.error));
    const v = parsed.data;
    try {
      importPublicKey(v.publicKey as PublicKeyJwk);
    } catch {
      throw new PulseError('VALIDATION', 'The device key is not a valid P-256 public key');
    }
    const type: RequestType = token.type;
    const employeeId = type === 'replacement' ? token.employeeId! : v.employeeId;
    const existing = this.employees.get(employeeId);
    const flags: string[] = [];

    if (existing) {
      if (existing.status !== 'active') throw new PulseError('EMPLOYEE_INACTIVE', 'This employee profile is inactive. Contact an administrator.', 403);
      if (type === 'registration' && this.activeDeviceFor(existing.id)) {
        throw new PulseError('EMPLOYEE_HAS_DEVICE', 'This employee already has a registered phone. Ask an administrator to authorize a replacement phone.', 409);
      }
      if (normalizeName(existing.fullName) !== normalizeName(v.fullName)) flags.push('name-mismatch');
      if (existing.phone.replace(/\D/g, '').slice(-9) !== v.phone.replace(/\D/g, '').slice(-9)) flags.push('phone-mismatch');
    } else {
      if (type === 'replacement') throw new PulseError('EMPLOYEE_NOT_FOUND', 'The employee for this replacement no longer exists', 404);
      flags.push('new-employee');
    }

    const deviceId = deviceIdFromJwk(v.publicKey as PublicKeyJwk);
    const pollSecret = randomBytes(24).toString('base64url');
    const nowIso = new Date(this.now()).toISOString();
    const request: RegistrationRequest = {
      requestId: newId('req', this.now()),
      type,
      fullName: v.fullName,
      employeeId: existing?.id ?? employeeId,
      phone: v.phone,
      publicKey: v.publicKey as PublicKeyJwk,
      pollSecretHash: sha256Hex(pollSecret),
      userAgent: v.userAgent,
      remoteAddr,
      status: 'pending',
      createdAt: nowIso,
      flags,
    };

    await this.store.update((d) => {
      if (d.devices.some((x) => x.deviceId === deviceId)) throw new PulseError('DUPLICATE_KEY', 'This phone is already registered', 409);
      if (d.requests.some((r) => r.status === 'pending' && r.employeeId.toLowerCase() === request.employeeId.toLowerCase())) {
        throw new PulseError('DUPLICATE_PENDING', 'A registration request for this employee is already waiting for approval', 409);
      }
      if (d.requests.filter((r) => r.status === 'pending').length >= MAX_PENDING) {
        throw new PulseError('LIMIT', 'Too many pending requests. An administrator must review the queue first.', 429);
      }
      d.requests.push(request);
    });

    await this.audit.record({
      type: 'registration.requested',
      severity: flags.length ? 'notice' : 'info',
      actor: 'anonymous',
      summary: `${type === 'replacement' ? 'Replacement' : 'Registration'} request from ${request.fullName} (${request.employeeId})`,
      details: { requestId: request.requestId, employeeId: request.employeeId, flags, ip: remoteAddr, deviceId },
    });
    this.emit({ type: 'request.created', data: toRequestView(request) });
    return { requestId: request.requestId, pollSecret };
  }

  /** Phone polling: only the holder of the poll secret can read the decision. */
  requestStatus(requestId: string, pollSecret: string): { status: RegistrationRequest['status']; deviceId?: string; reason?: string; employee?: { id: string; fullName: string } } {
    const r = this.store.data.requests.find((x) => x.requestId === requestId);
    const given = createHash('sha256').update(pollSecret).digest('hex');
    if (!r || r.pollSecretHash !== given) throw new PulseError('NOT_FOUND', 'Unknown registration request', 404);
    const emp = r.status === 'approved' ? this.employees.get(r.employeeId) : undefined;
    return {
      status: r.status,
      deviceId: r.deviceId,
      reason: r.status === 'rejected' ? r.decisionReason : undefined,
      employee: emp ? { id: emp.id, fullName: emp.fullName } : undefined,
    };
  }

  async approve(requestId: string, admin: { username: string }): Promise<Device> {
    const req = this.store.data.requests.find((r) => r.requestId === requestId);
    if (!req) throw new PulseError('NOT_FOUND', 'Request not found', 404);
    if (req.status !== 'pending') throw new PulseError('ALREADY_DECIDED', `Request was already ${req.status}`, 409);

    let emp = this.employees.get(req.employeeId);
    if (!emp) {
      emp = await this.employees.create({ id: req.employeeId, fullName: req.fullName, phone: req.phone, department: '' }, admin.username);
    } else if (emp.status !== 'active') {
      throw new PulseError('EMPLOYEE_INACTIVE', 'Reactivate the employee before approving a device', 409);
    }

    const nowIso = new Date(this.now()).toISOString();
    const deviceId = deviceIdFromJwk(req.publicKey);
    const revokedOthers: string[] = [];
    const device: Device = {
      deviceId,
      employeeId: emp.id,
      publicKey: req.publicKey,
      label: describeUserAgent(req.userAgent),
      userAgent: req.userAgent,
      status: 'active',
      enrolledAt: nowIso,
      approvedBy: admin.username,
      requestId: req.requestId,
    };

    await this.store.update((d) => {
      const r = d.requests.find((x) => x.requestId === requestId)!;
      if (r.status !== 'pending') throw new PulseError('ALREADY_DECIDED', `Request was already ${r.status}`, 409);
      const active = d.devices.filter((x) => x.employeeId === emp!.id && x.status === 'active');
      if (r.type === 'registration' && active.length) {
        throw new PulseError('EMPLOYEE_HAS_DEVICE', 'The employee already has an active device. Revoke it or use a replacement enrollment.', 409);
      }
      if (d.devices.some((x) => x.deviceId === deviceId)) throw new PulseError('DUPLICATE_KEY', 'This phone is already registered', 409);
      for (const old of active) {
        old.status = 'revoked';
        old.revokedAt = nowIso;
        old.revokedBy = admin.username;
        old.revokedReason = 'Replaced by a new device';
        revokedOthers.push(old.deviceId);
      }
      d.devices.push(device);
      r.status = 'approved';
      r.decidedAt = nowIso;
      r.decidedBy = admin.username;
      r.deviceId = deviceId;
    });

    for (const id of revokedOthers) {
      await this.audit.record({
        type: 'device.revoked',
        severity: 'notice',
        actor: admin.username,
        summary: `Device ${id} revoked (replaced) for ${emp.id}`,
        details: { deviceId: id, employeeId: emp.id },
      });
      this.emit({ type: 'device.changed', data: { deviceId: id, employeeId: emp.id, status: 'revoked' } });
    }
    await this.audit.record({
      type: 'registration.approved',
      actor: admin.username,
      summary: `Approved ${req.type} for ${emp.fullName} (${emp.id}); device ${deviceId} enrolled`,
      details: { requestId, employeeId: emp.id, deviceId },
    });
    this.emit({ type: 'device.changed', data: { deviceId, employeeId: emp.id, status: 'active' } });
    const decided = this.store.data.requests.find((r) => r.requestId === requestId)!;
    this.emit({ type: 'request.decided', data: toRequestView(decided) });
    return device;
  }

  async reject(requestId: string, reason: string, admin: { username: string }): Promise<void> {
    const req = this.store.data.requests.find((r) => r.requestId === requestId);
    if (!req) throw new PulseError('NOT_FOUND', 'Request not found', 404);
    if (req.status !== 'pending') throw new PulseError('ALREADY_DECIDED', `Request was already ${req.status}`, 409);
    if (reason.trim().length < 3) throw new PulseError('VALIDATION', 'Please give a short reason for rejecting');
    const nowIso = new Date(this.now()).toISOString();
    await this.store.update((d) => {
      const r = d.requests.find((x) => x.requestId === requestId)!;
      r.status = 'rejected';
      r.decidedAt = nowIso;
      r.decidedBy = admin.username;
      r.decisionReason = reason.trim().slice(0, 200);
    });
    await this.audit.record({
      type: 'registration.rejected',
      severity: 'notice',
      actor: admin.username,
      summary: `Rejected request from ${req.fullName} (${req.employeeId}) — ${reason.trim()}`,
      details: { requestId, employeeId: req.employeeId },
    });
    this.emit({ type: 'request.decided', data: toRequestView(this.store.data.requests.find((r) => r.requestId === requestId)!) });
  }

  async revoke(deviceId: string, reason: string, admin: { username: string }): Promise<void> {
    const dev = this.getDevice(deviceId);
    if (!dev) throw new PulseError('NOT_FOUND', 'Device not found', 404);
    if (dev.status === 'revoked') throw new PulseError('ALREADY_REVOKED', 'Device is already revoked', 409);
    if (reason.trim().length < 3) throw new PulseError('VALIDATION', 'A reason is required to revoke a device');
    const nowIso = new Date(this.now()).toISOString();
    await this.store.update((d) => {
      const x = d.devices.find((y) => y.deviceId === deviceId)!;
      x.status = 'revoked';
      x.revokedAt = nowIso;
      x.revokedBy = admin.username;
      x.revokedReason = reason.trim().slice(0, 200);
    });
    await this.audit.record({
      type: 'device.revoked',
      severity: 'warning',
      actor: admin.username,
      summary: `Device ${deviceId} of ${dev.employeeId} revoked — ${reason.trim()}`,
      details: { deviceId, employeeId: dev.employeeId },
    });
    this.emit({ type: 'device.changed', data: { deviceId, employeeId: dev.employeeId, status: 'revoked' } });
  }

  async archive(deviceId: string, reason: string, admin: { username: string }): Promise<void> {
    const dev = this.getDevice(deviceId);
    if (!dev) throw new PulseError('NOT_FOUND', 'Device not found', 404);
    if (dev.archivedAt) throw new PulseError('ARCHIVED', 'Device is already archived', 409);
    if (dev.status !== 'revoked') throw new PulseError('DEVICE_ACTIVE', 'Revoke the device before archiving it', 409);
    if (reason.trim().length < 3) throw new PulseError('VALIDATION', 'A reason is required to archive a device');
    const nowIso = new Date(this.now()).toISOString();
    await this.store.update((d) => {
      const x = d.devices.find((y) => y.deviceId === deviceId)!;
      x.archivedAt = nowIso;
      x.archivedBy = admin.username;
      x.archivedReason = reason.trim().slice(0, 200);
    });
    await this.audit.record({
      type: 'device.archived',
      severity: 'notice',
      actor: admin.username,
      summary: `Device ${deviceId} of ${dev.employeeId} archived — ${reason.trim()}`,
      details: { deviceId, employeeId: dev.employeeId },
    });
    this.emit({ type: 'archive.changed', data: { entity: 'device', id: deviceId, archived: true } });
  }

  async restore(deviceId: string, admin: { username: string }): Promise<void> {
    const dev = this.getDevice(deviceId);
    if (!dev) throw new PulseError('NOT_FOUND', 'Device not found', 404);
    if (!dev.archivedAt) throw new PulseError('NOT_ARCHIVED', 'Device is not archived', 409);
    await this.store.update((d) => {
      const x = d.devices.find((y) => y.deviceId === deviceId)!;
      delete x.archivedAt;
      delete x.archivedBy;
      delete x.archivedReason;
    });
    await this.audit.record({
      type: 'device.restored',
      severity: 'notice',
      actor: admin.username,
      summary: `Device ${deviceId} of ${dev.employeeId} restored from the archive (still revoked)`,
      details: { deviceId, employeeId: dev.employeeId },
    });
    this.emit({ type: 'archive.changed', data: { entity: 'device', id: deviceId, archived: false } });
  }
}
