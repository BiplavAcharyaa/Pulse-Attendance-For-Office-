import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import type { DayRecord, ExportKind, ExportRequest, ExportStatus, LiveEvent, Settings } from '../shared/types';
import type { AttendanceService } from './domain/attendance';
import type { AuditService } from './domain/audit';
import type { DeviceService } from './domain/devices';
import type { EmployeeService } from './domain/employees';
import { PulseError, toStorageError } from './errors';
import { formatZodError } from './schemas';
import { addDays, eachDate, formatHm, isDateString, localParts, monthRange } from './time';

const NAVY = 'FF0B1F3A';
const BLUE = 'FF1D5FCF';
const MINT = 'FFDDF6E9';
const AMBER = 'FFFEF3C7';
const YELLOW = 'FFFFF3B0';
const ROSE = 'FFFEE4E2';
const GREY = 'FFEEF1F6';
const BORDER = { style: 'thin' as const, color: { argb: 'FFE3E8F0' } };

const requestSchema = z.object({
  kind: z.enum(['daily', 'monthly', 'range', 'employee', 'complete']),
  date: z.string().refine(isDateString).optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  from: z.string().refine(isDateString).optional(),
  to: z.string().refine(isDateString).optional(),
  employeeId: z.string().max(40).optional(),
});

function stamp(tz: string, ms: number): string {
  const p = localParts(ms, tz);
  return `${p.date.replace(/-/g, '')}-${p.time.replace(/:/g, '')}`;
}

function statusText(r: DayRecord): string {
  let t: string;
  switch (r.status) {
    case 'present': t = r.classification === 'grace' ? `Grace (${r.minutesLate ?? '?'} min)` : 'On time'; break;
    case 'late': t = `Late (${r.minutesLate ?? '?'} min)`; break;
    case 'absent': t = 'Absent'; break;
    case 'pending': t = 'Pending'; break;
    default: t = r.checkIn ? 'Non-working day (attended)' : 'Non-working day';
  }
  if (r.earlyLeave) t += ` · Left early (${r.minutesEarly} min)`;
  if (r.overtimeStatus) t += ` · Overtime ${r.overtimeStatus}${r.overtimeMinutes ? ` (${r.overtimeMinutes} min)` : ''}`;
  if (r.approvalPending) t += ' · Awaiting approval';
  if (r.missingCheckOut) t += ' · Missing check-out';
  return t;
}

function classificationText(r: DayRecord): string {
  switch (r.classification) {
    case 'on-time': return 'On time';
    case 'grace': return 'Grace';
    case 'late': return 'Late';
    case 'off-day': return 'Non-working day';
    default: return '';
  }
}

function classificationFill(r: DayRecord): string | null {
  switch (r.classification) {
    case 'on-time': return MINT;
    case 'grace': return YELLOW;
    case 'late': return ROSE;
    default: return null;
  }
}

function approvalText(r: DayRecord): string {
  return r.approvals
    .map((a) => {
      const label = a.kind === 'overtime' ? 'Overtime check-out' : 'Late check-in';
      const by = a.decidedByName ? ` by ${a.decidedByName}` : '';
      const why = a.reason ? ` — ${a.reason}` : '';
      return `${label} at ${a.localTime.slice(0, 5)}: ${a.status}${by}${why}`;
    })
    .join('\n');
}

function verificationText(r: DayRecord): string {
  if (r.verification === 'device-signature') return r.corrected ? 'Verified (device signature) + corrected' : 'Verified (device signature)';
  if (r.verification === 'manual-correction') return 'Manual correction by administrator';
  return 'No attendance record';
}

function styleHeader(ws: ExcelJS.Worksheet, row = 1): void {
  const r = ws.getRow(row);
  r.height = 24;
  r.eachCell((c) => {
    c.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Calibri', size: 11 };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    c.alignment = { vertical: 'middle', horizontal: 'left', wrapText: true };
    c.border = { bottom: { style: 'medium', color: { argb: BLUE } } };
  });
}

function finishSheet(ws: ExcelJS.Worksheet, columns: number, rows: number): void {
  ws.views = [{ state: 'frozen', ySplit: 1, xSplit: 0 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns } };
  for (let i = 2; i <= rows + 1; i++) {
    ws.getRow(i).eachCell((c) => {
      c.border = { bottom: BORDER };
      c.alignment = { vertical: 'top', wrapText: true };
    });
  }
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

export class ExportService {
  status: ExportStatus = { state: 'idle', progress: 0 };
  private busy = false;

  constructor(
    private readonly deps: {
      exportsDir: string;
      settings: () => Settings;
      employees: EmployeeService;
      devices: DeviceService;
      attendance: AttendanceService;
      audit: AuditService;
      auditEntries: () => ReturnType<AuditService['list']>;
      now: () => number;
      emit: (e: LiveEvent) => void;
    },
  ) {}

  private set(patch: Partial<ExportStatus>): void {
    this.status = { ...this.status, ...patch };
    this.deps.emit({ type: 'export.progress', data: this.status });
  }

  private resolveRange(req: ExportRequest): { from: string; to: string; label: string } {
    const s = this.deps.settings();
    const today = localParts(this.deps.now(), s.timezone).date;
    switch (req.kind) {
      case 'daily': {
        const d = req.date ?? today;
        return { from: d, to: d, label: d };
      }
      case 'monthly': {
        if (!req.month) throw new PulseError('VALIDATION', 'Choose a month');
        const r = monthRange(req.month);
        return { ...r, label: req.month };
      }
      case 'range': {
        if (!req.from || !req.to) throw new PulseError('VALIDATION', 'Choose a start and end date');
        return { from: req.from, to: req.to, label: `${req.from}_to_${req.to}` };
      }
      case 'employee': {
        if (!req.employeeId) throw new PulseError('VALIDATION', 'Choose an employee');
        const emp = this.deps.employees.require(req.employeeId);
        const from = req.from ?? localParts(Date.parse(emp.createdAt), s.timezone).date;
        const to = req.to ?? today;
        return { from, to, label: `${emp.id}_${from}_to_${to}` };
      }
      default: {
        const evs = this.deps.attendance.effective();
        const firstEvent = evs[0]?.localDate;
        const firstEmp = this.deps.employees.list().map((e) => localParts(Date.parse(e.createdAt), s.timezone).date).sort()[0];
        const from = req.from ?? [firstEvent, firstEmp, today].filter(Boolean).sort()[0]!;
        const to = req.to ?? today;
        return { from, to, label: `${from}_to_${to}` };
      }
    }
  }

  async run(input: unknown, actor: string): Promise<ExportStatus> {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) throw new PulseError('VALIDATION', formatZodError(parsed.error));
    const req = parsed.data as ExportRequest;
    if (this.busy) throw new PulseError('EXPORT_BUSY', 'Another export is still running', 409);
    this.busy = true;
    const startedAt = new Date(this.deps.now()).toISOString();
    this.status = { state: 'running', kind: req.kind, startedAt, progress: 2, step: 'Preparing' };
    this.set({});
    let tmp = '';
    try {
      const s = this.deps.settings();
      const range = this.resolveRange(req);
      if (range.from > range.to) throw new PulseError('VALIDATION', 'The start date is after the end date');
      if (eachDate(range.from, addDays(range.to, 0)).length > 3660) throw new PulseError('VALIDATION', 'The date range is too long (max 10 years)');

      this.set({ progress: 10, step: 'Collecting attendance records' });
      const rows = this.deps.attendance.range(range.from, range.to, req.kind === 'employee' ? req.employeeId : undefined);
      rows.sort((a, b) => (a.date === b.date ? a.employeeName.localeCompare(b.employeeName) : a.date.localeCompare(b.date)));

      const wb = new ExcelJS.Workbook();
      wb.creator = 'PULSE Attendance Intelligence Terminal';
      wb.created = new Date(this.deps.now());
      wb.title = `PULSE ${req.kind} attendance report`;

      this.set({ progress: 25, step: 'Writing report summary' });
      this.reportSheet(wb, req, range, rows.length, actor);

      this.set({ progress: 40, step: 'Writing attendance sheet' });
      this.attendanceSheet(wb, rows, s);
      this.monthlySheet(wb, range);

      if (req.kind === 'complete') {
        this.set({ progress: 55, step: 'Writing employees' });
        this.employeesSheet(wb, s);
        this.set({ progress: 65, step: 'Writing registered devices' });
        this.devicesSheet(wb, s);
        this.set({ progress: 75, step: 'Writing audit log' });
        this.auditSheet(wb, s);
        this.set({ progress: 82, step: 'Writing event log' });
        this.eventsSheet(wb, s, range);
      }

      await fs.mkdir(this.deps.exportsDir, { recursive: true, mode: 0o700 });
      const baseName = `PULSE_${req.kind}_${range.label}_${stamp(s.timezone, this.deps.now())}`.replace(/[^A-Za-z0-9._-]/g, '_');
      let fileName = `${baseName}.xlsx`;
      for (let n = 2; await fs.access(path.join(this.deps.exportsDir, fileName)).then(() => true, () => false); n++) fileName = `${baseName}-${n}.xlsx`;
      const filePath = path.join(this.deps.exportsDir, fileName);
      tmp = `${filePath}.partial`;
      this.set({ progress: 92, step: 'Saving file' });
      await wb.xlsx.writeFile(tmp);
      await fs.rename(tmp, filePath);
      tmp = '';

      const done: Partial<ExportStatus> = { state: 'done', progress: 100, step: 'Complete', finishedAt: new Date(this.deps.now()).toISOString(), filePath, fileName, rows: rows.length, error: undefined };
      this.set(done);
      await this.deps.audit.record({ type: 'export.created', actor, summary: `Exported ${req.kind} report (${rows.length} attendance rows) to ${fileName}`, details: { kind: req.kind, from: range.from, to: range.to, employeeId: req.employeeId, file: fileName, rows: rows.length } });
      return this.status;
    } catch (e) {
      if (tmp) await fs.rm(tmp, { force: true }).catch(() => undefined);
      const pe = e instanceof PulseError ? e : toStorageError(e, 'writing the export');
      this.set({ state: 'failed', progress: this.status.progress, finishedAt: new Date(this.deps.now()).toISOString(), error: pe.message, step: 'Failed' });
      await this.deps.audit.record({ type: 'export.failed', severity: 'warning', actor, summary: `Export (${req.kind}) failed: ${pe.message}` });
      throw pe;
    } finally {
      this.busy = false;
    }
  }

  private reportSheet(wb: ExcelJS.Workbook, req: ExportRequest, range: { from: string; to: string }, rowCount: number, actor: string): void {
    const s = this.deps.settings();
    const ws = wb.addWorksheet('Report', { properties: { tabColor: { argb: NAVY } } });
    ws.columns = [{ width: 28 }, { width: 70 }];
    const title = ws.addRow(['PULSE — Attendance Report']);
    ws.mergeCells('A1:B1');
    title.height = 30;
    title.getCell(1).font = { bold: true, size: 18, color: { argb: NAVY } };
    ws.addRow([]);
    const nowMs = this.deps.now();
    const emp = req.employeeId ? this.deps.employees.get(req.employeeId) : undefined;
    const filters: string[] = [];
    if (req.kind === 'employee' && emp) filters.push(`Employee: ${emp.fullName} (${emp.id})`);
    if (!filters.length) filters.push('None (all employees)');
    const lines: Array<[string, string]> = [
      ['Organization', s.orgName],
      ['Report type', req.kind[0].toUpperCase() + req.kind.slice(1)],
      ['Date range', `${range.from} to ${range.to}`],
      ['Filters', filters.join('; ')],
      ['Generated at', `${localParts(nowMs, s.timezone).date} ${localParts(nowMs, s.timezone).time} (${s.timezone})`],
      ['Generated at (UTC)', new Date(nowMs).toISOString()],
      ['Generated by', actor],
      ['Office hours', `${s.workStart}–${s.workEnd}, grace ${s.graceMinutes} min`],
      ['Attendance rows', String(rowCount)],
      ['Source', 'Derived from the append-only attendance event log. Exporting never modifies or deletes the original records.'],
    ];
    for (const [k, v] of lines) {
      const r = ws.addRow([k, v]);
      r.getCell(1).font = { bold: true, color: { argb: NAVY } };
      r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
      r.getCell(1).alignment = { vertical: 'top' };
      r.eachCell((c) => (c.border = { bottom: BORDER }));
    }
  }

  private attendanceSheet(wb: ExcelJS.Workbook, rows: DayRecord[], s: Settings): void {
    const ws = wb.addWorksheet('Attendance', { properties: { tabColor: { argb: BLUE } } });
    const cols: Array<{ header: string; key: string; width: number }> = [
      { header: 'Employee ID', key: 'id', width: 14 },
      { header: 'Employee Name', key: 'name', width: 26 },
      ...(s.includePhoneInExports ? [{ header: 'Phone', key: 'phone', width: 16 }] : []),
      { header: 'Date', key: 'date', width: 12 },
      { header: 'Check-in', key: 'in', width: 11 },
      { header: 'Check-out', key: 'out', width: 11 },
      { header: 'Check-out Date', key: 'outDate', width: 14 },
      { header: 'Shift', key: 'shift', width: 20 },
      { header: 'Classification', key: 'cls', width: 16 },
      { header: 'Hours Worked', key: 'hours', width: 13 },
      { header: 'Overtime Hours', key: 'overtime', width: 15 },
      { header: 'Approvals', key: 'approvals', width: 50 },
      { header: 'Attendance Status', key: 'status', width: 30 },
      { header: 'Verification Status', key: 'verification', width: 32 },
      { header: 'Device ID', key: 'device', width: 28 },
      { header: 'Check-in Event ID', key: 'inEvt', width: 32 },
      { header: 'Check-out Event ID', key: 'outEvt', width: 32 },
      { header: 'Correction History', key: 'corr', width: 60 },
    ];
    ws.columns = cols;
    for (const r of rows) {
      const row = ws.addRow({
        id: r.employeeId,
        name: r.employeeName,
        phone: r.phone,
        date: r.date,
        in: r.checkInLocal ?? '',
        out: r.checkOutLocal ?? '',
        outDate: [...r.sessions].reverse().find((x) => x.checkOutDate)?.checkOutDate ?? '',
        shift: r.shifts.map((x) => x.name).join(', '),
        cls: classificationText(r),
        hours: r.workedMinutes ? Math.round((r.workedMinutes / 60) * 100) / 100 : r.checkOut ? 0 : '',
        overtime: r.overtimeMinutes ? Math.round((r.overtimeMinutes / 60) * 100) / 100 : r.overtimeStatus ? 0 : '',
        approvals: approvalText(r),
        status: statusText(r),
        verification: verificationText(r),
        device: r.deviceId ?? '',
        inEvt: r.checkInEventId ?? '',
        outEvt: r.checkOutEventId ?? '',
        corr: r.corrections.join('\n'),
      });
      const fill = classificationFill(r) ?? (r.status === 'absent' ? ROSE : GREY);
      const clsCell = row.getCell('cls');
      clsCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      clsCell.font = { bold: true, color: { argb: NAVY } };
      const statusCell = row.getCell('status');
      statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      statusCell.font = { bold: true, color: { argb: NAVY } };
      row.getCell('hours').numFmt = '0.00';
      row.getCell('overtime').numFmt = '0.00';
    }
    styleHeader(ws);
    finishSheet(ws, cols.length, rows.length);
    void formatHm;
  }

  private monthlySheet(wb: ExcelJS.Workbook, range: { from: string; to: string }): void {
    const ws = wb.addWorksheet('Monthly Counts', { properties: { tabColor: { argb: 'FFE8A317' } } });
    const cols = [
      { header: 'Month', key: 'month', width: 10 },
      { header: 'Employee ID', key: 'id', width: 14 },
      { header: 'Employee Name', key: 'name', width: 26 },
      { header: 'On time', key: 'onTime', width: 10 },
      { header: 'Grace', key: 'grace', width: 10 },
      { header: 'Late', key: 'late', width: 10 },
      { header: 'Warning', key: 'warning', width: 52 },
    ];
    ws.columns = cols;
    const months = [...new Set(eachDate(range.from, range.to).map((d) => d.slice(0, 7)))];
    let n = 0;
    for (const month of months) {
      for (const m of this.deps.attendance.monthlyReport(month).rows) {
        const warn = [m.graceExceeded ? `Grace limit exceeded (${m.grace})` : '', m.lateExceeded ? `Late limit exceeded (${m.late})` : ''].filter(Boolean).join('; ');
        const row = ws.addRow({ month, id: m.employeeId, name: m.employeeName, onTime: m.onTime, grace: m.grace, late: m.late, warning: warn });
        row.getCell('onTime').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MINT } };
        row.getCell('grace').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: YELLOW } };
        row.getCell('late').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ROSE } };
        n++;
      }
    }
    styleHeader(ws);
    finishSheet(ws, cols.length, n);
  }

  private employeesSheet(wb: ExcelJS.Workbook, s: Settings): void {
    const ws = wb.addWorksheet('Employees', { properties: { tabColor: { argb: 'FF2E9E6B' } } });
    ws.columns = [
      { header: 'Employee ID', key: 'id', width: 14 },
      { header: 'Full Name', key: 'name', width: 28 },
      ...(s.includePhoneInExports ? [{ header: 'Phone', key: 'phone', width: 16 }] : []),
      { header: 'Department', key: 'dept', width: 20 },
      { header: 'Status', key: 'status', width: 11 },
      { header: 'Created', key: 'created', width: 20 },
      { header: 'Deactivated', key: 'deact', width: 20 },
      { header: 'Deactivation Reason', key: 'reason', width: 36 },
      { header: 'Archived', key: 'arch', width: 20 },
      { header: 'Archived By', key: 'archBy', width: 16 },
      { header: 'Archive Reason', key: 'archReason', width: 36 },
      { header: 'Active Device', key: 'device', width: 28 },
    ];
    const emps = this.deps.employees.list();
    for (const e of emps) {
      ws.addRow({
        id: e.id,
        name: e.fullName,
        phone: e.phone,
        dept: e.department,
        status: e.status,
        created: this.local(e.createdAt, s),
        deact: e.deactivatedAt ? this.local(e.deactivatedAt, s) : '',
        reason: e.deactivatedReason ?? '',
        arch: e.archivedAt ? this.local(e.archivedAt, s) : '',
        archBy: e.archivedBy ?? '',
        archReason: e.archivedReason ?? '',
        device: this.deps.devices.activeDeviceFor(e.id)?.deviceId ?? '',
      });
    }
    styleHeader(ws);
    finishSheet(ws, ws.columnCount, emps.length);
  }

  private devicesSheet(wb: ExcelJS.Workbook, s: Settings): void {
    const ws = wb.addWorksheet('Registered Devices', { properties: { tabColor: { argb: 'FF7A8BA8' } } });
    ws.columns = [
      { header: 'Device ID', key: 'id', width: 28 },
      { header: 'Employee ID', key: 'emp', width: 14 },
      { header: 'Employee Name', key: 'name', width: 26 },
      { header: 'Device', key: 'label', width: 26 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Enrolled', key: 'enrolled', width: 20 },
      { header: 'Approved By', key: 'by', width: 16 },
      { header: 'Last Seen', key: 'seen', width: 20 },
      { header: 'Revoked', key: 'revoked', width: 20 },
      { header: 'Revoked By', key: 'revBy', width: 16 },
      { header: 'Revocation Reason', key: 'revReason', width: 36 },
      { header: 'Archived', key: 'arch', width: 20 },
      { header: 'Archive Reason', key: 'archReason', width: 36 },
    ];
    const devs = this.deps.devices.listDevices();
    for (const d of devs) {
      ws.addRow({
        id: d.deviceId,
        emp: d.employeeId,
        name: d.employeeName ?? '',
        label: d.label,
        status: d.status,
        enrolled: this.local(d.enrolledAt, s),
        by: d.approvedBy,
        seen: d.lastSeenAt ? this.local(d.lastSeenAt, s) : '',
        revoked: d.revokedAt ? this.local(d.revokedAt, s) : '',
        revBy: d.revokedBy ?? '',
        revReason: d.revokedReason ?? '',
        arch: d.archivedAt ? this.local(d.archivedAt, s) : '',
        archReason: d.archivedReason ?? '',
      });
    }
    styleHeader(ws);
    finishSheet(ws, ws.columnCount, devs.length);
  }

  private auditSheet(wb: ExcelJS.Workbook, s: Settings): void {
    const ws = wb.addWorksheet('Audit Log', { properties: { tabColor: { argb: 'FFB45309' } } });
    ws.columns = [
      { header: 'Time', key: 'ts', width: 20 },
      { header: 'Severity', key: 'sev', width: 10 },
      { header: 'Type', key: 'type', width: 30 },
      { header: 'Actor', key: 'actor', width: 22 },
      { header: 'Summary', key: 'summary', width: 80 },
      { header: 'Sequence', key: 'seq', width: 10 },
    ];
    const entries = this.deps.auditEntries().slice().reverse();
    for (const a of entries) ws.addRow({ ts: this.local(a.ts, s), sev: a.severity, type: a.type, actor: a.actor, summary: a.summary, seq: a.seq });
    styleHeader(ws);
    finishSheet(ws, ws.columnCount, entries.length);
  }

  private eventsSheet(wb: ExcelJS.Workbook, s: Settings, range: { from: string; to: string }): void {
    const ws = wb.addWorksheet('Event Log', { properties: { tabColor: { argb: 'FF5B6B85' } } });
    ws.columns = [
      { header: 'Sequence', key: 'seq', width: 10 },
      { header: 'Event ID', key: 'id', width: 32 },
      { header: 'Type', key: 'type', width: 12 },
      { header: 'Employee ID', key: 'emp', width: 14 },
      { header: 'Kind / Operation', key: 'kind', width: 16 },
      { header: 'Time', key: 'ts', width: 20 },
      { header: 'Classification', key: 'cls', width: 14 },
      { header: 'Device ID', key: 'dev', width: 28 },
      { header: 'Target Event', key: 'target', width: 32 },
      { header: 'Administrator', key: 'admin', width: 20 },
      { header: 'Reason', key: 'reason', width: 50 },
      { header: 'Approval Status', key: 'apStatus', width: 16 },
      { header: 'Approved / Rejected By', key: 'apBy', width: 22 },
      { header: 'Overtime Minutes', key: 'apOt', width: 16 },
    ];
    const approvalByEvent = new Map(this.deps.attendance.approvals({ limit: 1_000_000 }).map((a) => [a.eventId, a]));
    const eventDate = new Map<string, string>();
    for (const e of this.deps.attendance.rawEvents()) if (e.type === 'attendance') eventDate.set(e.id, e.localDate);
    let n = 0;
    for (const e of this.deps.attendance.rawEvents()) {
      const date =
        e.type === 'attendance' ? e.localDate : e.type === 'approval' ? eventDate.get(e.targetEventId) ?? localParts(Date.parse(e.recordedAt), s.timezone).date : e.localDate ?? localParts(Date.parse(e.recordedAt), s.timezone).date;
      if (date < range.from || date > range.to) continue;
      n++;
      if (e.type === 'attendance') {
        const ap = approvalByEvent.get(e.id);
        ws.addRow({ seq: e.seq, id: e.id, type: 'device', emp: e.employeeId, kind: e.kind, ts: this.local(e.ts, s), cls: e.classification, dev: e.deviceId, apStatus: ap?.status ?? '', apBy: ap?.decidedByName ?? '', apOt: ap?.overtimeMinutes ?? '' });
      } else if (e.type === 'approval') {
        ws.addRow({ seq: e.seq, id: e.id, type: 'approval', emp: e.employeeId, kind: `${e.decision} ${e.kind}`, ts: this.local(e.recordedAt, s), target: e.targetEventId, admin: e.adminName, reason: e.reason, apStatus: e.decision, apBy: e.adminName, apOt: e.overtimeMinutes ?? '' });
      } else {
        ws.addRow({ seq: e.seq, id: e.id, type: 'correction', emp: e.employeeId, kind: e.op + (e.kind ? ` ${e.kind}` : ''), ts: this.local(e.ts ?? e.recordedAt, s), cls: e.classification ?? '', target: e.targetEventId ?? '', admin: e.adminName, reason: e.reason });
      }
    }
    styleHeader(ws);
    finishSheet(ws, ws.columnCount, n);
  }

  private local(iso: string, s: Settings): string {
    const p = localParts(Date.parse(iso), s.timezone);
    return `${p.date} ${p.time}`;
  }
}

export type { ExportKind };
