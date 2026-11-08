import type { LiveEvent, Settings } from '../shared/types';
import type { AttendanceService } from './domain/attendance';
import type { AuditService } from './domain/audit';
import type { DeviceService } from './domain/devices';
import type { EmployeeService } from './domain/employees';
import type { NetPolicy } from './netpolicy';
import type { QrModeService } from './qrmode';
import type { ChallengeAuthority, NonceStore, RegistrationTokens, ReplayGuard } from './tokens';

/** The pieces of the running host that transport layers (HTTP/WS/IPC) are allowed to touch. */
export interface PulseContext {
  now(): number;
  settings(): Settings;
  readonly hostId: string;
  readonly startedAtMs: number;
  readonly employees: EmployeeService;
  readonly devices: DeviceService;
  readonly attendance: AttendanceService;
  readonly audit: AuditService;
  readonly authority: ChallengeAuthority;
  readonly regTokens: RegistrationTokens;
  readonly qrMode: QrModeService;
  readonly nonces: NonceStore;
  readonly replay: ReplayGuard;
  readonly netPolicy: NetPolicy;
  emit(e: LiveEvent): void;
  noteStorageError(e: unknown): void;
  clearStorageError(): void;
  onRegistrationConsumed(): void;
}
