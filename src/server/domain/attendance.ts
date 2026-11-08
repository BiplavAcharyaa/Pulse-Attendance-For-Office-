import { z } from 'zod';
import { ERROR_MESSAGES } from '../../shared/protocol';
import { MONTHLY_GRACE_LIMIT, MONTHLY_LATE_LIMIT, checkInBand, checkInClosesMs, checkOutBand, checkOutClosesMs, checkOutOpensMs, rulesOf } from '../../shared/shiftRules';
import type {
  ApprovalEventBody,
  ApprovalInfo,
  ApprovalKind,
  ApprovalStatus,
  ApprovalView,
  ArrivalClassification,
  AttendanceEvent,
  AttendanceEventBody,
  AttendanceWarning,
  CorrectionEvent,
  CorrectionEventBody,
  DayRecord,
  Employee,
  EventKind,
  LiveEvent,
  LogEvent,
  MonthlyReport,
  OverviewCounts,
  Settings,
  Shift,
  ShiftSnapshot,
} from '../../shared/types';
import type { ClockGuard } from '../clock';
import { PulseError } from '../errors';
import { newId } from '../ids';
import { formatZodError } from '../schemas';
import type { JsonlLog } from '../storage/jsonl';
import { Mutex } from '../storage/mutex';
import { isDateString, localParts, localToUtcMs, parseHHmm } from '../time';
import type { AuditService } from './audit';
import {
  assignSessions,
  buildDayRecord,
  buildMonthlyReport,
  buildRange,
  classifyCheckIn,
  classifyCheckOut,
  classifyShiftCheckIn,
  classifyShiftCheckOut,
  countsFor,
  foldLog,
  indexByEmployeeDay,
  isWorkDay,
  monthOf,
  monthlyRow,
  secondsOfDay,
  tallyMonths,
  toApprovalView,
  type EffectiveEvent,
  type MonthTally,
  type EffectiveView,
} from './derive';
import type { EmployeeService } from './employees';
import { detectShift, snapshotOf, type ShiftInstance } from './shifts';

export type LogEventBody = AttendanceEventBody | CorrectionEventBody | ApprovalEventBody;

export interface ApprovalBrief {
  kind: ApprovalKind;
  status: ApprovalStatus;
  eventKind: EventKind;
  localTime: string;
  shiftName?: string;
  reason?: string;
  decidedByName?: string;
  overtimeMinutes?: number;
}

export interface AttendanceStatusView {
  state: DayRecord['state'];
  nextAction: EventKind | 'none';
  today: Pick<DayRecord, 'date' | 'status' | 'checkInLocal' | 'checkOutLocal' | 'workedMinutes' | 'minutesLate' | 'classification' | 'earlyLeave' | 'overtimeMinutes' | 'overtimeStatus'>;
  approval?: ApprovalBrief;
  shiftName?: string;
  lastEvent: { kind: EventKind; ts: string; date: string; local: string } | null;
}

export type RecordIntent = EventKind | 'auto';

export interface RecordResult {
  duplicate?: boolean;
  warning?: AttendanceWarning;
  pendingApproval: boolean;
  event: AttendanceEvent;
  shiftName?: string;
  employee: Employee;
  message: string;
  day: DayRecord;
}

const reasonSchema = z.string().trim().min(5, 'A reason of at least 5 characters is required').max(300);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:mm');
const dateStr = z.string().refine(isDateString, 'Date must be YYYY-MM-DD');

const decisionSchema = z.object({
  eventId: z.string().min(3).max(80),
  decision: z.enum(['approve', 'reject']),
  reason: reasonSchema,
});

const correctionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), employeeId: z.string().min(1).max(40), kind: z.enum(['check-in', 'check-out']), date: dateStr, time: hhmm, reason: reasonSchema }),
  z.object({ op: z.literal('void'), eventId: z.string().min(3).max(80), reason: reasonSchema }),
  z.object({ op: z.literal('amend'), eventId: z.string().min(3).max(80), date: dateStr, time: hhmm, reason: reasonSchema }),
]);

function reject(code: string, message?: string, status = 409): never {
  throw new PulseError(code, message ?? ERROR_MESSAGES[code] ?? code, status);
}

export class AttendanceService {
  private readonly mutex = new Mutex();
  private cache: { count: number; tz: string; view: EffectiveView; tally?: Map<string, MonthTally> } | null = null;
  private readonly idemIndex = new Map<string, string>();
  private idemIndexed = 0;

  constructor(
    private readonly log: JsonlLog<LogEventBody>,
    private readonly employees: EmployeeService,
    private readonly settings: () => Settings,
    private readonly now: () => number,
    private readonly audit: AuditService,
    private readonly emit: (e: LiveEvent) => void,
    private readonly clock: ClockGuard,
    private readonly shifts: () => Shift[] = () => [],
  ) {}

  get eventCount(): number {
    return this.log.count;
  }

  private view(): EffectiveView {
    const tz = this.settings().timezone;
    if (!this.cache || this.cache.count !== this.log.count || this.cache.tz !== tz) {
      this.cache = { count: this.log.count, tz, view: foldLog(this.log.records as LogEvent[], tz) };
    }
    return this.cache.view;
  }

  private rules() {
    return this.settings();
  }

  private tally(): Map<string, MonthTally> {
    this.view();
    const c = this.cache!;
    c.tally ??= tallyMonths(c.view.events);
    return c.tally;
  }

  private findByIdempotency(deviceId: string, key: string): AttendanceEvent | undefined {
    const recs = this.log.records;
    for (; this.idemIndexed < recs.length; this.idemIndexed++) {
      const r = recs[this.idemIndexed];
      if (r.type === 'attendance' && r.idempotencyKey) this.idemIndex.set(`${r.deviceId}|${r.idempotencyKey}`, r.id);
    }
    const id = this.idemIndex.get(`${deviceId}|${key}`);
    return id ? (recs.find((r) => r.id === id) as AttendanceEvent | undefined) : undefined;
  }

  warningFor(emp: Pick<Employee, 'id' | 'fullName' | 'department'>, month: string): AttendanceWarning | undefined {
    const row = monthlyRow(emp, month, this.tally().get(`${emp.id}|${month}`));
    if (!row.graceExceeded && !row.lateExceeded) return undefined;
    const violations: string[] = [];
    if (row.graceExceeded) violations.push(`Grace arrivals: ${row.grace} this month (limit ${MONTHLY_GRACE_LIMIT}, warning from the ${MONTHLY_GRACE_LIMIT + 1}th)`);
    if (row.lateExceeded) violations.push(`Late arrivals: ${row.late} this month (limit ${MONTHLY_LATE_LIMIT}, warning from the ${MONTHLY_LATE_LIMIT + 1}rd)`);
    const both = row.graceExceeded && row.lateExceeded;
    const what = both ? 'both the monthly grace and late limits' : row.graceExceeded ? 'the monthly grace limit' : 'the monthly late limit';
    return {
      employeeId: emp.id,
      employeeName: emp.fullName,
      month,
      graceCount: row.grace,
      lateCount: row.late,
      graceLimit: MONTHLY_GRACE_LIMIT,
      lateLimit: MONTHLY_LATE_LIMIT,
      graceExceeded: row.graceExceeded,
      lateExceeded: row.lateExceeded,
      violations,
      message: `${emp.fullName} (${emp.id}) has exceeded ${what} for ${month}. Repeated lateness must be corrected; please speak to your manager.`,
    };
  }

  monthlyReport(month: string): MonthlyReport {
    return buildMonthlyReport(month, this.employees.list(), this.tally());
  }

  latestRecord(): LogEvent | undefined {
    return this.log.records[this.log.records.length - 1] as LogEvent | undefined;
  }

  private planCheckIn(emp: Employee, nowMs: number, mine: EffectiveEvent[]): { ok: true; workDate: string; instance?: ShiftInstance } | { ok: false; code: string; message?: string } {
    const s = this.rules();
    const local = localParts(nowMs, s.timezone);
    const active = this.shifts();
    let workDate = local.date;
    let instance: ShiftInstance | undefined;
    if (active.length) {
      const det = detectShift(nowMs, s.timezone, active);
      if (det.kind === 'none') return { ok: false, code: 'NO_SHIFT_OPEN' };
      if (det.kind === 'ambiguous') return { ok: false, code: 'SHIFT_AMBIGUOUS' };
      instance = det.instance;
      workDate = instance.date;
      const held = this.view().approvals.find(
        (a) => a.employeeId === emp.id && a.eventKind === 'check-in' && a.workDate === workDate && a.shiftId === instance!.shift.id && (a.status === 'pending' || a.status === 'rejected'),
      );
      if (held) return { ok: false, code: held.status === 'pending' ? 'APPROVAL_PENDING' : 'APPROVAL_REJECTED' };
    }
    const workDay = isWorkDay(workDate, s);
    if (!workDay && !s.allowOffDayAttendance) return { ok: false, code: 'OFF_DAY', message: 'Attendance is not recorded on non-working days.' };
    if (!s.allowMultipleSessions && mine.some((e) => e.kind === 'check-in' && e.workDate === workDate && (e.shift?.id ?? null) === (instance?.shift.id ?? null))) {
      return { ok: false, code: 'DAY_COMPLETE' };
    }
    if (!instance && workDay) {
      const opens = parseHHmm(s.workStart) - s.earliestCheckInMinutes;
      if (local.minutes < opens) {
        const hh = String(Math.floor(Math.max(opens, 0) / 60)).padStart(2, '0');
        const mm = String(Math.max(opens, 0) % 60).padStart(2, '0');
        return { ok: false, code: 'TOO_EARLY', message: `Check-in opens at ${hh}:${mm}.` };
      }
    }
    return { ok: true, workDate, instance };
  }

  private mineOf(employeeId: string): EffectiveEvent[] {
    return this.view().events.filter((e) => e.employeeId === employeeId);
  }

  // ───────────── Recording (device-verified attendance) ─────────────
  async record(p: { employeeId: string; deviceId: string; intent: RecordIntent; challengeId: string; remoteAddr: string; idempotencyKey?: string }): Promise<RecordResult> {
    return this.mutex.run(async () => {
      if (p.idempotencyKey) {
        const prior = this.findByIdempotency(p.deviceId, p.idempotencyKey);
        if (prior && prior.employeeId === p.employeeId) return this.replayOf(prior);
      }
      this.clock.check();
      if (this.clock.suspect) reject('CLOCK_SUSPECT', undefined, 503);

      const nowMs = this.now();
      const last = this.latestRecord();
      if (last) {
        const lastMs = Date.parse(last.type === 'attendance' ? last.ts : last.recordedAt);
        if (nowMs < lastMs) {
          this.clock.flag('Host clock is earlier than the last saved record. Attendance is paused until an administrator acknowledges this.', true);
          reject('CLOCK_SUSPECT', undefined, 503);
        }
      }

      const emp = this.employees.require(p.employeeId);
      if (emp.status !== 'active') reject('EMPLOYEE_INACTIVE', undefined, 403);

      const s = this.rules();
      const local = localParts(nowMs, s.timezone);
      const mine = this.mineOf(emp.id);
      const lastEv = mine[mine.length - 1];
      const open = lastEv?.kind === 'check-in' ? lastEv : undefined;
      const kind: EventKind = p.intent === 'auto' ? (open ? 'check-out' : 'check-in') : p.intent;
      const cooldownMs = Math.max(s.minIntervalSeconds, p.intent === 'auto' ? 10 : 0) * 1000;
      if (p.intent === 'auto' && lastEv && nowMs - lastEv.tsMs < cooldownMs) reject('TOO_SOON');

      const id = newId('evt', nowMs);
      let workDate: string;
      let shift: ShiftSnapshot | undefined;
      let sessionId: string;
      let cls: { classification: AttendanceEventBody['classification']; minutes?: number };
      let approval: ApprovalInfo | undefined;
      const requestedAt = new Date(nowMs).toISOString();

      if (kind === 'check-in') {
        if (open) reject('ALREADY_CHECKED_IN');
        const plan = this.planCheckIn(emp, nowMs, mine);
        if (!plan.ok) reject(plan.code, plan.message, plan.code === 'EMPLOYEE_INACTIVE' ? 403 : 409);
        if (lastEv && nowMs - lastEv.tsMs < cooldownMs) reject('TOO_SOON');
        workDate = plan.workDate;
        shift = plan.instance ? snapshotOf(plan.instance) : undefined;
        sessionId = id;
        cls = shift ? classifyShiftCheckIn(nowMs, workDate, shift, s) : classifyCheckIn(secondsOfDay(local.time), local.date, s);
        if (plan.instance && checkInBand(nowMs, plan.instance.startMs, rulesOf(plan.instance.shift)) === 'closed') {
          approval = { kind: 'late-check-in', status: 'pending', requestedAt };
        }
      } else {
        if (!open) reject('NOT_CHECKED_IN');
        if (lastEv && nowMs - lastEv.tsMs < cooldownMs) reject('TOO_SOON');
        workDate = open.workDate;
        shift = open.shift;
        sessionId = open.sessionId;
        cls = shift
          ? classifyShiftCheckOut(nowMs, shift, open.classification === 'off-day')
          : local.date === open.workDate
            ? classifyCheckOut(local.minutes, local.date, s)
            : { classification: 'normal' };
        if (shift) {
          const startMs = Date.parse(shift.startAt);
          const endMs = Date.parse(shift.endAt);
          const rules = rulesOf(shift);
          if (checkOutBand(nowMs, startMs, endMs, rules) === 'not-open') {
            reject('CHECKOUT_NOT_OPEN', `Check-out opens at ${this.hm(checkOutOpensMs(startMs, endMs, rules))}.`);
          }
          if (cls.classification === 'overtime') approval = { kind: 'overtime', status: 'pending', requestedAt };
        }
      }

      const body: AttendanceEventBody = {
        v: 1,
        id,
        type: 'attendance',
        kind,
        employeeId: emp.id,
        deviceId: p.deviceId,
        ts: new Date(nowMs).toISOString(),
        tz: s.timezone,
        localDate: local.date,
        localTime: local.time,
        classification: cls.classification,
        minutes: cls.minutes,
        verification: 'device-signature',
        challengeId: p.challengeId,
        remoteAddr: p.remoteAddr,
        workDate,
        shift,
        sessionId,
        idempotencyKey: p.idempotencyKey,
        approval,
      };

      const saved = (await this.log.append(body)) as AttendanceEvent;

      const day = this.dayFor(emp, workDate, nowMs);
      const message = this.successMessage(saved, emp, day);
      const heldCheckIn = !!approval && kind === 'check-in';
      const warning = this.warningFor(emp, monthOf(workDate));
      if (!heldCheckIn) this.emit({ type: 'attendance.saved', data: { event: saved, employeeName: emp.fullName, counts: this.overview(nowMs).counts, warning } });
      if (approval) {
        const entry = this.view().approvals.find((a) => a.eventId === saved.id);
        if (entry) this.emit({ type: 'approval.requested', data: toApprovalView(entry, emp) });
      }
      return { event: saved, employee: emp, message, day, shiftName: shift?.name, pendingApproval: heldCheckIn, warning };
    });
  }

  private replayOf(ev: AttendanceEvent): RecordResult {
    const emp = this.employees.require(ev.employeeId);
    const workDate = ev.workDate ?? ev.localDate;
    const day = this.dayFor(emp, workDate);
    return {
      event: ev,
      employee: emp,
      message: this.successMessage(ev, emp, day),
      day,
      shiftName: ev.shift?.name,
      pendingApproval: !!ev.approval && ev.kind === 'check-in',
      warning: this.warningFor(emp, monthOf(workDate)),
      duplicate: true,
    };
  }

  private hm(ms: number): string {
    return localParts(ms, this.rules().timezone).time.slice(0, 5);
  }

  private successMessage(ev: AttendanceEvent, emp: Employee, day: DayRecord): string {
    const hm = ev.localTime.slice(0, 5);
    const first = emp.fullName.split(' ')[0];
    const sh = ev.shift ? ` (${ev.shift.name})` : '';
    if (ev.kind === 'check-in') {
      if (ev.approval && ev.shift) {
        return `Check-in at ${hm}${sh} is after the check-in window closed at ${this.hm(checkInClosesMs(Date.parse(ev.shift.startAt), rulesOf(ev.shift)))}. It was sent to an administrator for approval and counts once approved.`;
      }
      if (ev.classification === 'grace') return `Checked in at ${hm}${sh} within the grace period, ${ev.minutes} min after start. Welcome, ${first}.`;
      if (ev.classification === 'late' || ev.classification === 'very-late') return `Checked in at ${hm}${sh}, late by ${ev.minutes} min. Welcome, ${first}.`;
      if (ev.classification === 'off-day') return `Checked in at ${hm}${sh} (non-working day). Welcome, ${first}.`;
      return `Checked in at ${hm}${sh}. Welcome, ${first}.`;
    }
    const sess = day.sessions.find((x) => x.sessionId === ev.sessionId);
    const wm = sess?.workedMinutes ?? 0;
    const worked = wm ? ` Worked ${Math.floor(wm / 60)}h ${String(wm % 60).padStart(2, '0')}m.` : '';
    if (ev.approval && ev.shift) {
      const endMs = Date.parse(ev.shift.endAt);
      return `Checked out at ${hm}${sh}. This is after the check-out window closed at ${this.hm(checkOutClosesMs(endMs, rulesOf(ev.shift)))}, so overtime needs administrator approval. Until then your hours count up to ${this.hm(endMs)}.${worked}`;
    }
    if (ev.classification === 'early-leave') return `Checked out at ${hm}${sh}, ${ev.minutes} min before end of shift.${worked}`;
    return `Checked out at ${hm}${sh}. See you soon, ${first}.${worked}`;
  }

  // ───────────── Read models ─────────────
  dayFor(emp: Employee, date: string, nowMs = this.now()): DayRecord {
    const view = this.view();
    const evs = view.events.filter((e) => e.employeeId === emp.id && e.workDate === date);
    return buildDayRecord(emp, date, evs, view.history.get(`${emp.id}|${date}`) ?? [], { settings: this.rules(), nowMs }, view.approvalsByDay.get(`${emp.id}|${date}`) ?? []);
  }

  statusFor(employeeId: string): AttendanceStatusView {
    const emp = this.employees.require(employeeId);
    const nowMs = this.now();
    const s = this.rules();
    const date = localParts(nowMs, s.timezone).date;
    const mine = this.mineOf(emp.id);
    const lastEv = mine[mine.length - 1];
    const open = lastEv?.kind === 'check-in' ? lastEv : undefined;
    const day = this.dayFor(emp, open ? open.workDate : date, nowMs);
    let nextAction: AttendanceStatusView['nextAction'] = 'check-in';
    if (open) nextAction = 'check-out';
    else {
      const plan = this.planCheckIn(emp, nowMs, mine);
      if (!plan.ok && ['DAY_COMPLETE', 'APPROVAL_PENDING', 'APPROVAL_REJECTED'].includes(plan.code)) nextAction = 'none';
    }
    const mineApprovals = this.view().approvals.filter((a) => a.employeeId === emp.id);
    const latest = [...mineApprovals].reverse().find((a) => a.status === 'pending' || a.workDate === day.date);
    return {
      state: open ? 'checked-in' : day.state === 'checked-in' ? 'checked-out' : day.state,
      nextAction,
      today: {
        date: day.date,
        status: day.status,
        checkInLocal: day.checkInLocal,
        checkOutLocal: day.checkOutLocal,
        workedMinutes: day.workedMinutes,
        minutesLate: day.minutesLate,
        classification: day.classification,
        earlyLeave: day.earlyLeave,
        overtimeMinutes: day.overtimeMinutes,
        overtimeStatus: day.overtimeStatus,
      },
      approval: latest
        ? { kind: latest.kind, status: latest.status, eventKind: latest.eventKind, localTime: latest.localTime, shiftName: latest.shiftName, reason: latest.reason, decidedByName: latest.decidedByName, overtimeMinutes: latest.overtimeMinutes }
        : undefined,
      shiftName: (open ?? [...mine].reverse().find((e) => e.workDate === day.date))?.shift?.name,
      lastEvent: lastEv ? { kind: lastEv.kind, ts: lastEv.ts, date: lastEv.localDate, local: lastEv.localTime } : null,
    };
  }

  today(nowMs = this.now()): DayRecord[] {
    const s = this.rules();
    const date = localParts(nowMs, s.timezone).date;
    const view = this.view();
    const rows = buildRange({ from: date, to: date, employees: this.employees.list(), view, ctx: { settings: s, nowMs } });
    const lastBy = new Map<string, EffectiveEvent>();
    for (const e of view.events) lastBy.set(e.employeeId, e);
    for (const [employeeId, ev] of lastBy) {
      if (ev.kind !== 'check-in' || ev.workDate === date) continue;
      const emp = this.employees.get(employeeId);
      if (!emp) continue;
      const rec = this.dayFor(emp, ev.workDate, nowMs);
      const idx = rows.findIndex((r) => r.employeeId === employeeId);
      if (idx < 0) rows.push(rec);
      else if (rows[idx].events.length === 0) rows[idx] = rec;
    }
    return rows;
  }

  overview(nowMs = this.now()): { date: string; counts: OverviewCounts; rows: DayRecord[] } {
    const rows = this.today(nowMs);
    return { date: localParts(nowMs, this.rules().timezone).date, counts: countsFor(rows), rows };
  }

  range(from: string, to: string, employeeId?: string, nowMs = this.now()): DayRecord[] {
    return buildRange({ from, to, employees: this.employees.list(), view: this.view(), ctx: { settings: this.rules(), nowMs }, employeeId });
  }

  history(q: { from: string; to: string; employeeId?: string; status?: string; classification?: string; shiftId?: string; q?: string; limit?: number }): { rows: DayRecord[]; truncated: boolean } {
    let rows = this.range(q.from, q.to, q.employeeId);
    if (q.status) {
      rows = rows.filter((r) => {
        switch (q.status) {
          case 'present': return !!r.checkIn;
          case 'overtime': return r.overtimeStatus !== undefined;
          case 'approval-pending': return r.approvalPending;
          case 'approval-rejected': return r.approvals.some((a) => a.status === 'rejected');
          case 'absent': return r.status === 'absent';
          case 'pending': return r.status === 'pending';
          case 'checked-in': return r.state === 'checked-in';
          case 'checked-out': return r.state === 'checked-out';
          case 'early-leave': return r.earlyLeave;
          case 'missing-checkout': return r.missingCheckOut;
          case 'corrected': return r.corrected;
          default: return true;
        }
      });
    }
    if (q.classification) {
      const want = q.classification;
      rows = rows.filter((r) => r.classification === want);
    }
    if (q.shiftId) {
      const sid = q.shiftId;
      rows = rows.filter((r) => (sid === 'none' ? r.events.length > 0 && r.shifts.length === 0 : r.shifts.some((x) => x.id === sid)));
    }
    const kw = q.q?.trim().toLowerCase();
    if (kw) {
      rows = rows.filter((r) => `${r.employeeName} ${r.employeeId} ${r.department} ${r.date} ${r.status} ${r.shifts.map((x) => x.name).join(' ')} ${r.corrections.join(' ')}`.toLowerCase().includes(kw));
    }
    rows.sort((a, b) => (a.date === b.date ? a.employeeName.localeCompare(b.employeeName) : b.date.localeCompare(a.date)));
    const limit = q.limit ?? 2000;
    return { rows: rows.slice(0, limit), truncated: rows.length > limit };
  }

  timeline(limit = 50): Array<{ id: string; ts: string; employeeId: string; employeeName: string; kind: EventKind; classification: string; local: string; date: string; source: 'device' | 'correction'; approvalStatus?: ApprovalStatus }> {
    const evs = this.view().events;
    return evs
      .slice(-limit)
      .reverse()
      .map((e) => ({
        id: e.id,
        ts: e.ts,
        employeeId: e.employeeId,
        employeeName: this.employees.get(e.employeeId)?.fullName ?? e.employeeId,
        kind: e.kind,
        classification: e.classification,
        local: e.localTime,
        date: e.localDate,
        source: e.source,
        approvalStatus: e.approval?.status,
      }));
  }

  approvals(q: { status?: ApprovalStatus; employeeId?: string; from?: string; to?: string; limit?: number } = {}): ApprovalView[] {
    const out = this.view()
      .approvals.filter((a) => (!q.status || a.status === q.status) && (!q.employeeId || a.employeeId === q.employeeId) && (!q.from || a.workDate >= q.from) && (!q.to || a.workDate <= q.to))
      .map((a) => toApprovalView(a, this.employees.get(a.employeeId)))
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    return out.slice(0, q.limit ?? 500);
  }

  pendingApprovalCount(): number {
    return this.view().approvals.filter((a) => a.status === 'pending').length;
  }

  rawEvents(): readonly LogEvent[] {
    return this.log.records as LogEvent[];
  }

  effective(): EffectiveEvent[] {
    return this.view().events;
  }

  // ───────────── Administrator approvals (append-only decisions; the scan itself is never rewritten) ─────────────
  async decide(input: unknown, admin: { id: string; username: string; displayName: string }): Promise<ApprovalView> {
    const parsed = decisionSchema.safeParse(input);
    if (!parsed.success) throw new PulseError('VALIDATION', formatZodError(parsed.error));
    const d = parsed.data;

    return this.mutex.run(async () => {
      const nowMs = this.now();
      const entry = this.view().approvals.find((a) => a.eventId === d.eventId);
      if (!entry) reject('NOT_FOUND', 'That approval request does not exist.', 404);
      if (entry.status !== 'pending') reject('ALREADY_DECIDED', `This request was already ${entry.status === 'voided' ? 'voided by a correction' : entry.status}.`);
      const approve = d.decision === 'approve';
      let overtimeMinutes: number | undefined;
      if (approve && entry.kind === 'overtime' && entry.shiftEndAt) {
        overtimeMinutes = Math.max(0, Math.floor((Date.parse(entry.ts) - Date.parse(entry.shiftEndAt)) / 60000));
      }
      const body: ApprovalEventBody = {
        v: 1,
        id: newId('apv', nowMs),
        type: 'approval',
        targetEventId: entry.eventId,
        employeeId: entry.employeeId,
        kind: entry.kind,
        decision: approve ? 'approved' : 'rejected',
        reason: d.reason,
        adminId: admin.id,
        adminName: admin.displayName || admin.username,
        recordedAt: new Date(nowMs).toISOString(),
        overtimeMinutes,
      };
      await this.log.append(body);
      const emp = this.employees.get(entry.employeeId);
      const label = entry.kind === 'overtime' ? 'Overtime check-out' : 'Late check-in';
      await this.audit.record({
        type: approve ? 'approval.approved' : 'approval.rejected',
        severity: approve ? 'notice' : 'warning',
        actor: admin.username,
        summary: `${label} for ${emp?.fullName ?? entry.employeeId} (${entry.employeeId}) on ${entry.workDate} ${approve ? 'approved' : 'rejected'} — ${d.reason}`,
        details: { employeeId: entry.employeeId, eventId: entry.eventId, kind: entry.kind, decision: body.decision, overtimeMinutes, date: entry.workDate },
      });
      const updated = this.view().approvals.find((a) => a.eventId === entry.eventId)!;
      const viewOut = toApprovalView(updated, emp);
      this.emit({ type: 'approval.decided', data: viewOut });
      return viewOut;
    });
  }

  // ───────────── Manual corrections (new, attributable records; history is never rewritten) ─────────────
  async correct(input: unknown, admin: { id: string; username: string; displayName: string }): Promise<CorrectionEvent> {
    const parsed = correctionSchema.safeParse(input);
    if (!parsed.success) throw new PulseError('VALIDATION', formatZodError(parsed.error));
    const c = parsed.data;

    return this.mutex.run(async () => {
      const nowMs = this.now();
      const s = this.rules();
      const view = this.view();
      const base = { v: 1 as const, id: newId('cor', nowMs), type: 'correction' as const, tz: s.timezone, reason: c.reason, adminId: admin.id, adminName: admin.displayName || admin.username, recordedAt: new Date(nowMs).toISOString() };

      const violations = (events: EffectiveEvent[]) => {
        let n = 0;
        let isOpen = false;
        for (const e of [...events].sort((x, y) => x.tsMs - y.tsMs)) {
          if (e.kind === 'check-in') {
            if (isOpen) n++;
            isOpen = true;
          } else {
            if (!isOpen) n++;
            isOpen = false;
          }
        }
        return n;
      };
      const checkSequence = (before: EffectiveEvent[], after: EffectiveEvent[]) => {
        if (violations(after) > violations(before)) reject('INVALID_CORRECTION', 'That change would leave an invalid sequence (check-in and check-out must alternate, starting with check-in, with only one open session).', 422);
      };
      const futureGuard = (ms: number) => {
        if (ms > nowMs + 60_000) reject('INVALID_CORRECTION', 'Corrections cannot be dated in the future.', 422);
      };
      const shiftFor = (ms: number, required: boolean): { workDate: string; snap?: ShiftSnapshot } => {
        const lp = localParts(ms, s.timezone);
        const active = this.shifts();
        if (!active.length) return { workDate: lp.date };
        const det = detectShift(ms, s.timezone, active);
        if (det.kind === 'ambiguous') reject('INVALID_CORRECTION', 'That time matches more than one shift, so the shift cannot be determined.', 422);
        if (det.kind === 'none') {
          if (required) reject('INVALID_CORRECTION', 'No active shift covers that check-in time.', 422);
          return { workDate: lp.date };
        }
        return { workDate: det.instance.date, snap: snapshotOf(det.instance) };
      };
      const resolve = (stream: EffectiveEvent[], id: string): EffectiveEvent => {
        const copy = stream.map((e) => ({ ...e })).sort((x, y) => x.tsMs - y.tsMs);
        assignSessions(copy);
        return copy.find((e) => e.id === id)!;
      };
      const legacyOut = (h: EffectiveEvent, lp: ReturnType<typeof localParts>) =>
        h.shift ? { classification: h.classification, minutes: h.minutes } : h.workDate === lp.date ? classifyCheckOut(lp.minutes, lp.date, s) : { classification: 'normal' as const, minutes: undefined };

      let body: CorrectionEventBody;
      let employeeId: string;
      let affectedDate: string;

      if (c.op === 'add') {
        const emp = this.employees.require(c.employeeId);
        employeeId = emp.id;
        const ms = localToUtcMs(c.date, `${c.time}:00`, s.timezone);
        futureGuard(ms);
        const lp = localParts(ms, s.timezone);
        const current = view.events.filter((e) => e.employeeId === employeeId);
        const det = c.kind === 'check-in' ? shiftFor(ms, true) : { workDate: lp.date, snap: undefined as ShiftSnapshot | undefined };
        const cls0 = c.kind === 'check-in' ? (det.snap ? classifyShiftCheckIn(ms, det.workDate, det.snap, s) : classifyCheckIn(secondsOfDay(lp.time), lp.date, s)) : { classification: 'normal' as const, minutes: undefined };
        const hypothetical: EffectiveEvent = { id: base.id, employeeId, kind: c.kind, ts: new Date(ms).toISOString(), tsMs: ms, localDate: lp.date, localTime: lp.time, classification: cls0.classification, minutes: cls0.minutes, source: 'correction', workDate: det.workDate, shift: det.snap, sessionId: base.id };
        const stream = [...current, hypothetical];
        checkSequence(current, stream);
        const h = resolve(stream, base.id);
        const cls = c.kind === 'check-in' ? cls0 : legacyOut(h, lp);
        affectedDate = h.workDate;
        body = { ...base, op: 'add', employeeId, kind: c.kind, ts: hypothetical.ts, localDate: lp.date, localTime: lp.time, classification: cls.classification, minutes: cls.minutes, workDate: h.workDate, shift: h.shift };
      } else {
        const target = view.events.find((e) => e.id === c.eventId);
        if (!target) reject('NOT_FOUND', 'That attendance event does not exist or was already voided.', 404);
        employeeId = target.employeeId;
        affectedDate = target.workDate;
        const current = view.events.filter((e) => e.employeeId === employeeId);
        if (c.op === 'void') {
          checkSequence(current, current.filter((e) => e.id !== target.id));
          body = { ...base, op: 'void', employeeId, targetEventId: target.id };
        } else {
          const ms = localToUtcMs(c.date, `${c.time}:00`, s.timezone);
          futureGuard(ms);
          const lp = localParts(ms, s.timezone);
          const det = target.kind === 'check-in' ? shiftFor(ms, !!target.shift) : { workDate: target.workDate, snap: target.shift };
          const cls0 = target.kind === 'check-in' ? (det.snap ? classifyShiftCheckIn(ms, det.workDate, det.snap, s) : classifyCheckIn(secondsOfDay(lp.time), lp.date, s)) : { classification: target.classification, minutes: target.minutes };
          const moved: EffectiveEvent = { ...target, ts: new Date(ms).toISOString(), tsMs: ms, localDate: lp.date, localTime: lp.time, classification: cls0.classification, minutes: cls0.minutes, workDate: det.workDate, shift: det.snap };
          const stream = [...current.filter((e) => e.id !== target.id), moved];
          checkSequence(current, stream);
          const h = resolve(stream, target.id);
          const cls = target.kind === 'check-in' ? cls0 : legacyOut(h, lp);
          affectedDate = h.workDate;
          body = { ...base, op: 'amend', employeeId, targetEventId: target.id, ts: moved.ts, localDate: lp.date, localTime: lp.time, classification: cls.classification, minutes: cls.minutes, ...(target.kind === 'check-in' ? { workDate: det.workDate, shift: det.snap } : {}) };
        }
      }

      const saved = (await this.log.append(body)) as CorrectionEvent;
      await this.audit.record({
        type: `correction.${c.op}`,
        severity: 'notice',
        actor: admin.username,
        summary: `Correction (${c.op}) for ${employeeId} on ${affectedDate} — ${c.reason}`,
        details: { employeeId, correctionId: saved.id, targetEventId: body.targetEventId, date: affectedDate },
      });
      this.emit({ type: 'correction.saved', data: { employeeId, date: affectedDate } });
      return saved;
    });
  }

  /** Maps an unexpected storage failure to a safe, honest error for phones. */
  static asPhoneError(e: unknown): PulseError {
    if (e instanceof PulseError) {
      if (e.code === 'STORAGE_FULL') return new PulseError('STORAGE_FULL', ERROR_MESSAGES.STORAGE_FULL, 507);
      if (e.code.startsWith('STORAGE_')) return new PulseError('STORAGE_ERROR', ERROR_MESSAGES.STORAGE_ERROR, 500);
      return e;
    }
    return new PulseError('INTERNAL', ERROR_MESSAGES.INTERNAL, 500);
  }
}

export { indexByEmployeeDay };
