/**
 * Detects host clock changes by comparing the wall clock against a monotonic clock. Attendance
 * timestamps always come from the host; if the host clock moves backwards, new events are refused
 * until an administrator acknowledges the situation.
 */
export class ClockGuard {
  suspect = false;
  message: string | undefined;
  private lastWall: number;
  private lastMono: number;

  constructor(
    private readonly wall: () => number,
    private readonly mono: () => number,
    private readonly onFlag: (message: string, blocking: boolean) => void,
    private readonly toleranceMs = 2000,
  ) {
    this.lastWall = wall();
    this.lastMono = mono();
  }

  check(): void {
    const w = this.wall();
    const m = this.mono();
    const drift = w - this.lastWall - (m - this.lastMono);
    this.lastWall = w;
    this.lastMono = m;
    if (Math.abs(drift) <= this.toleranceMs) return;
    const secs = Math.round(drift / 1000);
    if (drift < 0) {
      this.flag(`Host clock moved backwards by ${Math.abs(secs)}s. Attendance is paused until an administrator acknowledges this.`, true);
    } else {
      this.flag(`Host clock jumped forwards by ${secs}s (clock change or sleep/resume). Please verify the PC time.`, false);
    }
  }

  flag(message: string, blocking: boolean): void {
    if (blocking) this.suspect = true;
    this.message = message;
    this.onFlag(message, blocking);
  }

  acknowledge(): void {
    this.suspect = false;
    this.message = undefined;
    this.lastWall = this.wall();
    this.lastMono = this.mono();
  }
}
