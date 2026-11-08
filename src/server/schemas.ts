import { z } from 'zod';
import { SCHEMA_VERSION } from '../shared/types';
import type { AdminAccount, Device, Employee, RegistrationRequest, Settings, Shift } from '../shared/types';
import { DEFAULT_SHIFT_RULES } from '../shared/shiftRules';
import { isValidTimezone, parseHHmm } from './time';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const CIDR = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}\/([0-9]|[12]\d|3[0-2])$/;

export const EMPLOYEE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
export const PHONE = /^\+?[0-9][0-9 ()-]{5,19}$/;

export const employeeIdSchema = z.string().trim().regex(EMPLOYEE_ID, 'Employee ID: 1–32 letters, digits, "-" or "_"');
export const fullNameSchema = z
  .string()
  .trim()
  .min(2, 'Full name is too short')
  .max(80, 'Full name is too long')
  .refine((s) => !/[\u0000-\u001f<>]/.test(s), 'Full name contains invalid characters');
export const phoneSchema = z
  .string()
  .trim()
  .regex(PHONE, 'Enter a valid phone number')
  .transform((s) => s.replace(/[\s()-]/g, ''));

export const jwkSchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

const settingsBase = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  hostId: z.string().regex(/^[A-Za-z0-9_-]{8,32}$/),
  orgName: z.string().trim().min(1).max(80),
  timezone: z.string().refine(isValidTimezone, 'Unknown timezone'),
  workStart: z.string().regex(HHMM),
  workEnd: z.string().regex(HHMM),
  graceMinutes: z.number().int().min(0).max(240),
  workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
  earliestCheckInMinutes: z.number().int().min(0).max(720),
  minIntervalSeconds: z.number().int().min(0).max(3600),
  allowMultipleSessions: z.boolean(),
  allowOffDayAttendance: z.boolean(),
  rotationSeconds: z.number().int().min(1).max(30),
  acceptWindowSeconds: z.number().int().min(3).max(60),
  registrationTokenMinutes: z.number().int().min(1).max(60),
  sessionIdleMinutes: z.number().int().min(1).max(240),
  bindAddress: z.string().refine((s) => s === '' || IPV4.test(s), 'Must be an IPv4 address or empty'),
  httpsPort: z.number().int().min(0).max(65535),
  setupHttpPort: z.number().int().min(0).max(65535),
  hostnames: z.array(z.string().regex(HOSTNAME)).max(10),
  allowedCidrs: z.array(z.string().regex(CIDR)).min(1).max(20),
  includePhoneInExports: z.boolean(),
  terminalShowsNames: z.boolean(),
  lowDiskWarnMB: z.number().int().min(1).max(100000),
});

export const settingsSchema = settingsBase
  .refine((s) => parseHHmm(s.workEnd) > parseHHmm(s.workStart), { message: 'Work end must be after work start', path: ['workEnd'] })
  .refine((s) => new Set(s.workDays).size === s.workDays.length, { message: 'Duplicate work days', path: ['workDays'] });

export const settingsPatchSchema = settingsBase.omit({ schemaVersion: true, hostId: true }).partial().strict();

const employeeSchema: z.ZodType<Employee> = z.object({
  id: employeeIdSchema,
  fullName: fullNameSchema,
  phone: z.string().min(5).max(24),
  department: z.string().max(60),
  status: z.enum(['active', 'inactive']),
  createdAt: z.string(),
  updatedAt: z.string(),
  deactivatedAt: z.string().optional(),
  deactivatedReason: z.string().optional(),
  archivedAt: z.string().optional(),
  archivedBy: z.string().optional(),
  archivedReason: z.string().optional(),
});

export const employeesFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  employees: z.array(employeeSchema),
});
export type EmployeesFile = z.infer<typeof employeesFileSchema>;

const deviceSchema: z.ZodType<Device> = z.object({
  deviceId: z.string(),
  employeeId: z.string(),
  publicKey: jwkSchema,
  label: z.string().max(120),
  userAgent: z.string().max(300),
  status: z.enum(['active', 'revoked']),
  enrolledAt: z.string(),
  approvedBy: z.string(),
  requestId: z.string(),
  lastSeenAt: z.string().optional(),
  revokedAt: z.string().optional(),
  revokedBy: z.string().optional(),
  revokedReason: z.string().optional(),
  archivedAt: z.string().optional(),
  archivedBy: z.string().optional(),
  archivedReason: z.string().optional(),
});

const requestSchema: z.ZodType<RegistrationRequest> = z.object({
  requestId: z.string(),
  type: z.enum(['registration', 'replacement']),
  fullName: z.string(),
  employeeId: z.string(),
  phone: z.string(),
  publicKey: jwkSchema,
  pollSecretHash: z.string(),
  userAgent: z.string().max(300),
  remoteAddr: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.string(),
  decidedAt: z.string().optional(),
  decidedBy: z.string().optional(),
  decisionReason: z.string().optional(),
  deviceId: z.string().optional(),
  flags: z.array(z.string()),
});

export const devicesFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  devices: z.array(deviceSchema),
  requests: z.array(requestSchema),
});
export type DevicesFile = z.infer<typeof devicesFileSchema>;

const adminSchema: z.ZodType<AdminAccount> = z.object({
  id: z.string(),
  username: z.string().min(3).max(40),
  displayName: z.string().min(1).max(80),
  role: z.enum(['owner', 'admin', 'auditor']),
  passwordHash: z.string(),
  createdAt: z.string(),
  disabled: z.boolean(),
  lastLoginAt: z.string().optional(),
  archivedAt: z.string().optional(),
  archivedBy: z.string().optional(),
  archivedReason: z.string().optional(),
});

export const adminsFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  admins: z.array(adminSchema),
});
export type AdminsFile = z.infer<typeof adminsFileSchema>;

const shiftSchema: z.ZodType<Shift, z.ZodTypeDef, unknown> = z.object({
  id: z.string().min(3).max(80),
  name: z.string().trim().min(1).max(60),
  start: z.string().regex(HHMM),
  end: z.string().regex(HHMM),
  graceMinutes: z.number().int().min(0).max(240),
  checkInCloseMinutes: z.number().int().min(0).max(720).default(DEFAULT_SHIFT_RULES.checkInCloseMinutes),
  earlyCheckInMinutes: z.number().int().min(0).max(720),
  checkOutOpenMinutes: z.number().int().min(0).max(720).default(DEFAULT_SHIFT_RULES.checkOutOpenMinutes),
  checkOutCloseMinutes: z.number().int().min(0).max(720).default(DEFAULT_SHIFT_RULES.checkOutCloseMinutes),
  active: z.boolean(),
  overnight: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdBy: z.string(),
  updatedBy: z.string(),
  archivedAt: z.string().optional(),
  archivedBy: z.string().optional(),
  archivedReason: z.string().optional(),
});

export const shiftsFileSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  shifts: z.array(shiftSchema),
});
export type ShiftsFile = z.infer<typeof shiftsFileSchema>;

export const DEFAULT_TIMEZONE = 'Asia/Kathmandu';

export function defaultSettings(hostId: string): Settings {
  const tz = DEFAULT_TIMEZONE;
  return {
    schemaVersion: SCHEMA_VERSION,
    hostId,
    orgName: 'My Organization',
    timezone: tz,
    workStart: '09:00',
    workEnd: '17:00',
    graceMinutes: 10,
    workDays: [1, 2, 3, 4, 5],
    earliestCheckInMinutes: 180,
    minIntervalSeconds: 60,
    allowMultipleSessions: false,
    allowOffDayAttendance: true,
    rotationSeconds: 3,
    acceptWindowSeconds: 10,
    registrationTokenMinutes: 5,
    sessionIdleMinutes: 15,
    bindAddress: '',
    httpsPort: 8443,
    setupHttpPort: 8081,
    hostnames: [],
    allowedCidrs: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8'],
    includePhoneInExports: true,
    terminalShowsNames: true,
    lowDiskWarnMB: 200,
  };
}

export function formatZodError(e: z.ZodError): string {
  return e.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
}
