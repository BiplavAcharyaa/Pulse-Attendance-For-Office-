import { z } from 'zod';
import type { AdminAccount, ApiResult } from '../shared/types';
import { toAdminView, type Permission } from './adminAuth';
import { PulseError } from './errors';
import { listLanCandidates } from './network';
import { formatZodError } from './schemas';
import type { PulseService } from './service';
import { addDays, isDateString, localParts } from './time';

interface CallCtx {
  admin: AdminAccount;
  token: string;
  args: any; // validated per-method below
  source: string;
}

interface Def {
  perm: Permission | null;
  public?: boolean;
  run: (c: CallCtx) => Promise<unknown> | unknown;
}

const dateStr = z.string().refine(isDateString, 'Date must be YYYY-MM-DD');

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const r = schema.safeParse(args ?? {});
  if (!r.success) throw new PulseError('VALIDATION', formatZodError(r.error));
  return r.data;
}

/**
 * Administrator operations. The ONLY entry point is `call()`, which authenticates the session and checks the
 * caller's role before running anything. It is exposed to the desktop dashboard through Electron IPC only —
 * there is no HTTP route to it, so phones on the LAN cannot reach any of it.
 */
export class AdminApi {
  private readonly defs: Record<string, Def>;

  constructor(private readonly svc: PulseService) {
    const s = svc;
    this.defs = {
      // ── authentication (public until signed in)
      'auth.status': { perm: null, public: true, run: () => ({ setupRequired: s.adminAuth.needsSetup() }) },
      'auth.setup': { perm: null, public: true, run: (c) => s.adminAuth.setup(c.args) },
      'auth.login': { perm: null, public: true, run: (c) => s.adminAuth.login(c.args, c.source) },
      'auth.logout': { perm: null, run: async (c) => { await s.adminAuth.logout(c.token); return {}; } },
      'auth.me': { perm: null, run: (c) => toAdminView(c.admin) },
      'auth.changePassword': {
        perm: null,
        run: async (c) => {
          const a = parse(z.object({ current: z.string().max(200), next: z.string().max(200) }), c.args);
          await s.adminAuth.changePassword(c.token, a.current, a.next);
          return {};
        },
      },

      // ── administrator accounts (owner only)
      'admins.list': { perm: 'admins', run: () => s.adminAuth.listAdmins() },
      'admins.create': { perm: 'admins', run: (c) => s.adminAuth.createAdmin(c.args, c.admin.username) },
      'admins.archive': {
        perm: 'admins',
        run: async (c) => {
          const a = parse(z.object({ id: z.string(), reason: z.string().trim().min(3).max(200) }), c.args);
          if (a.id === c.admin.id) throw new PulseError('VALIDATION', 'You cannot archive your own account');
          await s.adminAuth.archiveAdmin(a.id, a.reason, c.admin.username);
          return {};
        },
      },
      'admins.restore': {
        perm: 'admins',
        run: async (c) => {
          await s.adminAuth.restoreAdmin(parse(z.object({ id: z.string() }), c.args).id, c.admin.username);
          return {};
        },
      },
      'maintenance.plan': { perm: 'admins', run: () => s.maintenance.plan() },
      'maintenance.apply': { perm: 'admins', run: (c) => s.maintenance.apply(c.admin.username) },
      'admins.setDisabled': {
        perm: 'admins',
        run: async (c) => {
          const a = parse(z.object({ id: z.string(), disabled: z.boolean() }), c.args);
          if (a.id === c.admin.id && a.disabled) throw new PulseError('VALIDATION', 'You cannot disable your own account');
          await s.adminAuth.setDisabled(a.id, a.disabled, c.admin.username);
          return {};
        },
      },
      'admins.resetPassword': {
        perm: 'admins',
        run: async (c) => {
          const a = parse(z.object({ id: z.string(), password: z.string().max(200) }), c.args);
          await s.adminAuth.resetPassword(a.id, a.password, c.admin.username);
          return {};
        },
      },

      // ── dashboard
      'dashboard.overview': {
        perm: 'read',
        run: async () => {
          const o = s.attendance.overview();
          return {
            ...o,
            timeline: s.attendance.timeline(40),
            monthly: s.attendance.monthlyReport(o.date.slice(0, 7)),
            pendingRequests: s.devices.pendingCount(),
            pendingApprovals: s.attendance.pendingApprovalCount(),
            health: await s.health(),
            qr: s.terminal.getCurrent(),
            mode: s.terminal.getMode(),
            qrMode: s.qrMode.view(),
            settings: s.settings(),
          };
        },
      },
      'attendance.history': {
        perm: 'read',
        run: (c) => {
          const tz = s.settings().timezone;
          const today = localParts(s.now(), tz).date;
          const a = parse(
            z.object({
              from: dateStr.optional(),
              to: dateStr.optional(),
              employeeId: z.string().max(40).optional(),
              status: z.string().max(30).optional(),
              classification: z.enum(['on-time', 'grace', 'late', 'off-day']).optional(),
              shiftId: z.string().max(80).optional(),
              q: z.string().max(100).optional(),
            }),
            c.args,
          );
          const from = a.from ?? addDays(today, -6);
          const to = a.to ?? today;
          if (from > to) throw new PulseError('VALIDATION', 'The start date is after the end date');
          return s.attendance.history({ ...a, from, to, limit: 3000 });
        },
      },
      'attendance.monthly': {
        perm: 'read',
        run: (c) => {
          const a = parse(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }), c.args);
          const month = a.month ?? localParts(s.now(), s.settings().timezone).date.slice(0, 7);
          return s.attendance.monthlyReport(month);
        },
      },
      'attendance.timeline': { perm: 'read', run: (c) => s.attendance.timeline(Math.min(Number(c.args?.limit) || 50, 200)) },

      // ── shifts
      'shifts.list': { perm: 'read', run: () => s.shifts.list() },
      'shifts.create': { perm: 'write', run: (c) => s.shifts.create(c.args, c.admin.username) },
      'shifts.update': { perm: 'write', run: (c) => s.shifts.update(c.args, c.admin.username) },
      'shifts.archive': { perm: 'write', run: (c) => s.shifts.archive(c.args, c.admin.username) },
      'shifts.restore': {
        perm: 'write',
        run: (c) => s.shifts.restore(parse(z.object({ id: z.string().max(80) }), c.args).id, c.admin.username),
      },
      'shifts.setActive': {
        perm: 'write',
        run: (c) => {
          const a = parse(z.object({ id: z.string().max(80), active: z.boolean() }), c.args);
          return s.shifts.setActive(a.id, a.active, c.admin.username);
        },
      },

      // ── approvals (late check-in after the window closed, overtime check-out)
      'approvals.list': {
        perm: 'read',
        run: (c) => {
          const a = parse(
            z.object({
              status: z.enum(['pending', 'approved', 'rejected', 'voided']).optional(),
              employeeId: z.string().max(40).optional(),
              from: dateStr.optional(),
              to: dateStr.optional(),
              limit: z.number().int().min(1).max(2000).optional(),
            }),
            c.args,
          );
          return s.attendance.approvals(a);
        },
      },
      'approvals.decide': { perm: 'write', run: (c) => s.attendance.decide(c.args, c.admin) },

      // ── registration queue
      'requests.list': {
        perm: 'read',
        run: (c) => s.devices.listRequests(parse(z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() }), c.args).status),
      },
      'requests.approve': {
        perm: 'write',
        run: async (c) => {
          const a = parse(z.object({ requestId: z.string().max(60) }), c.args);
          const dev = await s.devices.approve(a.requestId, c.admin);
          const { publicKey: _k, ...rest } = dev;
          void _k;
          return rest;
        },
      },
      'requests.reject': {
        perm: 'write',
        run: async (c) => {
          const a = parse(z.object({ requestId: z.string().max(60), reason: z.string().max(200) }), c.args);
          await s.devices.reject(a.requestId, a.reason, c.admin);
          return {};
        },
      },

      // ── employees
      'employees.list': {
        perm: 'read',
        run: () =>
          s.employees.list().map((e) => {
            const dev = s.devices.activeDeviceFor(e.id);
            const pending = s.devices.listRequests('pending').some((r) => r.employeeId.toLowerCase() === e.id.toLowerCase());
            return { ...e, device: dev ? { deviceId: dev.deviceId, label: dev.label, enrolledAt: dev.enrolledAt, lastSeenAt: s.devices.listDevices().find((d) => d.deviceId === dev.deviceId)?.lastSeenAt } : null, pendingRequest: pending };
          }),
      },
      'employees.create': { perm: 'write', run: (c) => s.employees.create(c.args, c.admin.username) },
      'employees.update': {
        perm: 'write',
        run: (c) => {
          const a = parse(z.object({ id: z.string().max(40), patch: z.record(z.unknown()) }), c.args);
          return s.employees.update(a.id, a.patch, c.admin.username);
        },
      },
      'employees.deactivate': {
        perm: 'write',
        run: (c) => {
          const a = parse(z.object({ id: z.string().max(40), reason: z.string().max(200) }), c.args);
          return s.employees.setActive(a.id, false, a.reason, c.admin.username);
        },
      },
      'employees.reactivate': {
        perm: 'write',
        run: (c) => s.employees.setActive(parse(z.object({ id: z.string().max(40) }), c.args).id, true, '', c.admin.username),
      },
      'employees.archive': {
        perm: 'write',
        run: (c) => {
          const a = parse(z.object({ id: z.string().max(40), reason: z.string().max(200) }), c.args);
          return s.employees.archive(a.id, a.reason, c.admin.username);
        },
      },
      'employees.restore': {
        perm: 'write',
        run: (c) => s.employees.restore(parse(z.object({ id: z.string().max(40) }), c.args).id, c.admin.username),
      },
      'employees.import': {
        perm: 'write',
        run: (c) => s.employees.importCsv(parse(z.object({ csv: z.string().max(500_000) }), c.args).csv, c.admin.username),
      },

      // ── devices
      'devices.list': {
        perm: 'read',
        run: () => s.devices.listDevices().map(({ publicKey: _k, ...rest }) => { void _k; return rest; }),
      },
      'devices.revoke': {
        perm: 'write',
        run: async (c) => {
          const a = parse(z.object({ deviceId: z.string().max(60), reason: z.string().max(200) }), c.args);
          await s.devices.revoke(a.deviceId, a.reason, c.admin);
          return {};
        },
      },
      'devices.archive': {
        perm: 'write',
        run: async (c) => {
          const a = parse(z.object({ deviceId: z.string().max(60), reason: z.string().max(200) }), c.args);
          await s.devices.archive(a.deviceId, a.reason, c.admin);
          return {};
        },
      },
      'devices.restore': {
        perm: 'write',
        run: async (c) => {
          await s.devices.restore(parse(z.object({ deviceId: z.string().max(60) }), c.args).deviceId, c.admin);
          return {};
        },
      },
      'devices.issueReplacement': {
        perm: 'write',
        run: async (c) => {
          const a = parse(z.object({ employeeId: z.string().max(40) }), c.args);
          const emp = s.employees.require(a.employeeId);
          if (emp.status !== 'active') throw new PulseError('EMPLOYEE_INACTIVE', 'Reactivate the employee first', 409);
          const qr = s.terminal.issueRegistration({ type: 'replacement', employeeId: emp.id, issuedBy: c.admin.username });
          await s.audit.record({ type: 'registration.token-issued', actor: c.admin.username, summary: `Replacement-device QR issued for ${emp.fullName} (${emp.id})`, details: { employeeId: emp.id } });
          return qr;
        },
      },

      // ── terminal / registration QR
      'terminal.get': { perm: 'read', run: () => ({ qr: s.terminal.getCurrent(), mode: s.terminal.getMode(), qrMode: s.qrMode.view() }) },
      'qrmode.get': { perm: 'read', run: () => s.qrMode.view() },
      'qrmode.set': {
        perm: 'write',
        run: async (c) => {
          const a = parse(z.object({ mode: z.enum(['timer', 'permanent']), expectedRevision: z.number().int().min(0).optional() }), c.args);
          const view = await s.qrMode.setMode(a.mode, c.admin.username, a.expectedRevision);
          return { qrMode: view, qr: s.terminal.getCurrent() };
        },
      },
      'qrmode.regeneratePermanent': {
        perm: 'write',
        run: async (c) => {
          const a = parse(z.object({ expectedRevision: z.number().int().min(0).optional() }), c.args);
          const view = await s.qrMode.regeneratePermanent(c.admin.username, a.expectedRevision);
          return { qrMode: view, qr: s.terminal.getCurrent() };
        },
      },
      'terminal.setMode': {
        perm: 'write',
        run: async (c) => {
          const a = parse(z.object({ mode: z.enum(['attendance', 'registration']) }), c.args);
          const qr = s.terminal.setMode(a.mode, c.admin.username);
          if (a.mode === 'registration') await s.audit.record({ type: 'registration.token-issued', actor: c.admin.username, summary: 'Registration QR mode enabled' });
          return { qr, mode: s.terminal.getMode() };
        },
      },
      'terminal.newRegistrationCode': {
        perm: 'write',
        run: async (c) => {
          const qr = s.terminal.issueRegistration({ type: 'registration', issuedBy: c.admin.username });
          await s.audit.record({ type: 'registration.token-issued', actor: c.admin.username, summary: 'New one-time registration QR issued' });
          return qr;
        },
      },

      // ── corrections
      'corrections.apply': { perm: 'write', run: (c) => s.attendance.correct(c.args, c.admin) },

      // ── settings
      'settings.get': { perm: 'read', run: () => s.settings() },
      'settings.update': { perm: 'settings', run: (c) => s.updateSettings(c.args, c.admin.username) },

      // ── export
      'export.run': { perm: 'export', run: (c) => s.exporter.run(c.args, c.admin.username) },
      'export.status': { perm: 'export', run: () => s.exporter.status },

      // ── audit
      'audit.list': {
        perm: 'read',
        run: (c) => {
          const a = parse(
            z.object({
              limit: z.number().int().min(1).max(1000).default(200),
              type: z.string().max(60).optional(),
              severity: z.enum(['info', 'notice', 'warning', 'critical']).optional(),
              q: z.string().max(100).optional(),
              securityOnly: z.boolean().optional(),
            }),
            c.args,
          );
          return s.audit.list(a);
        },
      },
      'audit.security': { perm: 'read', run: () => s.audit.securityOverview() },

      // ── host
      'host.health': { perm: 'read', run: () => s.health() },
      'host.verifyIntegrity': { perm: 'read', run: (c) => s.verifyIntegrity(c.admin.username) },
      'host.backup': { perm: 'write', run: (c) => s.backup(c.admin.username) },
      'host.acknowledgeClock': {
        perm: 'write',
        run: async (c) => {
          s.clock.acknowledge();
          await s.audit.record({ type: 'system.clock-acknowledged', severity: 'notice', actor: c.admin.username, summary: 'Administrator acknowledged the host clock warning' });
          return {};
        },
      },
      'host.liveEndpoint': { perm: 'read', run: () => ({ url: s.live.url }) },
      'host.network': { perm: 'read', run: () => ({ candidates: listLanCandidates(), current: s.bind }) },
    };
  }

  has(method: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.defs, method);
  }

  isPublic(method: string): boolean {
    return !!this.defs[method]?.public;
  }

  async call(method: string, token: string | undefined, args: unknown, source = 'local'): Promise<ApiResult<unknown>> {
    try {
      if (!this.has(method)) throw new PulseError('NOT_FOUND', 'Unknown operation', 404);
      const def = this.defs[method];
      if (def.public) {
        return { ok: true, data: await def.run({ admin: undefined as unknown as AdminAccount, token: '', args, source }) };
      }
      const { admin } = this.svc.adminAuth.authorize(token, def.perm);
      return { ok: true, data: await def.run({ admin, token: token!, args, source }) };
    } catch (e) {
      if (e instanceof PulseError) return { ok: false, error: { code: e.code, message: e.message } };
      console.error(`[pulse] admin call ${method} failed:`, e);
      return { ok: false, error: { code: 'INTERNAL', message: 'The operation failed unexpectedly. See the host log.' } };
    }
  }
}
