import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AdminAccount, AdminRole, AdminView, SessionInfo } from '../shared/types';
import type { AuditService } from './domain/audit';
import { hashPassword, passwordProblems, verifyPassword } from './crypto';
import { PulseError } from './errors';
import { newId } from './ids';
import { RateLimiter } from './ratelimit';
import { formatZodError, type AdminsFile } from './schemas';
import type { JsonStore } from './storage/jsonStore';

export type Permission = 'read' | 'export' | 'write' | 'settings' | 'admins';

const ROLE_PERMISSIONS: Record<AdminRole, ReadonlySet<Permission>> = {
  owner: new Set<Permission>(['read', 'export', 'write', 'settings', 'admins']),
  admin: new Set<Permission>(['read', 'export', 'write']),
  auditor: new Set<Permission>(['read', 'export']),
};

interface Session {
  adminId: string;
  createdAt: number;
  lastSeen: number;
}

const ABSOLUTE_SESSION_MS = 12 * 3600 * 1000;

const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(40)
  .regex(/^[A-Za-z0-9._-]+$/, 'Username may contain letters, digits, ".", "_" and "-"');
const displayNameSchema = z.string().trim().min(1).max(80);

export function toAdminView(a: AdminAccount): AdminView {
  const { passwordHash: _p, ...rest } = a;
  void _p;
  return rest;
}

export class AdminAuth {
  private readonly sessions = new Map<string, Session>();
  private readonly userLimiter = new RateLimiter(5, 15 * 60_000);
  private readonly sourceLimiter = new RateLimiter(20, 15 * 60_000);
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly store: JsonStore<AdminsFile>,
    private readonly audit: AuditService,
    private readonly now: () => number,
    private readonly idleMinutes: () => number,
  ) {}

  needsSetup(): boolean {
    return this.store.data.admins.length === 0;
  }

  private open(admin: AdminAccount): SessionInfo {
    const token = randomBytes(32).toString('base64url');
    const t = this.now();
    this.sessions.set(token, { adminId: admin.id, createdAt: t, lastSeen: t });
    return { token, admin: toAdminView(admin), expiresInMinutes: this.idleMinutes() };
  }

  async setup(input: unknown): Promise<SessionInfo> {
    const parsed = z.object({ username: usernameSchema, displayName: displayNameSchema, password: z.string().max(200) }).safeParse(input);
    if (!parsed.success) throw new PulseError('VALIDATION', formatZodError(parsed.error));
    const problems = passwordProblems(parsed.data.password);
    if (problems.length) throw new PulseError('WEAK_PASSWORD', `Password needs ${problems.join(', ')}.`);
    const hash = await hashPassword(parsed.data.password);
    const admin: AdminAccount = {
      id: newId('adm', this.now()),
      username: parsed.data.username,
      displayName: parsed.data.displayName,
      role: 'owner',
      passwordHash: hash,
      createdAt: new Date(this.now()).toISOString(),
      disabled: false,
    };
    await this.store.update((d) => {
      if (d.admins.length) throw new PulseError('ALREADY_SETUP', 'An administrator already exists', 409);
      d.admins.push(admin);
    });
    await this.audit.record({ type: 'admin.setup', severity: 'notice', actor: admin.username, summary: `Initial owner account "${admin.username}" created` });
    return this.open(admin);
  }

  async login(input: unknown, source = 'local'): Promise<SessionInfo> {
    const parsed = z.object({ username: z.string().max(80), password: z.string().max(200) }).safeParse(input);
    if (!parsed.success) throw new PulseError('VALIDATION', 'Enter your username and password');
    const username = parsed.data.username.trim().toLowerCase();
    const t = this.now();
    const ub = this.userLimiter.blocked(`u:${username}`, t);
    const sb = this.sourceLimiter.blocked(`s:${source}`, t);
    if (ub.blocked || sb.blocked) {
      const wait = Math.ceil(Math.max(ub.retryAfterMs, sb.retryAfterMs) / 60000);
      await this.audit.recordThrottled(`login-blocked:${username}`, {
        type: 'security.admin-login-locked',
        severity: 'warning',
        actor: 'anonymous',
        summary: `Administrator sign-in locked for "${username}" after repeated failures`,
        details: { username, ip: source },
      });
      throw new PulseError('LOCKED', `Too many failed attempts. Try again in about ${wait} minute(s).`, 429);
    }
    const admin = this.store.data.admins.find((a) => a.username.toLowerCase() === username);
    // Always spend one hash verification, so response time does not reveal whether the user exists.
    this.dummyHash ??= hashPassword('not-a-real-password');
    const ok = await verifyPassword(parsed.data.password, admin ? admin.passwordHash : await this.dummyHash);
    if (!admin || !ok || admin.disabled) {
      this.userLimiter.record(`u:${username}`, t);
      this.sourceLimiter.record(`s:${source}`, t);
      await this.audit.record({
        type: 'security.admin-login-failed',
        severity: 'warning',
        actor: 'anonymous',
        summary: `Failed administrator sign-in for "${username}"${admin?.disabled ? ' (account disabled)' : ''}`,
        details: { username, ip: source },
      });
      throw new PulseError('BAD_CREDENTIALS', 'Incorrect username or password', 401);
    }
    this.userLimiter.clear(`u:${username}`);
    const nowIso = new Date(t).toISOString();
    await this.store.update((d) => {
      const a = d.admins.find((x) => x.id === admin.id);
      if (a) a.lastLoginAt = nowIso;
    });
    await this.audit.record({ type: 'admin.login', actor: admin.username, summary: `${admin.username} signed in` });
    return this.open({ ...admin, lastLoginAt: nowIso });
  }

  async logout(token: string): Promise<void> {
    const s = this.sessions.get(token);
    if (!s) return;
    this.sessions.delete(token);
    const a = this.store.data.admins.find((x) => x.id === s.adminId);
    if (a) await this.audit.record({ type: 'admin.logout', actor: a.username, summary: `${a.username} signed out` });
  }

  /** Verifies the session and role. Throws 401 (no/expired session) or 403 (role lacks permission). */
  authorize(token: string | undefined, perm: Permission | null): { admin: AdminAccount; token: string } {
    const s = token ? this.sessions.get(token) : undefined;
    if (!token || !s) throw new PulseError('UNAUTHENTICATED', 'Please sign in', 401);
    const t = this.now();
    if (t - s.lastSeen > this.idleMinutes() * 60_000 || t - s.createdAt > ABSOLUTE_SESSION_MS) {
      this.sessions.delete(token);
      throw new PulseError('SESSION_EXPIRED', 'Your session expired. Please sign in again.', 401);
    }
    const admin = this.store.data.admins.find((a) => a.id === s.adminId);
    if (!admin || admin.disabled) {
      this.sessions.delete(token);
      throw new PulseError('UNAUTHENTICATED', 'Please sign in', 401);
    }
    if (perm && !ROLE_PERMISSIONS[admin.role].has(perm)) {
      throw new PulseError('FORBIDDEN', `Your role (${admin.role}) is not allowed to do this`, 403);
    }
    s.lastSeen = t;
    return { admin, token };
  }

  /** Non-throwing validity probe used by the live socket. Does not extend the session. */
  isValid(token: string): boolean {
    const s = this.sessions.get(token);
    if (!s) return false;
    const t = this.now();
    return t - s.lastSeen <= this.idleMinutes() * 60_000 && t - s.createdAt <= ABSOLUTE_SESSION_MS;
  }

  listAdmins(): AdminView[] {
    return this.store.data.admins.map(toAdminView);
  }

  async createAdmin(input: unknown, actor: string): Promise<AdminView> {
    const parsed = z
      .object({ username: usernameSchema, displayName: displayNameSchema, role: z.enum(['admin', 'auditor', 'owner']), password: z.string().max(200) })
      .safeParse(input);
    if (!parsed.success) throw new PulseError('VALIDATION', formatZodError(parsed.error));
    const problems = passwordProblems(parsed.data.password);
    if (problems.length) throw new PulseError('WEAK_PASSWORD', `Password needs ${problems.join(', ')}.`);
    const hash = await hashPassword(parsed.data.password);
    const acct: AdminAccount = {
      id: newId('adm', this.now()),
      username: parsed.data.username,
      displayName: parsed.data.displayName,
      role: parsed.data.role,
      passwordHash: hash,
      createdAt: new Date(this.now()).toISOString(),
      disabled: false,
    };
    await this.store.update((d) => {
      if (d.admins.some((a) => a.username.toLowerCase() === acct.username.toLowerCase())) throw new PulseError('DUPLICATE', 'That username is taken', 409);
      d.admins.push(acct);
    });
    await this.audit.record({ type: 'admin.created', severity: 'notice', actor, summary: `Administrator "${acct.username}" (${acct.role}) created` });
    return toAdminView(acct);
  }

  async setDisabled(adminId: string, disabled: boolean, actor: string): Promise<void> {
    await this.store.update((d) => {
      const a = d.admins.find((x) => x.id === adminId);
      if (!a) throw new PulseError('NOT_FOUND', 'Administrator not found', 404);
      if (disabled && a.role === 'owner' && d.admins.filter((x) => x.role === 'owner' && !x.disabled && x.id !== a.id).length === 0) {
        throw new PulseError('LAST_OWNER', 'You cannot disable the last active owner', 409);
      }
      a.disabled = disabled;
    });
    if (disabled) this.dropSessions(adminId);
    await this.audit.record({ type: disabled ? 'admin.disabled' : 'admin.enabled', severity: 'notice', actor, summary: `Administrator ${adminId} ${disabled ? 'disabled' : 'enabled'}` });
  }

  async archiveAdmin(adminId: string, reason: string, actor: string): Promise<void> {
    const nowIso = new Date(this.now()).toISOString();
    let name = adminId;
    await this.store.update((d) => {
      const a = d.admins.find((x) => x.id === adminId);
      if (!a) throw new PulseError('NOT_FOUND', 'Administrator not found', 404);
      if (a.archivedAt) throw new PulseError('ARCHIVED', 'This administrator is already archived', 409);
      if (a.role === 'owner') throw new PulseError('OWNER_PROTECTED', 'Owner accounts cannot be archived', 409);
      name = a.username;
      a.disabled = true;
      a.archivedAt = nowIso;
      a.archivedBy = actor;
      a.archivedReason = reason;
    });
    this.dropSessions(adminId);
    await this.audit.record({ type: 'admin.archived', severity: 'notice', actor, summary: `Administrator \"${name}\" archived — ${reason}`, details: { adminId } });
  }

  async restoreAdmin(adminId: string, actor: string): Promise<void> {
    let name = adminId;
    await this.store.update((d) => {
      const a = d.admins.find((x) => x.id === adminId);
      if (!a) throw new PulseError('NOT_FOUND', 'Administrator not found', 404);
      if (!a.archivedAt) throw new PulseError('NOT_ARCHIVED', 'This administrator is not archived', 409);
      name = a.username;
      delete a.archivedAt;
      delete a.archivedBy;
      delete a.archivedReason;
    });
    await this.audit.record({ type: 'admin.restored', severity: 'notice', actor, summary: `Administrator \"${name}\" restored from the archive (still disabled)`, details: { adminId } });
  }

  purgeExpiredSessions(): number {
    const t = this.now();
    let n = 0;
    for (const [token, s] of this.sessions) {
      if (t - s.lastSeen > this.idleMinutes() * 60_000 || t - s.createdAt > ABSOLUTE_SESSION_MS) {
        this.sessions.delete(token);
        n++;
      }
    }
    return n;
  }

  async changePassword(token: string, current: string, next: string): Promise<void> {
    const { admin } = this.authorize(token, null);
    if (!(await verifyPassword(current, admin.passwordHash))) {
      await this.audit.record({ type: 'security.admin-password-change-failed', severity: 'warning', actor: admin.username, summary: 'Password change refused (wrong current password)' });
      throw new PulseError('BAD_CREDENTIALS', 'Current password is incorrect', 401);
    }
    const problems = passwordProblems(next);
    if (problems.length) throw new PulseError('WEAK_PASSWORD', `Password needs ${problems.join(', ')}.`);
    const hash = await hashPassword(next);
    await this.store.update((d) => {
      d.admins.find((a) => a.id === admin.id)!.passwordHash = hash;
    });
    // Sign out every other session of this account.
    for (const [t, s] of this.sessions) if (s.adminId === admin.id && t !== token) this.sessions.delete(t);
    await this.audit.record({ type: 'admin.password-changed', severity: 'notice', actor: admin.username, summary: 'Password changed' });
  }

  async resetPassword(adminId: string, newPassword: string, actor: string): Promise<void> {
    const problems = passwordProblems(newPassword);
    if (problems.length) throw new PulseError('WEAK_PASSWORD', `Password needs ${problems.join(', ')}.`);
    const hash = await hashPassword(newPassword);
    await this.store.update((d) => {
      const a = d.admins.find((x) => x.id === adminId);
      if (!a) throw new PulseError('NOT_FOUND', 'Administrator not found', 404);
      a.passwordHash = hash;
    });
    this.dropSessions(adminId);
    await this.audit.record({ type: 'admin.password-reset', severity: 'notice', actor, summary: `Password reset for ${adminId}` });
  }

  private dropSessions(adminId: string): void {
    for (const [t, s] of this.sessions) if (s.adminId === adminId) this.sessions.delete(t);
  }
}
