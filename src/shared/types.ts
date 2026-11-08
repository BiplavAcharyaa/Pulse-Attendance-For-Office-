// Shared domain types used by the host service, Electron main process and both web UIs.
// This file must stay free of Node-only or DOM-only imports.

export const SCHEMA_VERSION = 1;

// ───────────────────────── Employees ─────────────────────────
export type EmployeeStatus = 'active' | 'inactive';

export interface Employee {
  id: string; // employee ID, e.g. "E-1004"
  fullName: string;
  phone: string;
  department: string;
  status: EmployeeStatus;
  createdAt: string;
  updatedAt: string;
  deactivatedAt?: string;
  deactivatedReason?: string;
  archivedAt?: string;
  archivedBy?: string;
  archivedReason?: string;
}

// ───────────────────────── Devices ─────────────────────────
export interface PublicKeyJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export type DeviceStatus = 'active' | 'revoked';

export interface Device {
  deviceId: string;
  employeeId: string;
  publicKey: PublicKeyJwk;
  label: string;
  userAgent: string;
  status: DeviceStatus;
  enrolledAt: string;
  approvedBy: string;
  requestId: string;
  lastSeenAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  revokedReason?: string;
  archivedAt?: string;
  archivedBy?: string;
  archivedReason?: string;
}

export type RequestType = 'registration' | 'replacement';
export type RequestStatus = 'pending' | 'approved' | 'rejected';

export interface RegistrationRequest {
  requestId: string;
  type: RequestType;
  fullName: string;
  employeeId: string;
  phone: string;
  publicKey: PublicKeyJwk;
  pollSecretHash: string;
  userAgent: string;
  remoteAddr: string;
  status: RequestStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionReason?: string;
  deviceId?: string;
  flags: string[];
}

/** Request as shown to administrators (no secrets). */
export type RegistrationRequestView = Omit<RegistrationRequest, 'pollSecretHash'>;

// ───────────────────────── Settings ─────────────────────────
export interface Settings {
  schemaVersion: number;
  hostId: string;
  orgName: string;
  timezone: string;
  workStart: string; // HH:mm
  workEnd: string; // HH:mm
  graceMinutes: number;
  workDays: number[]; // 0 = Sunday … 6 = Saturday
  earliestCheckInMinutes: number; // how long before workStart check-in is accepted
  minIntervalSeconds: number; // cooldown between two events of the same employee
  allowMultipleSessions: boolean;
  allowOffDayAttendance: boolean;
  rotationSeconds: number; // displayed QR rotation
  acceptWindowSeconds: number; // how long a rotated challenge stays valid
  registrationTokenMinutes: number;
  sessionIdleMinutes: number;
  bindAddress: string; // '' = auto-detect private LAN IPv4
  httpsPort: number;
  setupHttpPort: number; // plain-HTTP trust bootstrap page (CA download only)
  hostnames: string[]; // extra DNS names included in the TLS certificate
  allowedCidrs: string[]; // network policy for phone requests
  includePhoneInExports: boolean;
  terminalShowsNames: boolean;
  lowDiskWarnMB: number;
}

// ───────────────────────── Shifts ─────────────────────────
export interface Shift {
  id: string;
  name: string;
  start: string; // HH:mm
  end: string; // HH:mm; at or before start means the shift ends on the next day
  graceMinutes: number;
  checkInCloseMinutes: number;
  earlyCheckInMinutes: number;
  checkOutOpenMinutes: number;
  checkOutCloseMinutes: number;
  active: boolean;
  overnight: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  archivedAt?: string;
  archivedBy?: string;
  archivedReason?: string;
}

export interface ShiftSnapshot {
  id: string;
  name: string;
  start: string;
  end: string;
  startAt: string; // ISO UTC instant the detected shift instance starts
  endAt: string; // ISO UTC instant the detected shift instance ends
  graceMinutes: number;
  checkInCloseMinutes?: number;
  earlyCheckInMinutes?: number;
  checkOutOpenMinutes?: number;
  checkOutCloseMinutes?: number;
}

// ───────────────────────── Attendance events ─────────────────────────
export type EventKind = 'check-in' | 'check-out';
export type Classification = 'on-time' | 'grace' | 'late' | 'very-late' | 'off-day' | 'normal' | 'early-leave' | 'overtime';
export type ArrivalClassification = 'on-time' | 'grace' | 'late' | 'off-day';

export type ApprovalKind = 'late-check-in' | 'overtime';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'voided';

export interface ApprovalInfo {
  kind: ApprovalKind;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decidedByName?: string;
  reason?: string;
  overtimeMinutes?: number;
}

export interface ChainFields {
  seq: number;
  prevHash: string;
  hash: string;
}

export interface AttendanceEventBody {
  v: 1;
  id: string;
  type: 'attendance';
  kind: EventKind;
  employeeId: string;
  deviceId: string;
  ts: string; // host-generated ISO-8601 UTC
  tz: string;
  localDate: string; // YYYY-MM-DD in office timezone
  localTime: string; // HH:mm:ss in office timezone
  classification: Classification;
  minutes?: number; // minutes late / early
  verification: 'device-signature';
  challengeId: string;
  remoteAddr: string;
  workDate?: string; // date the session's shift (or day) belongs to
  shift?: ShiftSnapshot; // detected at check-in, carried unchanged through check-out
  sessionId?: string; // id of the check-in event that opened the session
  idempotencyKey?: string;
  approval?: ApprovalInfo; // present when the scan needed administrator approval
}
export type AttendanceEvent = AttendanceEventBody & ChainFields;

export type CorrectionOp = 'add' | 'void' | 'amend';
export interface CorrectionEventBody {
  v: 1;
  id: string;
  type: 'correction';
  op: CorrectionOp;
  employeeId: string;
  targetEventId?: string; // void / amend
  kind?: EventKind; // add
  ts?: string; // add / amend: corrected instant (ISO UTC)
  tz: string;
  localDate?: string;
  localTime?: string;
  classification?: Classification;
  minutes?: number;
  workDate?: string;
  shift?: ShiftSnapshot;
  reason: string;
  adminId: string;
  adminName: string;
  recordedAt: string;
}
export type CorrectionEvent = CorrectionEventBody & ChainFields;

export interface ApprovalEventBody {
  v: 1;
  id: string;
  type: 'approval';
  targetEventId: string;
  employeeId: string;
  kind: ApprovalKind;
  decision: 'approved' | 'rejected';
  reason: string;
  adminId: string;
  adminName: string;
  recordedAt: string;
  overtimeMinutes?: number;
}
export type ApprovalEvent = ApprovalEventBody & ChainFields;

export type LogEvent = AttendanceEvent | CorrectionEvent | ApprovalEvent;

export interface ApprovalView {
  eventId: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  eventKind: EventKind;
  employeeId: string;
  employeeName: string;
  department: string;
  ts: string;
  localDate: string;
  localTime: string;
  workDate: string;
  shiftId?: string;
  shiftName?: string;
  shiftStart?: string;
  shiftEnd?: string;
  shiftStartAt?: string;
  shiftEndAt?: string;
  minutes: number; // minutes after shift start (late check-in) or after shift end (overtime)
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decidedByName?: string;
  reason?: string;
  overtimeMinutes?: number;
  deviceId?: string;
  remoteAddr?: string;
}

// ───────────────────────── Derived attendance ─────────────────────────
export type ArrivalStatus = 'present' | 'late' | 'absent' | 'pending' | 'off-day';
export type PresenceState = 'not-arrived' | 'checked-in' | 'checked-out';

export interface DayRecord {
  employeeId: string;
  employeeName: string;
  phone: string;
  department: string;
  date: string;
  status: ArrivalStatus;
  state: PresenceState;
  checkIn?: string;
  checkInLocal?: string;
  checkOut?: string;
  checkOutLocal?: string;
  workedMinutes: number;
  minutesLate?: number;
  classification?: ArrivalClassification;
  earlyLeave: boolean;
  minutesEarly?: number;
  overtimeMinutes: number;
  overtimeStatus?: ApprovalStatus;
  approvalPending: boolean;
  approvals: ApprovalView[];
  missingCheckOut: boolean;
  shiftId?: string;
  shiftName?: string;
  shifts: Array<{ id: string; name: string }>;
  sessions: SessionView[];
  corrected: boolean;
  verification: 'device-signature' | 'manual-correction' | 'none';
  deviceId?: string;
  checkInEventId?: string;
  checkOutEventId?: string;
  corrections: string[];
  events: Array<{
    id: string;
    kind: EventKind;
    ts: string;
    date: string;
    local: string;
    shiftName?: string;
    classification: Classification;
    minutes?: number;
    source: 'device' | 'correction';
    deviceId?: string;
    remoteAddr?: string;
    sessionId: string;
    approval?: ApprovalInfo;
  }>;
}

export interface SessionView {
  sessionId: string;
  shiftId?: string;
  shiftName?: string;
  checkIn: string;
  checkInLocal: string;
  checkInDate: string;
  classification: Classification;
  minutes?: number;
  checkOut?: string;
  checkOutLocal?: string;
  checkOutDate?: string;
  open: boolean;
  missingCheckOut: boolean;
  workedMinutes: number;
  shiftEndAt?: string;
  overtimeMinutes: number;
  overtimeStatus?: ApprovalStatus;
}

export interface OverviewCounts {
  total: number;
  present: number;
  onTime: number;
  grace: number;
  late: number;
  absent: number;
  pending: number;
  checkedIn: number;
  checkedOut: number;
  offDay: number;
  awaitingApproval: number;
}

export interface MonthlyCounts {
  month: string;
  employeeId: string;
  employeeName: string;
  department: string;
  onTime: number;
  grace: number;
  late: number;
  graceExceeded: boolean;
  lateExceeded: boolean;
}

export interface MonthlyReport {
  month: string;
  graceLimit: number;
  lateLimit: number;
  rows: MonthlyCounts[];
  exceeding: MonthlyCounts[];
}

export interface AttendanceWarning {
  employeeId: string;
  employeeName: string;
  month: string;
  graceCount: number;
  lateCount: number;
  graceLimit: number;
  lateLimit: number;
  graceExceeded: boolean;
  lateExceeded: boolean;
  violations: string[];
  message: string;
}

// ───────────────────────── Audit ─────────────────────────
export type Severity = 'info' | 'notice' | 'warning' | 'critical';

export interface AuditBody {
  v: 1;
  id: string;
  ts: string;
  type: string;
  severity: Severity;
  actor: string; // admin username, "system", "device:<id>" or "anonymous"
  summary: string;
  details?: Record<string, unknown>;
}
export type AuditEntry = AuditBody & ChainFields;

// ───────────────────────── Admin ─────────────────────────
export type AdminRole = 'owner' | 'admin' | 'auditor';

export interface AdminAccount {
  id: string;
  username: string;
  displayName: string;
  role: AdminRole;
  passwordHash: string;
  createdAt: string;
  disabled: boolean;
  lastLoginAt?: string;
  archivedAt?: string;
  archivedBy?: string;
  archivedReason?: string;
}

export interface AdminView {
  id: string;
  username: string;
  displayName: string;
  role: AdminRole;
  createdAt: string;
  disabled: boolean;
  lastLoginAt?: string;
  archivedAt?: string;
  archivedBy?: string;
  archivedReason?: string;
}

export type CleanupAction = 'archive-admin' | 'archive-device' | 'reject-request';

export interface CleanupItem {
  action: CleanupAction;
  id: string;
  label: string;
  reason: string;
}

export interface CleanupFlag {
  kind: 'admin' | 'device' | 'request';
  id: string;
  label: string;
  reason: string;
}

export interface CleanupPlan {
  generatedAt: string;
  items: CleanupItem[];
  flagged: CleanupFlag[];
}

export interface CleanupResult {
  backupDir: string | null;
  applied: CleanupItem[];
  skipped: Array<CleanupItem & { error: string }>;
  flagged: CleanupFlag[];
  sessionsPurged: number;
}

export interface SessionInfo {
  token: string;
  admin: AdminView;
  expiresInMinutes: number;
}

// ───────────────────────── Host / health ─────────────────────────
export interface HostHealth {
  startedAt: string;
  uptimeSeconds: number;
  lanAddress: string;
  httpsPort: number;
  setupHttpPort: number;
  httpsUrl: string;
  setupUrl: string;
  listening: boolean;
  wsClients: number;
  adminLiveClients: number;
  timezone: string;
  hostTime: string;
  storage: {
    status: 'ok' | 'degraded' | 'critical';
    dataDir: string;
    freeMB: number | null;
    lowDisk: boolean;
    diskFull: boolean;
    messages: string[];
    attendanceEvents: number;
    auditEntries: number;
    lastIntegrityCheck?: { at: string; ok: boolean; problems: number };
  };
  secretsProtection: 'os-protected' | 'file-permissions-only';
  tls: { caFingerprint: string; leafExpires: string; names: string[] };
  latestEvent?: { id: string; employeeId: string; employeeName: string; kind: EventKind; ts: string };
  clock: { suspect: boolean; message?: string };
  lastExport?: ExportStatus;
}

export interface IntegrityReport {
  at: string;
  ok: boolean;
  files: Array<{ file: string; records: number; ok: boolean; problems: string[] }>;
}

// ───────────────────────── Export ─────────────────────────
export type ExportKind = 'daily' | 'monthly' | 'range' | 'employee' | 'complete';

export interface ExportRequest {
  kind: ExportKind;
  date?: string; // daily
  month?: string; // monthly: YYYY-MM
  from?: string; // range / employee / complete (optional)
  to?: string;
  employeeId?: string;
}

export interface ExportStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  kind?: ExportKind;
  startedAt?: string;
  finishedAt?: string;
  progress: number; // 0-100
  step?: string;
  filePath?: string;
  fileName?: string;
  rows?: number;
  error?: string;
}

// ───────────────────────── Terminal / live ─────────────────────────
export type TerminalMode = 'attendance' | 'registration';

export type QrMode = 'timer' | 'permanent';

export interface QrModeView {
  activeMode: QrMode;
  revision: number;
  hasPermanent: boolean;
  permanentGeneration: number;
  permanentCreatedAt?: string;
  permanentCreatedBy?: string;
  changedAt: string;
  changedBy: string;
  rotationSeconds: number;
}

export interface TerminalQr {
  mode: TerminalMode;
  qrMode?: QrMode;
  url: string; // payload encoded into the QR
  issuedAt: number; // epoch ms (host clock)
  rotationMs: number; // attendance: rotation period; registration: validity
  expiresAt: number;
  hostTime: number;
}

export interface FeedItem {
  id: string;
  ts: string;
  employeeId: string;
  employeeName: string;
  kind: EventKind;
  classification: Classification;
  local: string;
}

export type LiveEvent =
  | { type: 'qr'; data: TerminalQr }
  | { type: 'attendance.saved'; data: { event: AttendanceEvent; employeeName: string; counts: OverviewCounts; warning?: AttendanceWarning } }
  | { type: 'attendance.rejected'; data: { code: string; message: string; employeeId?: string; at: string } }
  | { type: 'request.created'; data: RegistrationRequestView }
  | { type: 'request.decided'; data: RegistrationRequestView }
  | { type: 'device.changed'; data: { deviceId: string; employeeId: string; status: DeviceStatus } }
  | { type: 'employee.changed'; data: { employeeId: string } }
  | { type: 'registration.token'; data: { used: boolean; expiresAt: number } }
  | { type: 'audit'; data: AuditEntry }
  | { type: 'health'; data: HostHealth }
  | { type: 'export.progress'; data: ExportStatus }
  | { type: 'settings.changed'; data: { at: string } }
  | { type: 'correction.saved'; data: { employeeId: string; date: string } }
  | { type: 'terminal.mode'; data: { mode: TerminalMode } }
  | { type: 'qr.mode'; data: QrModeView }
  | { type: 'shifts.changed'; data: { at: string } }
  | { type: 'approval.requested'; data: ApprovalView }
  | { type: 'approval.decided'; data: ApprovalView }
  | { type: 'archive.changed'; data: { entity: 'employee' | 'device' | 'shift'; id: string; archived: boolean } };

// ───────────────────────── API envelope ─────────────────────────
export interface ApiError {
  code: string;
  message: string;
}
export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };
