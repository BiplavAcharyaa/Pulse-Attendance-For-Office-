import type { ApiResult } from '../../shared/types';

export class MobileError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

async function send<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(12_000) });
  } catch {
    throw new MobileError('NETWORK', 'Could not reach the office computer. Check that you are on the office Wi-Fi and try again.');
  }
  let body: (ApiResult<T> & { error?: { retryAfterMs?: number } }) | null = null;
  try {
    body = await res.json();
  } catch {
    /* handled below */
  }
  if (!body) throw new MobileError('BAD_RESPONSE', 'The office computer sent an unexpected reply.');
  if (!body.ok) throw new MobileError(body.error.code, body.error.message, (body.error as { retryAfterMs?: number }).retryAfterMs);
  return body.data;
}

export const apiGet = <T>(path: string) => send<T>(path);
export const apiPost = <T>(path: string, body: unknown) =>
  send<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export interface HostInfo {
  hostId: string;
  orgName: string;
  timezone: string;
  serverTime: string;
  rotationSeconds: number;
  acceptWindowSeconds: number;
}

export interface StatusView {
  employee: { id: string; fullName: string; department: string };
  device: { deviceId: string; label: string; enrolledAt: string };
  status: {
    state: 'not-arrived' | 'checked-in' | 'checked-out';
    nextAction: 'check-in' | 'check-out' | 'none';
    today: { date: string; status: string; checkInLocal?: string; checkOutLocal?: string; workedMinutes: number; minutesLate?: number; classification?: 'on-time' | 'grace' | 'late' | 'off-day'; earlyLeave: boolean; overtimeMinutes?: number; overtimeStatus?: string };
    approval?: { kind: 'late-check-in' | 'overtime'; status: 'pending' | 'approved' | 'rejected' | 'voided'; eventKind: 'check-in' | 'check-out'; localTime: string; shiftName?: string; reason?: string; decidedByName?: string };
    lastEvent: { kind: string; ts: string; date: string; local: string } | null;
    shiftName?: string;
  };
  serverTime: string;
  timezone: string;
  orgName: string;
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

export interface AttendanceResult {
  saved: true;
  action?: 'check-in' | 'check-out';
  duplicate?: boolean;
  shift?: { id?: string; name: string };
  message: string;
  pendingApproval?: boolean;
  warning?: AttendanceWarning;
  event: { id: string; kind: 'check-in' | 'check-out'; ts: string; localDate: string; localTime: string; classification: string; minutes?: number; approval?: { kind: string; status: string } };
  employee: { id: string; fullName: string };
  status: StatusView['status'];
}

export interface RegistrationStatus {
  status: 'pending' | 'approved' | 'rejected';
  deviceId?: string;
  reason?: string;
  employee?: { id: string; fullName: string };
}

export async function postIdempotent<T>(path: string, body: unknown, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await apiPost<T>(path, body);
    } catch (e) {
      last = e;
      if (!(e instanceof MobileError) || e.code !== 'NETWORK') throw e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw last;
}
