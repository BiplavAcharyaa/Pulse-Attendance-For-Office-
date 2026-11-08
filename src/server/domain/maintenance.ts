import type { AdminView, CleanupFlag, CleanupItem, CleanupPlan, CleanupResult } from '../../shared/types';
import { PulseError } from '../errors';
import { Mutex } from '../storage/mutex';
import type { AuditService } from './audit';
import type { DeviceService } from './devices';
import type { EmployeeService } from './employees';

const DAY = 86_400_000;
const TEST_NAME = /^(test|tester|testing|demo|dummy|sample|temp|tmp|trial|qa)[._-]?\d*$/i;
const STALE_REVOKED_DAYS = 30;
const STALE_PENDING_DAYS = 7;
const UNUSED_ACTIVE_DAYS = 180;
const UNVERIFIED_TEST_ADMIN_DAYS = 7;

export interface MaintenanceDeps {
  admins: () => AdminView[];
  devices: DeviceService;
  employees: EmployeeService;
  audit: AuditService;
  now: () => number;
  lastDeviceUse: () => Map<string, string>;
  backup: (actor: string) => Promise<{ dir: string }>;
  archiveAdmin: (id: string, reason: string, actor: string) => Promise<void>;
  purgeSessions: () => number;
}

export class MaintenanceService {
  private readonly mutex = new Mutex();

  constructor(private readonly deps: MaintenanceDeps) {}

  plan(): CleanupPlan {
    const { admins, devices, employees, now } = this.deps;
    const t = now();
    const items: CleanupItem[] = [];
    const flagged: CleanupFlag[] = [];

    for (const a of admins()) {
      if (a.archivedAt || a.role === 'owner') continue;
      const testLike = TEST_NAME.test(a.username) || TEST_NAME.test(a.displayName);
      const neverSignedIn = !a.lastLoginAt;
      const ageDays = (t - Date.parse(a.createdAt)) / DAY;
      const label = `${a.username} (${a.role})`;
      if (testLike && neverSignedIn && (a.disabled || ageDays >= UNVERIFIED_TEST_ADMIN_DAYS)) {
        items.push({ action: 'archive-admin', id: a.id, label, reason: 'Test-style account that has never signed in' });
      } else if (testLike) {
        flagged.push({ kind: 'admin', id: a.id, label, reason: neverSignedIn ? 'Test-style account created recently' : 'Test-style account that has signed in' });
      } else if (a.disabled && neverSignedIn) {
        flagged.push({ kind: 'admin', id: a.id, label, reason: 'Disabled account that has never signed in' });
      }
    }

    const used = this.deps.lastDeviceUse();
    const allDevices = devices.listDevices();
    const activeByEmployee = new Map<string, string[]>();
    for (const d of allDevices) {
      const label = `${d.deviceId} (${d.employeeName ?? d.employeeId})`;
      if (d.status === 'active') {
        const key = d.employeeId.toLowerCase();
        activeByEmployee.set(key, [...(activeByEmployee.get(key) ?? []), d.deviceId]);
        if (!employees.get(d.employeeId)) flagged.push({ kind: 'device', id: d.deviceId, label, reason: 'Active device whose employee record does not exist' });
        else if (!used.has(d.deviceId) && (t - Date.parse(d.enrolledAt)) / DAY >= UNUSED_ACTIVE_DAYS) flagged.push({ kind: 'device', id: d.deviceId, label, reason: `Active device never used for attendance in ${UNUSED_ACTIVE_DAYS}+ days` });
      } else if (!d.archivedAt && d.revokedAt && (t - Date.parse(d.revokedAt)) / DAY >= STALE_REVOKED_DAYS) {
        items.push({ action: 'archive-device', id: d.deviceId, label, reason: `Revoked more than ${STALE_REVOKED_DAYS} days ago` });
      }
    }
    for (const [emp, ids] of activeByEmployee) {
      if (ids.length > 1) for (const id of ids) flagged.push({ kind: 'device', id, label: `${id} (${emp})`, reason: 'Employee has more than one active device' });
    }

    const deviceIds = new Set(allDevices.map((d) => d.deviceId));
    for (const r of devices.listRequests()) {
      const label = `${r.requestId} (${r.fullName}, ${r.employeeId})`;
      if (r.status === 'pending') {
        if ((t - Date.parse(r.createdAt)) / DAY >= STALE_PENDING_DAYS) items.push({ action: 'reject-request', id: r.requestId, label, reason: `Not reviewed within ${STALE_PENDING_DAYS} days` });
      } else if (r.status === 'approved' && r.deviceId && !deviceIds.has(r.deviceId)) {
        flagged.push({ kind: 'request', id: r.requestId, label, reason: 'Approved request whose device record is missing' });
      }
    }

    return { generatedAt: new Date(t).toISOString(), items, flagged };
  }

  async apply(actor: string): Promise<CleanupResult> {
    return this.mutex.run(async () => {
      const plan = this.plan();
      let backupDir: string | null = null;
      if (plan.items.length) {
        try {
          backupDir = (await this.deps.backup(actor)).dir;
        } catch (e) {
          throw new PulseError('CLEANUP_ABORTED', `Cleanup was not started because the backup failed: ${(e as Error).message}`, 500);
        }
      }
      const applied: CleanupItem[] = [];
      const skipped: CleanupResult['skipped'] = [];
      const by = { username: 'system' };
      for (const item of plan.items) {
        try {
          if (item.action === 'archive-admin') await this.deps.archiveAdmin(item.id, item.reason, actor);
          else if (item.action === 'archive-device') await this.deps.devices.archive(item.id, item.reason, { username: actor });
          else await this.deps.devices.reject(item.id, `Expired — ${item.reason}`, by);
          applied.push(item);
        } catch (e) {
          skipped.push({ ...item, error: (e as Error).message });
        }
      }
      const sessionsPurged = this.deps.purgeSessions();
      await this.deps.audit.record({
        type: 'maintenance.cleanup',
        severity: 'notice',
        actor,
        summary: `Cleanup applied: ${applied.length} item(s), ${skipped.length} skipped, ${plan.flagged.length} flagged for review`,
        details: { backupDir, applied: applied.map((i) => ({ action: i.action, id: i.id })), skipped: skipped.map((i) => ({ action: i.action, id: i.id, error: i.error })), flagged: plan.flagged.length, sessionsPurged },
      });
      return { backupDir, applied, skipped, flagged: plan.flagged, sessionsPurged };
    });
  }
}
