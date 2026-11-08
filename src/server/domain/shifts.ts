import { z } from 'zod';
import { DEFAULT_SHIFT_RULES } from '../../shared/shiftRules';
import type { LiveEvent, Shift, ShiftSnapshot } from '../../shared/types';
import { PulseError } from '../errors';
import { newId } from '../ids';
import { formatZodError, type ShiftsFile } from '../schemas';
import type { JsonStore } from '../storage/jsonStore';
import { addDays, localParts, localToUtcMs, parseHHmm } from '../time';
import type { AuditService } from './audit';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const shiftFields = {
  name: z.string().trim().min(1, 'Shift name is required').max(60),
  start: z.string().regex(HHMM, 'Start must be HH:mm'),
  end: z.string().regex(HHMM, 'End must be HH:mm'),
  graceMinutes: z.number().int().min(0).max(240),
  checkInCloseMinutes: z.number().int().min(0).max(720),
  earlyCheckInMinutes: z.number().int().min(0).max(720),
  checkOutOpenMinutes: z.number().int().min(0).max(720),
  checkOutCloseMinutes: z.number().int().min(0).max(720),
};

const createSchema = z.object({
  ...shiftFields,
  checkInCloseMinutes: shiftFields.checkInCloseMinutes.default(DEFAULT_SHIFT_RULES.checkInCloseMinutes),
  checkOutOpenMinutes: shiftFields.checkOutOpenMinutes.default(DEFAULT_SHIFT_RULES.checkOutOpenMinutes),
  checkOutCloseMinutes: shiftFields.checkOutCloseMinutes.default(DEFAULT_SHIFT_RULES.checkOutCloseMinutes),
  active: z.boolean().default(true),
});
const archiveSchema = z.object({ id: z.string().min(3).max(80), reason: z.string().trim().min(3, 'A reason is required to archive a shift').max(200) });
const updateSchema = z.object({ id: z.string().min(3).max(80), patch: z.object(shiftFields).partial().strict() });

export function shiftDurationMinutes(start: string, end: string): number {
  const s = parseHHmm(start);
  const e = parseHHmm(end);
  return e > s ? e - s : e + 1440 - s;
}

export function isOvernight(start: string, end: string): boolean {
  return parseHHmm(end) <= parseHHmm(start);
}

export interface ShiftInstance {
  shift: Shift;
  date: string;
  startMs: number;
  endMs: number;
  opensMs: number;
}

export function shiftInstance(shift: Shift, date: string, tz: string): ShiftInstance {
  const startMs = localToUtcMs(date, `${shift.start}:00`, tz);
  const endDate = isOvernight(shift.start, shift.end) ? addDays(date, 1) : date;
  const endMs = localToUtcMs(endDate, `${shift.end}:00`, tz);
  return { shift, date, startMs, endMs, opensMs: startMs - shift.earlyCheckInMinutes * 60_000 };
}

export function snapshotOf(inst: ShiftInstance): ShiftSnapshot {
  return {
    id: inst.shift.id,
    name: inst.shift.name,
    start: inst.shift.start,
    end: inst.shift.end,
    startAt: new Date(inst.startMs).toISOString(),
    endAt: new Date(inst.endMs).toISOString(),
    graceMinutes: inst.shift.graceMinutes,
    checkInCloseMinutes: inst.shift.checkInCloseMinutes,
    earlyCheckInMinutes: inst.shift.earlyCheckInMinutes,
    checkOutOpenMinutes: inst.shift.checkOutOpenMinutes,
    checkOutCloseMinutes: inst.shift.checkOutCloseMinutes,
  };
}

export type ShiftDetection =
  | { kind: 'match'; instance: ShiftInstance }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: ShiftInstance[] };

export function detectShift(tMs: number, tz: string, shifts: readonly Shift[]): ShiftDetection {
  const today = localParts(tMs, tz).date;
  const eligible: ShiftInstance[] = [];
  for (const shift of shifts) {
    if (!shift.active) continue;
    for (const d of [addDays(today, -1), today, addDays(today, 1)]) {
      const inst = shiftInstance(shift, d, tz);
      if (tMs >= inst.opensMs && tMs < inst.endMs) eligible.push(inst);
    }
  }
  if (eligible.length === 0) return { kind: 'none' };
  if (eligible.length === 1) return { kind: 'match', instance: eligible[0] };

  const arrival = eligible.filter((i) => tMs <= i.startMs + i.shift.graceMinutes * 60_000);
  if (arrival.length === 1) return { kind: 'match', instance: arrival[0] };
  if (arrival.length > 1) {
    const ranked = [...arrival].sort((a, b) => Math.abs(tMs - a.startMs) - Math.abs(tMs - b.startMs));
    if (Math.abs(tMs - ranked[0].startMs) < Math.abs(tMs - ranked[1].startMs)) return { kind: 'match', instance: ranked[0] };
  }
  return { kind: 'ambiguous', candidates: eligible };
}

export class ShiftService {
  constructor(
    private readonly store: JsonStore<ShiftsFile>,
    private readonly audit: AuditService,
    private readonly emit: (e: LiveEvent) => void,
    private readonly now: () => number,
  ) {}

  list(): Shift[] {
    return [...this.store.data.shifts].sort((a, b) => parseHHmm(a.start) - parseHHmm(b.start) || a.name.localeCompare(b.name));
  }

  active(): Shift[] {
    return this.store.data.shifts.filter((s) => s.active && !s.archivedAt);
  }

  get(id: string): Shift | undefined {
    return this.store.data.shifts.find((s) => s.id === id);
  }

  private validateTimings(t: { start: string; end: string; earlyCheckInMinutes: number; graceMinutes: number; checkInCloseMinutes: number }): void {
    if (t.start === t.end) throw new PulseError('VALIDATION', 'A shift cannot start and end at the same time');
    if (t.graceMinutes > t.checkInCloseMinutes) throw new PulseError('VALIDATION', 'The grace period cannot be longer than the check-in window');
    if (shiftDurationMinutes(t.start, t.end) + t.earlyCheckInMinutes >= 1380) {
      throw new PulseError('VALIDATION', 'Shift length plus the early check-in window must be under 23 hours');
    }
  }

  private checkNoDuplicate(draft: Shift[], candidate: Shift): void {
    if (!candidate.active) return;
    const clash = draft.find((s) => s.active && s.id !== candidate.id && s.start === candidate.start && s.end === candidate.end);
    if (clash) throw new PulseError('SHIFT_CONFLICT', `"${clash.name}" is active with exactly the same start and end time. Deactivate it or change the timings.`, 409);
  }

  async create(input: unknown, actor: string): Promise<Shift> {
    const parsed = createSchema.safeParse(input);
    if (!parsed.success) throw new PulseError('VALIDATION', formatZodError(parsed.error));
    const v = parsed.data;
    this.validateTimings(v);
    const nowIso = new Date(this.now()).toISOString();
    const shift: Shift = {
      id: newId('shf', this.now()),
      name: v.name,
      start: v.start,
      end: v.end,
      graceMinutes: v.graceMinutes,
      checkInCloseMinutes: v.checkInCloseMinutes,
      earlyCheckInMinutes: v.earlyCheckInMinutes,
      checkOutOpenMinutes: v.checkOutOpenMinutes,
      checkOutCloseMinutes: v.checkOutCloseMinutes,
      active: v.active,
      overnight: isOvernight(v.start, v.end),
      createdAt: nowIso,
      updatedAt: nowIso,
      createdBy: actor,
      updatedBy: actor,
    };
    await this.store.update((d) => {
      if (d.shifts.some((s) => s.name.toLowerCase() === shift.name.toLowerCase())) throw new PulseError('SHIFT_CONFLICT', `A shift named "${shift.name}" already exists`, 409);
      this.checkNoDuplicate(d.shifts, shift);
      d.shifts.push(shift);
    });
    await this.audit.record({
      type: 'shift.created',
      severity: 'notice',
      actor,
      summary: `Shift "${shift.name}" created (${shift.start}–${shift.end}${shift.overnight ? ', overnight' : ''})`,
      details: { shiftId: shift.id, start: shift.start, end: shift.end, graceMinutes: shift.graceMinutes, checkInCloseMinutes: shift.checkInCloseMinutes, earlyCheckInMinutes: shift.earlyCheckInMinutes, checkOutOpenMinutes: shift.checkOutOpenMinutes, checkOutCloseMinutes: shift.checkOutCloseMinutes, active: shift.active },
    });
    this.emit({ type: 'shifts.changed', data: { at: nowIso } });
    return shift;
  }

  async update(input: unknown, actor: string): Promise<Shift> {
    const parsed = updateSchema.safeParse(input);
    if (!parsed.success) throw new PulseError('VALIDATION', formatZodError(parsed.error));
    const { id, patch } = parsed.data;
    const nowIso = new Date(this.now()).toISOString();
    let before!: Shift;
    let after!: Shift;
    await this.store.update((d) => {
      const cur = d.shifts.find((s) => s.id === id);
      if (!cur) throw new PulseError('NOT_FOUND', 'That shift does not exist', 404);
      if (cur.archivedAt) throw new PulseError('ARCHIVED', 'This shift is archived. Restore it before editing.', 409);
      before = { ...cur };
      const next: Shift = { ...cur, ...patch, updatedAt: nowIso, updatedBy: actor };
      next.overnight = isOvernight(next.start, next.end);
      this.validateTimings(next);
      if (d.shifts.some((s) => s.id !== id && s.name.toLowerCase() === next.name.toLowerCase())) throw new PulseError('SHIFT_CONFLICT', `A shift named "${next.name}" already exists`, 409);
      this.checkNoDuplicate(d.shifts, next);
      Object.assign(cur, next);
      after = { ...cur };
    });
    const changed = (Object.keys(patch) as Array<keyof Shift>).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (changed.length) {
      await this.audit.record({
        type: 'shift.updated',
        severity: 'notice',
        actor,
        summary: `Shift "${after.name}" changed: ${changed.join(', ')}`,
        details: { shiftId: id, ...Object.fromEntries(changed.map((k) => [k, { from: before[k], to: after[k] }])) },
      });
      this.emit({ type: 'shifts.changed', data: { at: nowIso } });
    }
    return after;
  }

  async setActive(id: string, active: boolean, actor: string): Promise<Shift> {
    const nowIso = new Date(this.now()).toISOString();
    let out!: Shift;
    let changed = false;
    await this.store.update((d) => {
      const cur = d.shifts.find((s) => s.id === id);
      if (!cur) throw new PulseError('NOT_FOUND', 'That shift does not exist', 404);
      if (active && cur.archivedAt) throw new PulseError('ARCHIVED', 'This shift is archived. Restore it before activating.', 409);
      if (cur.active !== active) {
        const next = { ...cur, active, updatedAt: nowIso, updatedBy: actor };
        this.checkNoDuplicate(d.shifts, next);
        Object.assign(cur, next);
        changed = true;
      }
      out = { ...cur };
    });
    if (changed) {
      await this.audit.record({
        type: active ? 'shift.activated' : 'shift.deactivated',
        severity: 'notice',
        actor,
        summary: `Shift "${out.name}" ${active ? 'activated' : 'deactivated'}`,
        details: { shiftId: id },
      });
      this.emit({ type: 'shifts.changed', data: { at: nowIso } });
    }
    return out;
  }

  async archive(input: unknown, actor: string): Promise<Shift> {
    const parsed = archiveSchema.safeParse(input);
    if (!parsed.success) throw new PulseError('VALIDATION', formatZodError(parsed.error));
    const { id, reason } = parsed.data;
    const nowIso = new Date(this.now()).toISOString();
    let out!: Shift;
    await this.store.update((d) => {
      const cur = d.shifts.find((s) => s.id === id);
      if (!cur) throw new PulseError('NOT_FOUND', 'That shift does not exist', 404);
      if (cur.archivedAt) throw new PulseError('ARCHIVED', 'This shift is already archived', 409);
      if (cur.active) throw new PulseError('SHIFT_ACTIVE', 'Deactivate the shift before archiving it', 409);
      cur.archivedAt = nowIso;
      cur.archivedBy = actor;
      cur.archivedReason = reason;
      cur.updatedAt = nowIso;
      cur.updatedBy = actor;
      out = { ...cur };
    });
    await this.audit.record({ type: 'shift.archived', severity: 'notice', actor, summary: `Shift "${out.name}" archived — ${reason}`, details: { shiftId: id } });
    this.emit({ type: 'shifts.changed', data: { at: nowIso } });
    this.emit({ type: 'archive.changed', data: { entity: 'shift', id, archived: true } });
    return out;
  }

  async restore(id: string, actor: string): Promise<Shift> {
    const nowIso = new Date(this.now()).toISOString();
    let out!: Shift;
    await this.store.update((d) => {
      const cur = d.shifts.find((s) => s.id === id);
      if (!cur) throw new PulseError('NOT_FOUND', 'That shift does not exist', 404);
      if (!cur.archivedAt) throw new PulseError('NOT_ARCHIVED', 'This shift is not archived', 409);
      delete cur.archivedAt;
      delete cur.archivedBy;
      delete cur.archivedReason;
      cur.updatedAt = nowIso;
      cur.updatedBy = actor;
      out = { ...cur };
    });
    await this.audit.record({ type: 'shift.restored', severity: 'notice', actor, summary: `Shift "${out.name}" restored from the archive (inactive)`, details: { shiftId: id } });
    this.emit({ type: 'shifts.changed', data: { at: nowIso } });
    this.emit({ type: 'archive.changed', data: { entity: 'shift', id, archived: false } });
    return out;
  }
}
