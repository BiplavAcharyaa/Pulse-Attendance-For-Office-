export interface ShiftRules {
  graceMinutes: number;
  checkInCloseMinutes: number;
  earlyCheckInMinutes: number;
  checkOutOpenMinutes: number;
  checkOutCloseMinutes: number;
}

export const DEFAULT_SHIFT_RULES: ShiftRules = {
  graceMinutes: 15,
  checkInCloseMinutes: 60,
  earlyCheckInMinutes: 60,
  checkOutOpenMinutes: 60,
  checkOutCloseMinutes: 60,
};

export interface RuleSource {
  graceMinutes?: number;
  checkInCloseMinutes?: number;
  earlyCheckInMinutes?: number;
  checkOutOpenMinutes?: number;
  checkOutCloseMinutes?: number;
}

export function rulesOf(src: RuleSource): ShiftRules {
  const d = DEFAULT_SHIFT_RULES;
  return {
    graceMinutes: src.graceMinutes ?? d.graceMinutes,
    checkInCloseMinutes: src.checkInCloseMinutes ?? d.checkInCloseMinutes,
    earlyCheckInMinutes: src.earlyCheckInMinutes ?? d.earlyCheckInMinutes,
    checkOutOpenMinutes: src.checkOutOpenMinutes ?? d.checkOutOpenMinutes,
    checkOutCloseMinutes: src.checkOutCloseMinutes ?? d.checkOutCloseMinutes,
  };
}

export type CheckInBand = 'before-open' | 'on-time' | 'grace' | 'late' | 'closed';
export type CheckOutBand = 'not-open' | 'early' | 'on-time' | 'overtime';
export type ArrivalClass = 'on-time' | 'grace' | 'late';

export const MONTHLY_GRACE_LIMIT = 3;
export const MONTHLY_LATE_LIMIT = 2;

const MIN = 60_000;

export function arrivalClass(tMs: number, startMs: number, graceMinutes: number): ArrivalClass {
  if (tMs <= startMs) return 'on-time';
  if (tMs <= startMs + graceMinutes * MIN) return 'grace';
  return 'late';
}

export function arrivalOf(classification: string): ArrivalClass | null {
  if (classification === 'on-time') return 'on-time';
  if (classification === 'grace') return 'grace';
  if (classification === 'late' || classification === 'very-late') return 'late';
  return null;
}

export function checkInOpensMs(startMs: number, rules: ShiftRules): number {
  return startMs - rules.earlyCheckInMinutes * MIN;
}

export function checkInClosesMs(startMs: number, rules: ShiftRules): number {
  return startMs + rules.checkInCloseMinutes * MIN;
}

export function checkOutOpensMs(startMs: number, endMs: number, rules: ShiftRules): number {
  return Math.max(startMs, endMs - rules.checkOutOpenMinutes * MIN);
}

export function checkOutClosesMs(endMs: number, rules: ShiftRules): number {
  return endMs + rules.checkOutCloseMinutes * MIN;
}

export function minutesAfter(tMs: number, refMs: number): number {
  return Math.floor((tMs - refMs) / MIN);
}

export function minutesAfterCeil(tMs: number, refMs: number): number {
  return Math.max(0, Math.ceil((tMs - refMs) / MIN));
}

export function checkInBand(tMs: number, startMs: number, rules: ShiftRules): CheckInBand {
  if (tMs < checkInOpensMs(startMs, rules)) return 'before-open';
  if (tMs > checkInClosesMs(startMs, rules)) return 'closed';
  return arrivalClass(tMs, startMs, rules.graceMinutes);
}

export function checkOutBand(tMs: number, startMs: number, endMs: number, rules: ShiftRules): CheckOutBand {
  if (tMs < checkOutOpensMs(startMs, endMs, rules)) return 'not-open';
  if (tMs < endMs) return 'early';
  if (minutesAfter(tMs, endMs) <= rules.checkOutCloseMinutes) return 'on-time';
  return 'overtime';
}
