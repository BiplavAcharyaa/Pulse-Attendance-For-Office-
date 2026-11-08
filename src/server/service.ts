import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { AuditBody, HostHealth, IntegrityReport, LiveEvent, Settings } from '../shared/types';
import { AdminApi } from './adminApi';
import { AdminAuth } from './adminAuth';
import { ClockGuard } from './clock';
import type { PulseContext } from './context';
import { AttendanceService, type LogEventBody } from './domain/attendance';
import { AuditService } from './domain/audit';
import { DeviceService } from './domain/devices';
import { EmployeeService } from './domain/employees';
import { MaintenanceService } from './domain/maintenance';
import { ShiftService } from './domain/shifts';
import { StorageError, PulseError } from './errors';
import { ExportService } from './exporter';
import { PhoneHttpServer } from './httpServer';
import { AdminLiveServer } from './liveServer';
import { NetPolicy } from './netpolicy';
import { resolveBindAddress, type BindResolution } from './network';
import { PhoneApi } from './phoneApi';
import { QrModeService, defaultQrModeDoc, validateQrModeDoc, type QrModeDoc } from './qrmode';
import {
  adminsFileSchema,
  defaultSettings,
  devicesFileSchema,
  employeesFileSchema,
  formatZodError,
  settingsPatchSchema,
  settingsSchema,
  shiftsFileSchema,
  type ShiftsFile,
  type AdminsFile,
  type DevicesFile,
  type EmployeesFile,
} from './schemas';
import { ensureDir, exists } from './storage/atomic';
import { JsonStore } from './storage/jsonStore';
import { JsonlLog } from './storage/jsonl';
import { protectRecords } from './storage/retention';
import { SecretStore, filePermissionProtector, type SecretProtector } from './storage/secrets';
import { ensureTls, type TlsMaterial } from './tls';
import { ChallengeAuthority, NonceStore, RegistrationTokens, ReplayGuard } from './tokens';
import { TerminalController } from './terminal';
import { randomToken } from './ids';
import { localParts } from './time';

export interface ServiceOptions {
  dataDir: string;
  protector?: SecretProtector;
  now?: () => number;
  mono?: () => number;
  webRoot?: string;
  bindOverride?: string;
  httpsPortOverride?: number;
  setupPortOverride?: number;
  exportsDir?: string;
  disableTimers?: boolean;
  liveAllowedOrigins?: string[];
}

const NETWORK_KEYS: Array<keyof Settings> = ['bindAddress', 'httpsPort', 'setupHttpPort', 'hostnames'];

export class PulseService implements PulseContext {
  readonly bus = new EventEmitter();
  readonly terminalKey = randomToken(24);
  readonly dataDir: string;
  readonly hostId: string;
  readonly startedAtMs: number;
  readonly exportsDir: string;

  readonly secrets: SecretStore;
  readonly settingsStore: JsonStore<Settings>;
  readonly employeesStore: JsonStore<EmployeesFile>;
  readonly devicesStore: JsonStore<DevicesFile>;
  readonly adminsStore: JsonStore<AdminsFile>;
  readonly qrModeStore: JsonStore<QrModeDoc>;
  readonly shiftsStore: JsonStore<ShiftsFile>;
  readonly attendanceLog: JsonlLog<LogEventBody>;
  readonly auditLog: JsonlLog<AuditBody>;

  readonly audit: AuditService;
  readonly employees: EmployeeService;
  readonly devices: DeviceService;
  readonly shifts: ShiftService;
  readonly maintenance: MaintenanceService;
  readonly attendance: AttendanceService;
  readonly adminAuth: AdminAuth;
  readonly clock: ClockGuard;
  readonly authority: ChallengeAuthority;
  readonly regTokens: RegistrationTokens;
  readonly nonces = new NonceStore();
  readonly replay = new ReplayGuard();
  readonly netPolicy: NetPolicy;
  readonly qrMode: QrModeService;
  readonly terminal: TerminalController;
  readonly exporter: ExportService;
  readonly phone: PhoneApi;
  readonly admin: AdminApi;
  readonly http: PhoneHttpServer;
  readonly live: AdminLiveServer;

  bind!: BindResolution;
  tls!: TlsMaterial;
  recoveryNotes: Array<{ level: 'info' | 'warning' | 'critical'; message: string }> = [];
  lastIntegrity: IntegrityReport | null = null;
  private timers: NodeJS.Timeout[] = [];
  private diskFullSince: number | null = null;
  private lastStorageError: string | null = null;
  private running = false;
  private startedIso: string;

  private constructor(private readonly opts: ServiceOptions, parts: {
    secrets: SecretStore;
    settingsStore: JsonStore<Settings>;
    employeesStore: JsonStore<EmployeesFile>;
    devicesStore: JsonStore<DevicesFile>;
    adminsStore: JsonStore<AdminsFile>;
    qrModeStore: JsonStore<QrModeDoc>;
    shiftsStore: JsonStore<ShiftsFile>;
    attendanceLog: JsonlLog<LogEventBody>;
    auditLog: JsonlLog<AuditBody>;
  }) {
    Object.assign(this, parts);
    this.secrets = parts.secrets;
    this.settingsStore = parts.settingsStore;
    this.employeesStore = parts.employeesStore;
    this.devicesStore = parts.devicesStore;
    this.adminsStore = parts.adminsStore;
    this.qrModeStore = parts.qrModeStore;
    this.shiftsStore = parts.shiftsStore;
    this.attendanceLog = parts.attendanceLog;
    this.auditLog = parts.auditLog;

    this.dataDir = opts.dataDir;
    this.exportsDir = opts.exportsDir ?? path.join(opts.dataDir, 'exports');
    this.now = opts.now ?? Date.now;
    this.startedAtMs = this.now();
    this.startedIso = new Date(this.startedAtMs).toISOString();
    this.hostId = this.settingsStore.data.hostId;
    const emit = (e: LiveEvent) => this.emit(e);

    this.audit = new AuditService(this.auditLog, this.now, emit);
    this.employees = new EmployeeService(this.employeesStore, this.audit, emit, this.now);
    this.devices = new DeviceService(this.devicesStore, this.employees, this.audit, emit, this.now);
    const mono = opts.mono ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
    this.clock = new ClockGuard(this.now, mono, (message, blocking) => {
      void this.audit.record({ type: 'system.clock-change', severity: blocking ? 'critical' : 'warning', summary: message });
      void this.emitHealth();
    });
    this.shifts = new ShiftService(this.shiftsStore, this.audit, emit, this.now);
    this.attendance = new AttendanceService(this.attendanceLog, this.employees, () => this.settings(), this.now, this.audit, emit, this.clock, () => this.shifts.active());
    this.adminAuth = new AdminAuth(this.adminsStore, this.audit, this.now, () => this.settings().sessionIdleMinutes);
    this.maintenance = new MaintenanceService({
      admins: () => this.adminAuth.listAdmins(),
      devices: this.devices,
      employees: this.employees,
      audit: this.audit,
      now: this.now,
      lastDeviceUse: () => {
        const m = new Map<string, string>();
        for (const r of this.attendanceLog.records) if (r.type === 'attendance') m.set(r.deviceId, r.ts);
        return m;
      },
      backup: (actor) => this.backup(actor),
      archiveAdmin: (id, reason, actor) => this.adminAuth.archiveAdmin(id, reason, actor),
      purgeSessions: () => this.adminAuth.purgeExpiredSessions(),
    });
    const hmac = Buffer.from(this.secrets.data.hmacKey, 'base64');
    this.authority = new ChallengeAuthority(hmac, this.hostId, this.startedAtMs);
    this.regTokens = new RegistrationTokens(hmac, this.hostId);
    this.netPolicy = new NetPolicy(this.settings().allowedCidrs);
    this.qrMode = new QrModeService(this.qrModeStore, hmac, this.hostId, this.audit, this.now, emit, () => this.settings(), () => this.terminal.applyQrMode());
    this.terminal = new TerminalController({
      authority: () => this.authority,
      regTokens: () => this.regTokens,
      qrMode: () => this.qrMode,
      settings: () => this.settings(),
      now: this.now,
      baseUrl: () => this.baseUrl(),
      emit,
    });
    this.exporter = new ExportService({
      exportsDir: this.exportsDir,
      settings: () => this.settings(),
      employees: this.employees,
      devices: this.devices,
      attendance: this.attendance,
      audit: this.audit,
      auditEntries: () => this.audit.list({ limit: 1_000_000 }),
      now: this.now,
      emit,
    });
    this.phone = new PhoneApi(this);
    this.admin = new AdminApi(this);
    this.http = new PhoneHttpServer(this, opts.webRoot);
    this.live = new AdminLiveServer(this, opts.liveAllowedOrigins ?? ['app://pulse']);
  }

  now: () => number;

  static async create(opts: ServiceOptions): Promise<PulseService> {
    const dir = opts.dataDir;
    await ensureDir(dir);
    await ensureDir(path.join(dir, 'exports'));
    const secrets = new SecretStore(path.join(dir, 'host-secrets.json'), opts.protector ?? filePermissionProtector);
    await secrets.load();

    const settingsStore = new JsonStore<Settings>({
      file: path.join(dir, 'settings.json'),
      currentVersion: 1,
      defaults: () => defaultSettings(randomToken(9)),
      validate: (raw) => {
        const r = settingsSchema.safeParse({ ...defaultSettings('placeholder-host'), ...(raw as object) });
        if (!r.success) throw new Error(formatZodError(r.error));
        return r.data as Settings;
      },
    });
    const employeesStore = new JsonStore<EmployeesFile>({
      file: path.join(dir, 'employees.json'),
      currentVersion: 1,
      defaults: () => ({ schemaVersion: 1, employees: [] }),
      validate: (raw) => employeesFileSchema.parse(raw),
      guard: protectRecords<EmployeesFile>([{ label: 'Employee', key: 'id', select: (d) => d.employees }]),
    });
    const devicesStore = new JsonStore<DevicesFile>({
      file: path.join(dir, 'devices.json'),
      currentVersion: 1,
      defaults: () => ({ schemaVersion: 1, devices: [], requests: [] }),
      validate: (raw) => devicesFileSchema.parse(raw),
      guard: protectRecords<DevicesFile>([
        { label: 'Device', key: 'deviceId', select: (d) => d.devices },
        { label: 'Registration request', key: 'requestId', select: (d) => d.requests },
      ]),
    });
    const adminsStore = new JsonStore<AdminsFile>({
      file: path.join(dir, 'admins.json'),
      currentVersion: 1,
      defaults: () => ({ schemaVersion: 1, admins: [] }),
      validate: (raw) => adminsFileSchema.parse(raw),
      guard: protectRecords<AdminsFile>([{ label: 'Administrator account', key: 'id', select: (d) => d.admins }]),
    });
    const qrModeStore = new JsonStore<QrModeDoc>({
      file: path.join(dir, 'qr-mode.json'),
      currentVersion: 1,
      defaults: () => defaultQrModeDoc(new Date((opts.now ?? Date.now)()).toISOString()),
      validate: validateQrModeDoc,
    });
    const shiftsStore = new JsonStore<ShiftsFile>({
      file: path.join(dir, 'shifts.json'),
      currentVersion: 1,
      defaults: () => ({ schemaVersion: 1, shifts: [] }),
      validate: (raw) => shiftsFileSchema.parse(raw),
      guard: protectRecords<ShiftsFile>([{ label: 'Shift', key: 'id', select: (d) => d.shifts }]),
    });
    await Promise.all([settingsStore.load(), employeesStore.load(), devicesStore.load(), adminsStore.load(), qrModeStore.load(), shiftsStore.load()]);

    const integrityKey = Buffer.from(secrets.data.integrityKey, 'base64');
    const attendanceLog = new JsonlLog<LogEventBody>(path.join(dir, 'attendance-events.jsonl'), integrityKey);
    const auditLog = new JsonlLog<AuditBody>(path.join(dir, 'audit-log.jsonl'), integrityKey);
    await auditLog.load();
    await attendanceLog.load();

    const svc = new PulseService(opts, { secrets, settingsStore, employeesStore, devicesStore, adminsStore, qrModeStore, shiftsStore, attendanceLog, auditLog });
    await svc.recordStartupFindings();
    return svc;
  }

  // ───────────── PulseContext ─────────────
  settings(): Settings {
    return this.settingsStore.data as Settings;
  }

  emit(e: LiveEvent): void {
    this.bus.emit('live', e);
  }

  noteStorageError(e: unknown): void {
    if (e instanceof StorageError) {
      if (e.code === 'STORAGE_FULL') this.diskFullSince = this.now();
      this.lastStorageError = e.message;
    }
  }

  clearStorageError(): void {
    this.diskFullSince = null;
    this.lastStorageError = null;
  }

  onRegistrationConsumed(): void {
    this.terminal.onRegistrationFinished();
  }

  baseUrl(): string {
    const s = this.settings();
    const host = s.hostnames[0] ?? this.bind?.address ?? '127.0.0.1';
    return `https://${host}:${this.http?.httpsPort || s.httpsPort}`;
  }

  // ───────────── lifecycle ─────────────
  private async recordStartupFindings(): Promise<void> {
    const notes = [
      ...this.settingsStore.notes,
      ...this.employeesStore.notes,
      ...this.devicesStore.notes,
      ...this.adminsStore.notes,
      ...this.qrModeStore.notes,
      ...this.shiftsStore.notes,
      ...this.attendanceLog.recoveryNotes.map((m) => ({ level: 'warning' as const, message: m })),
      ...this.auditLog.recoveryNotes.map((m) => ({ level: 'warning' as const, message: m })),
    ];
    this.recoveryNotes = notes;
    for (const n of notes) {
      await this.audit.record({ type: 'system.recovery', severity: n.level === 'critical' ? 'critical' : 'warning', summary: n.message });
    }
    const problems = [
      ...this.attendanceLog.loadProblems.map((p) => `attendance-events.jsonl ${p}`),
      ...this.auditLog.loadProblems.map((p) => `audit-log.jsonl ${p}`),
    ];
    if (problems.length) {
      await this.audit.record({ type: 'system.integrity-check', severity: 'critical', summary: `Integrity problems found at startup (${problems.length})`, details: { problems: problems.slice(0, 20) } });
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    const s = this.settings();
    this.bind = resolveBindAddress(this.opts.bindOverride ?? s.bindAddress);
    this.tls = await ensureTls({ dataDir: this.dataDir, secrets: this.secrets, address: this.bind.address, hostnames: s.hostnames, now: this.now });
    await this.http.start({
      address: this.bind.address,
      httpsPort: this.opts.httpsPortOverride ?? s.httpsPort,
      setupPort: this.opts.setupPortOverride ?? s.setupHttpPort,
      tls: this.tls,
    });
    await this.live.start();
    this.terminal.start();
    this.running = true;
    if (!this.opts.disableTimers) {
      this.timers.push(
        setInterval(() => this.clock.check(), 1000),
        setInterval(() => void this.emitHealth(), 10_000),
      );
      this.timers.forEach((t) => t.unref?.());
    }
    await this.autoBackup();
    await this.audit.record({ type: 'system.start', summary: `PULSE host started on ${this.bind.address}:${this.http.httpsPort}`, details: { bind: this.bind } });
  }

  async stop(): Promise<void> {
    if (!this.running) {
      await this.closeLogs();
      return;
    }
    this.running = false;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.terminal.stop();
    await this.audit.record({ type: 'system.stop', summary: 'PULSE host stopping' });
    await this.live.stop();
    await this.http.stop();
    await this.closeLogs();
  }

  private async closeLogs(): Promise<void> {
    await this.attendanceLog.close();
    await this.auditLog.close();
  }

  async restartNetwork(): Promise<void> {
    const s = this.settings();
    await this.http.stop();
    this.bind = resolveBindAddress(this.opts.bindOverride ?? s.bindAddress);
    this.tls = await ensureTls({ dataDir: this.dataDir, secrets: this.secrets, address: this.bind.address, hostnames: s.hostnames, now: this.now });
    await this.http.start({
      address: this.bind.address,
      httpsPort: this.opts.httpsPortOverride ?? s.httpsPort,
      setupPort: this.opts.setupPortOverride ?? s.setupHttpPort,
      tls: this.tls,
    });
    if (this.terminal.getMode() === 'attendance') this.terminal.start();
  }

  // ───────────── settings ─────────────
  async updateSettings(patch: unknown, actor: string): Promise<Settings> {
    const parsed = settingsPatchSchema.safeParse(patch);
    if (!parsed.success) throw new PulseError('VALIDATION', formatZodError(parsed.error));
    const before = { ...this.settings() };
    try {
      new NetPolicy(parsed.data.allowedCidrs ?? before.allowedCidrs);
    } catch (e) {
      throw new PulseError('VALIDATION', (e as Error).message);
    }
    try {
      await this.settingsStore.update((d) => {
        Object.assign(d, parsed.data);
      });
    } catch (e) {
      if (e instanceof PulseError) throw e;
      throw new PulseError('VALIDATION', (e as Error).message);
    }
    const after = this.settings();
    this.netPolicy.set(after.allowedCidrs);
    const changed = (Object.keys(parsed.data) as Array<keyof Settings>).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (changed.length) {
      await this.audit.record({
        type: 'settings.changed',
        severity: 'notice',
        actor,
        summary: `Settings changed: ${changed.join(', ')}`,
        details: Object.fromEntries(changed.map((k) => [k, { from: before[k], to: after[k] }])),
      });
      if (changed.includes('rotationSeconds') && this.terminal.getMode() === 'attendance') this.terminal.start();
      if (changed.some((k) => NETWORK_KEYS.includes(k)) && this.running) await this.restartNetwork();
      this.emit({ type: 'settings.changed', data: { at: new Date(this.now()).toISOString() } });
    }
    return after;
  }

  // ───────────── health / integrity / backup ─────────────
  async health(): Promise<HostHealth> {
    const s = this.settings();
    const nowMs = this.now();
    let freeMB: number | null = null;
    try {
      const st = await fs.statfs(this.dataDir);
      freeMB = Math.floor((Number(st.bavail) * Number(st.bsize)) / 1048576);
    } catch {
      freeMB = null;
    }
    const messages: string[] = [];
    let status: 'ok' | 'degraded' | 'critical' = 'ok';
    const bump = (lvl: 'degraded' | 'critical', msg: string) => {
      messages.push(msg);
      if (lvl === 'critical' || status === 'ok') status = lvl === 'critical' ? 'critical' : status === 'critical' ? 'critical' : 'degraded';
    };
    const diskFull = this.diskFullSince !== null || (freeMB !== null && freeMB < 1);
    const lowDisk = freeMB !== null && freeMB < s.lowDiskWarnMB;
    if (diskFull) bump('critical', 'Disk is full — attendance cannot be saved. Free up space immediately.');
    else if (lowDisk) bump('degraded', `Low disk space: ${freeMB} MB free.`);
    if (this.lastStorageError && !diskFull) bump('critical', this.lastStorageError);
    for (const n of this.recoveryNotes) bump(n.level === 'critical' ? 'critical' : 'degraded', n.message);
    const problems = this.attendanceLog.loadProblems.length + this.auditLog.loadProblems.length;
    if (problems) bump('critical', `${problems} integrity problem(s) were found in the logs at startup. Run an integrity check.`);
    if (this.lastIntegrity && !this.lastIntegrity.ok) bump('critical', 'The last integrity check found problems.');
    if (this.audit.lastError) bump('degraded', `Audit log write failed: ${this.audit.lastError}`);
    if (this.clock.suspect) bump('critical', this.clock.message ?? 'Host clock needs attention.');
    if (this.bind?.warning) bump('degraded', this.bind.warning);

    const last = this.attendance.effective();
    const latest = last[last.length - 1];
    const latestRaw = [...this.attendance.rawEvents()].reverse().find((e) => e.type === 'attendance');
    const latestEvent = latestRaw && latestRaw.type === 'attendance' ? latestRaw : undefined;
    void latest;
    const lp = localParts(nowMs, s.timezone);
    const host = this.bind?.address ?? '127.0.0.1';
    return {
      startedAt: this.startedIso,
      uptimeSeconds: Math.floor((nowMs - this.startedAtMs) / 1000),
      lanAddress: host,
      httpsPort: this.http.httpsPort,
      setupHttpPort: this.http.setupPort,
      httpsUrl: this.baseUrl(),
      setupUrl: `http://${s.hostnames[0] ?? host}:${this.http.setupPort}`,
      listening: this.running && this.http.listening,
      wsClients: this.http.wsClientCount,
      adminLiveClients: this.live.clientCount,
      timezone: s.timezone,
      hostTime: `${lp.date} ${lp.time}`,
      storage: {
        status,
        dataDir: this.dataDir,
        freeMB,
        lowDisk,
        diskFull,
        messages,
        attendanceEvents: this.attendance.eventCount,
        auditEntries: this.audit.count,
        lastIntegrityCheck: this.lastIntegrity ? { at: this.lastIntegrity.at, ok: this.lastIntegrity.ok, problems: this.lastIntegrity.files.reduce((n, f) => n + f.problems.length, 0) } : undefined,
      },
      secretsProtection: this.secrets.protection === 'os-protected' ? 'os-protected' : 'file-permissions-only',
      tls: this.tls ? { caFingerprint: this.tls.caFingerprint, leafExpires: this.tls.leafExpires, names: this.tls.names } : { caFingerprint: '', leafExpires: '', names: [] },
      latestEvent: latestEvent
        ? { id: latestEvent.id, employeeId: latestEvent.employeeId, employeeName: this.employees.get(latestEvent.employeeId)?.fullName ?? latestEvent.employeeId, kind: latestEvent.kind, ts: latestEvent.ts }
        : undefined,
      clock: { suspect: this.clock.suspect, message: this.clock.message },
      lastExport: this.exporter.status.state === 'idle' ? undefined : this.exporter.status,
    };
  }

  async emitHealth(): Promise<void> {
    if (this.live.clientCount === 0) return;
    this.emit({ type: 'health', data: await this.health() });
  }

  async verifyIntegrity(actor: string): Promise<IntegrityReport> {
    const files: IntegrityReport['files'] = [];
    for (const [name, store] of [
      ['settings.json', this.settingsStore],
      ['employees.json', this.employeesStore],
      ['devices.json', this.devicesStore],
      ['admins.json', this.adminsStore],
      ['qr-mode.json', this.qrModeStore],
      ['shifts.json', this.shiftsStore],
    ] as const) {
      const r = await store.verifyOnDisk();
      files.push({ file: name, records: 1, ok: r.ok, problems: r.ok ? [] : [r.problem ?? 'unreadable'] });
    }
    for (const [name, log] of [
      ['attendance-events.jsonl', this.attendanceLog],
      ['audit-log.jsonl', this.auditLog],
    ] as const) {
      const r = await log.verifyFromDisk();
      files.push({ file: name, records: r.records, ok: r.ok, problems: r.problems.slice(0, 50) });
    }
    const report: IntegrityReport = { at: new Date(this.now()).toISOString(), ok: files.every((f) => f.ok), files };
    this.lastIntegrity = report;
    await this.audit.record({
      type: 'system.integrity-check',
      severity: report.ok ? 'info' : 'critical',
      actor,
      summary: report.ok ? 'Integrity check passed for all data files' : `Integrity check found problems in ${files.filter((f) => !f.ok).map((f) => f.file).join(', ')}`,
      details: { files: files.map((f) => ({ file: f.file, records: f.records, ok: f.ok, problems: f.problems.slice(0, 5) })) },
    });
    void this.emitHealth();
    return report;
  }

  /** Once per local day (and only when there is data worth protecting), keeping the 14 newest automatic copies. */
  private async autoBackup(): Promise<void> {
    try {
      if (this.employees.list().length === 0 && this.attendance.eventCount === 0) return;
      const root = path.join(this.dataDir, 'backups');
      const today = localParts(this.now(), this.settings().timezone).date.replace(/-/g, '');
      const existing = (await fs.readdir(root).catch(() => [] as string[])).filter((n) => /^\d{8}-\d{6}-auto$/.test(n)).sort();
      if (!existing.some((n) => n.startsWith(today))) await this.backup('system', true);
      const all = (await fs.readdir(root).catch(() => [] as string[])).filter((n) => /^\d{8}-\d{6}-auto$/.test(n)).sort();
      const stale = all.slice(0, Math.max(0, all.length - 14));
      if (stale.length) {
        const archiveRoot = path.join(root, 'archive');
        await ensureDir(archiveRoot);
        for (const old of stale) {
          let target = path.join(archiveRoot, old);
          for (let n = 2; await exists(target); n++) target = path.join(archiveRoot, `${old}-${n}`);
          await fs.rename(path.join(root, old), target);
        }
      }
    } catch (e) {
      console.error('[pulse] automatic backup failed:', (e as Error).message);
    }
  }

  async backup(actor: string, auto = false): Promise<{ dir: string; files: string[] }> {
    const p = localParts(this.now(), this.settings().timezone);
    const dir = path.join(this.dataDir, 'backups', `${p.date.replace(/-/g, '')}-${p.time.replace(/:/g, '')}${auto ? '-auto' : ''}`);
    await ensureDir(dir);
    const names = ['settings.json', 'employees.json', 'devices.json', 'admins.json', 'qr-mode.json', 'shifts.json', 'attendance-events.jsonl', 'audit-log.jsonl', 'host-secrets.json'];
    const copied: string[] = [];
    for (const n of names) {
      const src = path.join(this.dataDir, n);
      if (await exists(src)) {
        try {
          await fs.copyFile(src, path.join(dir, n));
          copied.push(n);
        } catch (e) {
          await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
          throw new PulseError('BACKUP_FAILED', `Backup failed while copying ${n}: ${(e as Error).message}`, 500);
        }
      }
    }
    const tlsDir = path.join(this.dataDir, 'tls');
    if (await exists(tlsDir)) {
      await fs.cp(tlsDir, path.join(dir, 'tls'), { recursive: true }).catch(() => undefined);
    }
    await this.audit.record({ type: 'backup.created', actor, summary: `Backup created (${copied.length} files)`, details: { dir } });
    return { dir, files: copied };
  }
}
