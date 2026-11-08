import type { LiveEvent, RequestType, Settings, TerminalMode, TerminalQr } from '../shared/types';
import type { QrModeService } from './qrmode';
import type { ChallengeAuthority, RegistrationTokens } from './tokens';

/**
 * Drives the reception terminal: a rotating attendance challenge (default every 3 s) or a one-time
 * registration token, and publishes each new QR payload to the live channels.
 */
export class TerminalController {
  private mode: TerminalMode = 'attendance';
  private current: TerminalQr | null = null;
  private timer: NodeJS.Timeout | null = null;
  private regContext: { type: RequestType; employeeId?: string; issuedBy: string } | null = null;

  constructor(
    private readonly deps: {
      authority: () => ChallengeAuthority;
      regTokens: () => RegistrationTokens;
      qrMode: () => QrModeService;
      settings: () => Settings;
      now: () => number;
      baseUrl: () => string;
      emit: (e: LiveEvent) => void;
    },
  ) {}

  start(): void {
    this.stop();
    this.rotate();
    if (!this.isPermanent()) this.schedule();
  }

  private isPermanent(): boolean {
    return this.deps.qrMode().activeMode() === 'permanent';
  }

  applyQrMode(): void {
    if (this.mode === 'attendance') this.start();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    const ms = this.mode === 'attendance' ? this.deps.settings().rotationSeconds * 1000 : 1000;
    const t = setTimeout(() => {
      if (this.timer !== t) return;
      this.tick();
      if (this.timer === t) this.schedule();
    }, ms);
    this.timer = t;
    t.unref?.();
  }

  private tick(): void {
    if (this.mode === 'attendance') this.rotate();
    else if (this.current && this.current.expiresAt <= this.deps.now()) this.onRegistrationFinished();
  }

  /** Issues the next attendance challenge. Also exposed for tests. */
  rotate(): TerminalQr {
    if (this.mode !== 'attendance') return this.current!;
    const s = this.deps.settings();
    const nowMs = this.deps.now();
    if (this.isPermanent()) {
      const permanentToken = this.deps.qrMode().issuePermanentToken();
      if (permanentToken) {
        this.current = {
          mode: 'attendance',
          qrMode: 'permanent',
          url: `${this.deps.baseUrl()}/#a=${permanentToken}`,
          issuedAt: Date.parse(this.deps.qrMode().permanentRecord()!.createdAt),
          rotationMs: 0,
          expiresAt: 0,
          hostTime: nowMs,
        };
        this.deps.emit({ type: 'qr', data: this.current });
        return this.current;
      }
    }
    const { token } = this.deps.authority().issue(nowMs);
    this.current = {
      mode: 'attendance',
      qrMode: 'timer',
      url: `${this.deps.baseUrl()}/#a=${token}`,
      issuedAt: nowMs,
      rotationMs: s.rotationSeconds * 1000,
      expiresAt: nowMs + s.rotationSeconds * 1000,
      hostTime: nowMs,
    };
    this.deps.emit({ type: 'qr', data: this.current });
    return this.current;
  }

  getMode(): TerminalMode {
    return this.mode;
  }

  getCurrent(): TerminalQr {
    if (!this.current) this.rotate();
    return { ...this.current!, hostTime: this.deps.now() };
  }

  setMode(mode: TerminalMode, issuedBy: string): TerminalQr {
    if (mode === 'attendance') {
      this.mode = 'attendance';
      this.regContext = null;
      this.deps.emit({ type: 'terminal.mode', data: { mode } });
      this.start();
      return this.current!;
    }
    return this.issueRegistration({ type: 'registration', issuedBy });
  }

  issueRegistration(ctx: { type: RequestType; employeeId?: string; issuedBy: string }): TerminalQr {
    const s = this.deps.settings();
    const nowMs = this.deps.now();
    const ttl = s.registrationTokenMinutes * 60_000;
    const { token } = this.deps.regTokens().issue({ ...ctx, nowMs, ttlMs: ttl });
    this.mode = 'registration';
    this.regContext = ctx;
    this.current = { mode: 'registration', url: `${this.deps.baseUrl()}/#r=${token}`, issuedAt: nowMs, rotationMs: ttl, expiresAt: nowMs + ttl, hostTime: nowMs };
    this.deps.emit({ type: 'terminal.mode', data: { mode: 'registration' } });
    this.deps.emit({ type: 'qr', data: this.current });
    this.stop();
    this.schedule();
    return this.current;
  }

  /** Called when the registration token was consumed (or expired). Generic registration stays open; replacements revert. */
  onRegistrationFinished(): void {
    if (this.mode !== 'registration') return;
    const ctx = this.regContext;
    if (ctx && ctx.type === 'registration') this.issueRegistration(ctx);
    else this.setMode('attendance', ctx?.issuedBy ?? 'system');
  }
}
