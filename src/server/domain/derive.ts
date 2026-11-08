import { MONTHLY_GRACE_LIMIT, MONTHLY_LATE_LIMIT, arrivalClass, type ArrivalClass, arrivalOf, checkOutBand, minutesAfter, minutesAfterCeil, rulesOf } from '../../shared/shiftRules';
import type {
  ApprovalInfo,
  ApprovalStatus,
  ApprovalView,
  ArrivalClassification,
  ArrivalStatus,
  Classification,
  DayRecord,
  Employee,
  EventKind,
  LogEvent,
  MonthlyCounts,
  MonthlyReport,
  OverviewCounts,
  PresenceState,
  Settings,
  SessionView,
  ShiftSnapshot,
} from '../../shared/types';
import { eachDate, localParts, parseHHmm, weekdayOf } from '../time';

export type RulesSettings = Pick<Settings, 'timezone' | 'workStart' | 'workEnd' | 'graceMinutes' | 'workDays' | 'allowOffDayAttendance'>;

export function isWorkDay(date: string, s: Pick<Settings, 'workDays'>): boolean {
  return s.workDays.includes(weekdayOf(date));
}

export function classifyCheckIn(localSeconds: number, date: string, s: RulesSettings): { classification: Classification; minutes?: number } {
  if (!isWorkDay(date, s)) return { classification: 'off-day' };
  const startSeconds = parseHHmm(s.workStart) * 60;
  const cls = arrivalClass(localSeconds * 1000, startSeconds * 1000, s.graceMinutes);
  if (cls === 'on-time') return { classification: 'on-time' };
  return { classification: cls, minutes: minutesAfterCeil(localSeconds * 1000, startSeconds * 1000) };
}

export function secondsOfDay(time: string): number {
  const [h, m, sec] = time.split(':').map(Number);
  return h * 3600 + m * 60 + (sec || 0);
}

export function classifyCheckOut(localMinutes: number, date: string, s: RulesSettings): { classification: Classification; minutes?: number } {
  if (!isWorkDay(date, s)) return { classification: 'off-day' };
  const end = parseHHmm(s.workEnd);
  if (localMinutes < end) return { classification: 'early-leave', minutes: end - localMinutes };
  return { classification: 'normal' };
}

export interface EffectiveEvent {
  id: string;
  employeeId: string;
  kind: EventKind;
  ts: string;
  tsMs: number;
  localDate: string;
  localTime: string;
  classification: Classification;
  minutes?: number;
  deviceId?: string;
  remoteAddr?: string;
  challengeId?: string;
  source: 'device' | 'correction';
  workDate: string;
  shift?: ShiftSnapshot;
  sessionId: string;
  approval?: ApprovalInfo;
}

export function classifyShiftCheckIn(tMs: number, workDate: string, snap: ShiftSnapshot, s: Pick<Settings, 'workDays'>): { classification: Classification; minutes?: number } {
  if (!isWorkDay(workDate, s)) return { classification: 'off-day' };
  const startMs = Date.parse(snap.startAt);
  const cls = arrivalClass(tMs, startMs, rulesOf(snap).graceMinutes);
  if (cls === 'on-time') return { classification: 'on-time' };
  return { classification: cls, minutes: minutesAfterCeil(tMs, startMs) };
}

export function classifyShiftCheckOut(tMs: number, snap: ShiftSnapshot, offDay: boolean): { classification: Classification; minutes?: number } {
  if (offDay) return { classification: 'off-day' };
  const startMs = Date.parse(snap.startAt);
  const endMs = Date.parse(snap.endAt);
  if (tMs < endMs) return { classification: 'early-leave', minutes: Math.ceil((endMs - tMs) / 60000) };
  if (checkOutBand(tMs, startMs, endMs, rulesOf(snap)) === 'overtime') return { classification: 'overtime', minutes: minutesAfter(tMs, endMs) };
  return { classification: 'normal' };
}

export function assignSessions(sorted: EffectiveEvent[]): void {
  const open = new Map<string, EffectiveEvent>();
  for (const e of sorted) {
    if (e.kind === 'check-in') {
      e.sessionId = e.id;
      open.set(e.employeeId, e);
      continue;
    }
    const s = open.get(e.employeeId);
    if (!s) {
      e.sessionId = e.id;
      continue;
    }
    e.sessionId = s.sessionId;
    e.workDate = s.workDate;
    e.shift = s.shift;
    if (s.shift) {
      const c = classifyShiftCheckOut(e.tsMs, s.shift, s.classification === 'off-day');
      e.classification = c.classification;
      e.minutes = c.minutes;
    }
    open.delete(e.employeeId);
  }
}

export type ApprovalEntry = Omit<ApprovalView, 'employeeName' | 'department'>;

export function toApprovalView(entry: ApprovalEntry, emp: Pick<Employee, 'fullName' | 'department'> | undefined): ApprovalView {
  return { ...entry, employeeName: emp?.fullName ?? entry.employeeId, department: emp?.department ?? '' };
}

export interface EffectiveView {
  events: EffectiveEvent[];
  /** correction history lines keyed by `${employeeId}|${date}` */
  history: Map<string, string[]>;
  approvals: ApprovalEntry[];
  /** approval entries keyed by `${employeeId}|${workDate}` */
  approvalsByDay: Map<string, ApprovalEntry[]>;
}

function approvalEntry(ev: EffectiveEvent, info: ApprovalInfo, deviceId?: string, remoteAddr?: string): ApprovalEntry {
  return {
    eventId: ev.id,
    kind: info.kind,
    status: info.status,
    eventKind: ev.kind,
    employeeId: ev.employeeId,
    ts: ev.ts,
    localDate: ev.localDate,
    localTime: ev.localTime,
    workDate: ev.workDate,
    shiftId: ev.shift?.id,
    shiftName: ev.shift?.name,
    shiftStart: ev.shift?.start,
    shiftEnd: ev.shift?.end,
    shiftStartAt: ev.shift?.startAt,
    shiftEndAt: ev.shift?.endAt,
    minutes: approvalMinutes(ev, info.kind),
    requestedAt: info.requestedAt,
    deviceId,
    remoteAddr,
  };
}

function approvalMinutes(ev: EffectiveEvent, kind: ApprovalInfo['kind']): number {
  if (!ev.shift) return 0;
  return Math.max(0, minutesAfter(ev.tsMs, Date.parse(kind === 'overtime' ? ev.shift.endAt : ev.shift.startAt)));
}

/**
 * Folds the append-only log into the set of attendance events that currently count.
 * Corrections and approval decisions never edit earlier records; they are applied here, in log order.
 * A check-in that needs approval only counts once an administrator approves it.
 */
export function foldLog(log: readonly LogEvent[], timezone: string): EffectiveView {
  const byId = new Map<string, EffectiveEvent>();
  const held = new Map<string, EffectiveEvent>();
  const approvals = new Map<string, ApprovalEntry>();
  const pending: Array<{ employeeId: string; eventId: string; fallbackDate: string; extraDate?: string; line: string }> = [];

  for (const e of log) {
    if (e.type === 'attendance') {
      const eff: EffectiveEvent = {
        id: e.id,
        employeeId: e.employeeId,
        kind: e.kind,
        ts: e.ts,
        tsMs: Date.parse(e.ts),
        localDate: e.localDate,
        localTime: e.localTime,
        classification: e.classification,
        minutes: e.minutes,
        deviceId: e.deviceId,
        remoteAddr: e.remoteAddr,
        challengeId: e.challengeId,
        source: 'device',
        workDate: e.workDate ?? e.localDate,
        shift: e.shift,
        sessionId: e.sessionId ?? e.id,
        approval: e.approval ? { ...e.approval } : undefined,
      };
      if (e.approval) approvals.set(e.id, approvalEntry(eff, e.approval, e.deviceId, e.remoteAddr));
      if (e.approval && e.kind === 'check-in' && e.approval.status !== 'approved') held.set(e.id, eff);
      else byId.set(e.id, eff);
      continue;
    }
    if (e.type === 'approval') {
      const entry = approvals.get(e.targetEventId);
      if (!entry || entry.status !== 'pending') continue;
      entry.status = e.decision;
      entry.decidedAt = e.recordedAt;
      entry.decidedBy = e.adminId;
      entry.decidedByName = e.adminName;
      entry.reason = e.reason;
      entry.overtimeMinutes = e.overtimeMinutes;
      const target = byId.get(e.targetEventId) ?? held.get(e.targetEventId);
      if (target) {
        target.approval = {
          kind: entry.kind,
          status: e.decision,
          requestedAt: entry.requestedAt,
          decidedAt: e.recordedAt,
          decidedBy: e.adminId,
          decidedByName: e.adminName,
          reason: e.reason,
          overtimeMinutes: e.overtimeMinutes,
        };
        if (held.has(target.id) && e.decision === 'approved') {
          byId.set(target.id, target);
          held.delete(target.id);
        }
      }
      continue;
    }
    const stamp = `${localParts(Date.parse(e.recordedAt), timezone).date} ${localParts(Date.parse(e.recordedAt), timezone).time.slice(0, 5)}`;
    const who = e.adminName || e.adminId;
    if (e.op === 'add' && e.kind && e.ts && e.localDate && e.localTime) {
      byId.set(e.id, {
        id: e.id,
        employeeId: e.employeeId,
        kind: e.kind,
        ts: e.ts,
        tsMs: Date.parse(e.ts),
        localDate: e.localDate,
        localTime: e.localTime,
        classification: e.classification ?? 'normal',
        minutes: e.minutes,
        source: 'correction',
        workDate: e.workDate ?? e.localDate,
        shift: e.shift,
        sessionId: e.id,
      });
      pending.push({ employeeId: e.employeeId, eventId: e.id, fallbackDate: e.localDate, line: `[${stamp}] ${who} added ${e.kind} at ${e.localTime.slice(0, 5)} — ${e.reason}` });
    } else if (e.op === 'void' && e.targetEventId) {
      const t = byId.get(e.targetEventId);
      if (t) {
        byId.delete(e.targetEventId);
        const entry = approvals.get(t.id);
        if (entry && entry.status === 'pending') entry.status = 'voided';
        pending.push({ employeeId: t.employeeId, eventId: t.id, fallbackDate: t.workDate, line: `[${stamp}] ${who} voided ${t.kind} at ${t.localTime.slice(0, 5)} — ${e.reason}` });
      }
    } else if (e.op === 'amend' && e.targetEventId && e.ts && e.localDate && e.localTime) {
      const t = byId.get(e.targetEventId);
      if (t) {
        const old = `${t.localDate} ${t.localTime.slice(0, 5)}`;
        const oldWorkDate = t.workDate;
        t.ts = e.ts;
        t.tsMs = Date.parse(e.ts);
        t.localDate = e.localDate;
        t.localTime = e.localTime;
        t.classification = e.classification ?? t.classification;
        t.minutes = e.minutes;
        if (t.kind === 'check-in') {
          t.workDate = e.workDate ?? e.localDate;
          t.shift = e.shift;
        }
        pending.push({
          employeeId: t.employeeId,
          eventId: t.id,
          fallbackDate: e.localDate,
          extraDate: oldWorkDate,
          line: `[${stamp}] ${who} changed ${t.kind} from ${old} to ${e.localDate} ${e.localTime.slice(0, 5)} — ${e.reason}`,
        });
        t.source = t.source === 'device' ? 'device' : 'correction';
        (t as EffectiveEvent & { amended?: boolean }).amended = true;
      }
    }
  }

  const events = [...byId.values()].sort((a, b) => a.tsMs - b.tsMs);
  assignSessions(events);

  const approvalList = [...approvals.values()];
  const approvalsByDay = new Map<string, ApprovalEntry[]>();
  for (const a of approvalList) {
    const live = byId.get(a.eventId) ?? held.get(a.eventId);
    if (live) {
      a.ts = live.ts;
      a.localDate = live.localDate;
      a.localTime = live.localTime;
      a.workDate = live.workDate;
      a.shiftId = live.shift?.id;
      a.shiftName = live.shift?.name;
      a.shiftStart = live.shift?.start;
      a.shiftEnd = live.shift?.end;
      a.shiftStartAt = live.shift?.startAt;
      a.shiftEndAt = live.shift?.endAt;
      a.minutes = approvalMinutes(live, a.kind);
    }
    const k = `${a.employeeId}|${a.workDate}`;
    const arr = approvalsByDay.get(k) ?? [];
    arr.push(a);
    approvalsByDay.set(k, arr);
  }

  const history = new Map<string, string[]>();
  const note = (employeeId: string, date: string, line: string) => {
    const k = `${employeeId}|${date}`;
    const arr = history.get(k) ?? [];
    if (!arr.includes(line)) arr.push(line);
    history.set(k, arr);
  };
  for (const p of pending) {
    const live = byId.get(p.eventId);
    const date = live ? live.workDate : p.fallbackDate;
    note(p.employeeId, date, p.line);
    if (p.extraDate && p.extraDate !== date) note(p.employeeId, p.extraDate, p.line);
  }
  return { events, history, approvals: approvalList, approvalsByDay };
}

export interface DeriveContext {
  settings: RulesSettings;
  nowMs: number;
}

export function employeeActiveOn(emp: Employee, date: string, tz: string): boolean {
  if (date < localParts(Date.parse(emp.createdAt), tz).date) return false;
  if (emp.deactivatedAt && date > localParts(Date.parse(emp.deactivatedAt), tz).date) return false;
  return true;
}

function countedOutMs(inEv: EffectiveEvent, outEv: EffectiveEvent): number {
  const a = outEv.approval;
  if (outEv.classification === 'overtime' && a && a.status !== 'approved' && outEv.shift) {
    return Math.max(inEv.tsMs, Math.min(outEv.tsMs, Date.parse(outEv.shift.endAt)));
  }
  return outEv.tsMs;
}

function overtimeOf(outEv: EffectiveEvent): number {
  if (outEv.classification !== 'overtime' || !outEv.shift) return 0;
  if (outEv.approval && outEv.approval.status !== 'approved') return 0;
  return Math.max(0, minutesAfter(outEv.tsMs, Date.parse(outEv.shift.endAt)));
}

function overtimeStatusOf(outEv: EffectiveEvent): ApprovalStatus | undefined {
  if (outEv.classification !== 'overtime') return undefined;
  return outEv.approval ? outEv.approval.status : 'approved';
}

export function buildDayRecord(emp: Employee, date: string, dayEvents: EffectiveEvent[], history: string[], ctx: DeriveContext, dayApprovals: ApprovalEntry[] = []): DayRecord {
  const { settings, nowMs } = ctx;
  const now = localParts(nowMs, settings.timezone);
  const events = [...dayEvents].sort((a, b) => a.tsMs - b.tsMs);

  const sessions: Array<{ in: EffectiveEvent; out?: EffectiveEvent }> = [];
  let open: { in: EffectiveEvent; out?: EffectiveEvent } | null = null;
  for (const e of events) {
    if (e.kind === 'check-in') {
      open = { in: e };
      sessions.push(open);
    } else if (open) {
      open.out = e;
      open = null;
    }
  }

  const firstIn = sessions[0]?.in;
  const closed = sessions.filter((s) => s.out);
  const lastOut = closed.length ? closed[closed.length - 1].out! : undefined;
  const state: PresenceState = open ? 'checked-in' : lastOut ? 'checked-out' : 'not-arrived';
  const workedMinutes = Math.round(closed.reduce((sum, s) => sum + (countedOutMs(s.in, s.out!) - s.in.tsMs) / 60000, 0));
  const workDay = isWorkDay(date, settings);
  const approvalViews = dayApprovals.map((a) => toApprovalView(a, emp));
  const checkInPending = dayApprovals.some((a) => a.status === 'pending' && a.eventKind === 'check-in');
  const approvalPending = dayApprovals.some((a) => a.status === 'pending');
  const firstArrival = firstIn ? arrivalOf(firstIn.classification) : null;
  const classification: ArrivalClassification | undefined = firstIn ? (firstIn.classification === 'off-day' ? 'off-day' : firstArrival ?? undefined) : undefined;

  let status: ArrivalStatus;
  if (!workDay) status = 'off-day';
  else if (firstIn) status = classification === 'late' ? 'late' : 'present';
  else if (checkInPending) status = 'pending';
  else if (date > now.date) status = 'pending';
  else if (date === now.date) status = now.minutes <= parseHHmm(settings.workEnd) ? 'pending' : 'absent';
  else status = 'absent';

  const sessionViews: SessionView[] = sessions.map((x) => {
    const isOpen = !x.out;
    const endAt = x.in.shift?.endAt;
    const overdue = isOpen && (endAt ? nowMs >= Date.parse(endAt) : date < now.date);
    return {
      sessionId: x.in.id,
      shiftId: x.in.shift?.id,
      shiftName: x.in.shift?.name,
      checkIn: x.in.ts,
      checkInLocal: x.in.localTime,
      checkInDate: x.in.localDate,
      classification: x.in.classification,
      minutes: x.in.minutes,
      checkOut: x.out?.ts,
      checkOutLocal: x.out?.localTime,
      checkOutDate: x.out?.localDate,
      open: isOpen,
      missingCheckOut: overdue,
      workedMinutes: x.out ? Math.round((countedOutMs(x.in, x.out) - x.in.tsMs) / 60000) : 0,
      shiftEndAt: endAt,
      overtimeMinutes: x.out ? overtimeOf(x.out) : 0,
      overtimeStatus: x.out ? overtimeStatusOf(x.out) : undefined,
    };
  });
  const overtimeMinutes = sessionViews.reduce((n, v) => n + v.overtimeMinutes, 0);
  const otStatuses = sessionViews.map((v) => v.overtimeStatus).filter((v): v is ApprovalStatus => !!v);
  const overtimeStatus: ApprovalStatus | undefined = otStatuses.includes('pending') ? 'pending' : otStatuses.includes('rejected') ? 'rejected' : otStatuses.includes('approved') ? 'approved' : undefined;
  const shiftList: Array<{ id: string; name: string }> = [];
  for (const x of sessions) if (x.in.shift && !shiftList.some((h) => h.id === x.in.shift!.id)) shiftList.push({ id: x.in.shift.id, name: x.in.shift.name });
  const hasDevice = events.some((e) => e.source === 'device');
  const hasCorrection = events.some((e) => e.source === 'correction' || (e as EffectiveEvent & { amended?: boolean }).amended) || history.length > 0;

  return {
    employeeId: emp.id,
    employeeName: emp.fullName,
    phone: emp.phone,
    department: emp.department,
    date,
    status,
    state,
    checkIn: firstIn?.ts,
    checkInLocal: firstIn?.localTime,
    checkOut: lastOut?.ts,
    checkOutLocal: lastOut?.localTime,
    workedMinutes,
    minutesLate: classification === 'grace' || classification === 'late' ? firstIn?.minutes : undefined,
    classification,
    earlyLeave: lastOut?.classification === 'early-leave',
    minutesEarly: lastOut?.classification === 'early-leave' ? lastOut.minutes : undefined,
    overtimeMinutes,
    overtimeStatus,
    approvalPending,
    approvals: approvalViews,
    missingCheckOut: !!open && sessionViews[sessionViews.length - 1].missingCheckOut,
    shiftId: firstIn?.shift?.id,
    shiftName: firstIn?.shift?.name,
    shifts: shiftList,
    sessions: sessionViews,
    corrected: hasCorrection,
    verification: events.length === 0 ? 'none' : hasDevice ? 'device-signature' : 'manual-correction',
    deviceId: firstIn?.deviceId,
    checkInEventId: firstIn?.id,
    checkOutEventId: lastOut?.id,
    corrections: history,
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      ts: e.ts,
      date: e.localDate,
      local: e.localTime,
      shiftName: e.shift?.name,
      classification: e.classification,
      minutes: e.minutes,
      source: e.source,
      deviceId: e.deviceId,
      remoteAddr: e.remoteAddr,
      sessionId: e.sessionId,
      approval: e.approval,
    })),
  };
}

/** Index of effective events by `${employeeId}|${date}`. */
export function indexByEmployeeDay(events: EffectiveEvent[]): Map<string, EffectiveEvent[]> {
  const m = new Map<string, EffectiveEvent[]>();
  for (const e of events) {
    const k = `${e.employeeId}|${e.workDate}`;
    const arr = m.get(k);
    if (arr) arr.push(e);
    else m.set(k, [e]);
  }
  return m;
}

export interface RangeQuery {
  from: string;
  to: string;
  employees: Employee[];
  view: EffectiveView;
  ctx: DeriveContext;
  employeeId?: string;
}

/**
 * Builds one DayRecord per employee/day: every day that has events, plus expected-but-missing work days
 * (reported as absent / pending) for employees who were active on that date.
 */
export function buildRange(q: RangeQuery): DayRecord[] {
  const idx = indexByEmployeeDay(q.view.events);
  const tz = q.ctx.settings.timezone;
  const today = localParts(q.ctx.nowMs, tz).date;
  const rows: DayRecord[] = [];
  const dates = eachDate(q.from, q.to);
  const emps = q.employeeId ? q.employees.filter((e) => e.id === q.employeeId) : q.employees;
  for (const date of dates) {
    for (const emp of emps) {
      const key = `${emp.id}|${date}`;
      const evs = idx.get(key) ?? [];
      const aps = q.view.approvalsByDay.get(key) ?? [];
      const expectedAbsence = isWorkDay(date, q.ctx.settings) && employeeActiveOn(emp, date, tz) && date <= today;
      const todayRoster = date === today && emp.status === 'active';
      if (!evs.length && !aps.length && !expectedAbsence && !todayRoster) continue;
      rows.push(buildDayRecord(emp, date, evs, q.view.history.get(key) ?? [], q.ctx, aps));
    }
  }
  return rows;
}

export function countsFor(rows: DayRecord[]): OverviewCounts {
  const c: OverviewCounts = { total: rows.length, present: 0, onTime: 0, grace: 0, late: 0, absent: 0, pending: 0, checkedIn: 0, checkedOut: 0, offDay: 0, awaitingApproval: 0 };
  for (const r of rows) {
    if (r.checkIn) c.present++;
    if (r.classification === 'on-time') c.onTime++;
    if (r.classification === 'grace') c.grace++;
    if (r.classification === 'late') c.late++;
    if (r.status === 'absent') c.absent++;
    if (r.status === 'pending') c.pending++;
    if (r.status === 'off-day' && !r.checkIn) c.offDay++;
    if (r.state === 'checked-in') c.checkedIn++;
    if (r.state === 'checked-out') c.checkedOut++;
    if (r.approvalPending) c.awaitingApproval++;
  }
  return c;
}

export type MonthTally = Map<string, ArrivalClass>;

export function monthOf(workDate: string): string {
  return workDate.slice(0, 7);
}

export function tallyMonths(events: readonly EffectiveEvent[]): Map<string, MonthTally> {
  const out = new Map<string, MonthTally>();
  const ordered = [...events].sort((x, y) => x.tsMs - y.tsMs);
  for (const e of ordered) {
    if (e.kind !== 'check-in') continue;
    const cls = arrivalOf(e.classification);
    if (!cls) continue;
    const key = `${e.employeeId}|${monthOf(e.workDate)}`;
    let t = out.get(key);
    if (!t) {
      t = new Map();
      out.set(key, t);
    }
    const attendanceKey = `${e.workDate}|${e.shift?.id ?? ''}`;
    if (!t.has(attendanceKey)) t.set(attendanceKey, cls);
  }
  return out;
}

export function monthlyRow(emp: Pick<Employee, 'id' | 'fullName' | 'department'>, month: string, t: MonthTally | undefined): MonthlyCounts {
  let onTime = 0;
  let grace = 0;
  let late = 0;
  if (t) for (const cls of t.values()) cls === 'on-time' ? onTime++ : cls === 'grace' ? grace++ : late++;
  return {
    month,
    employeeId: emp.id,
    employeeName: emp.fullName,
    department: emp.department,
    onTime,
    grace,
    late,
    graceExceeded: grace > MONTHLY_GRACE_LIMIT,
    lateExceeded: late > MONTHLY_LATE_LIMIT,
  };
}

export function buildMonthlyReport(month: string, employees: readonly Employee[], tally: Map<string, MonthTally>): MonthlyReport {
  const rows = employees
    .map((e) => monthlyRow(e, month, tally.get(`${e.id}|${month}`)))
    .filter((r) => r.onTime + r.grace + r.late > 0)
    .sort((a, b) => b.late - a.late || b.grace - a.grace || a.employeeName.localeCompare(b.employeeName));
  return { month, graceLimit: MONTHLY_GRACE_LIMIT, lateLimit: MONTHLY_LATE_LIMIT, rows, exceeding: rows.filter((r) => r.graceExceeded || r.lateExceeded) };
}
