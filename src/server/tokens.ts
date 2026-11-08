import { randomBytes } from 'node:crypto';
import { ATTENDANCE_TOKEN_PREFIX, REGISTRATION_TOKEN_PREFIX } from '../shared/protocol';
import type { RequestType } from '../shared/types';
import { hmacB64u, safeEqual } from './crypto';

export type ChallengeVerdict =
  | { ok: true; cid: string; iat: number }
  | { ok: false; code: 'QR_INVALID' | 'QR_EXPIRED' };

/**
 * Issues and verifies the short-lived, HMAC-signed challenges shown in the rotating attendance QR.
 * Token layout: PL1.<hostId>.<challengeId>.<issuedAt base36 ms>.<mac>
 * It carries no personal data and no secret — the MAC is derived from a host-only key.
 */
export class ChallengeAuthority {
  constructor(
    private readonly key: Buffer,
    private readonly hostId: string,
    /** Challenges issued by an earlier process run are never accepted (restart replay protection). */
    private readonly notBeforeMs: number,
  ) {}

  issue(nowMs: number): { token: string; cid: string; iat: number } {
    const cid = randomBytes(12).toString('base64url');
    const head = `${ATTENDANCE_TOKEN_PREFIX}.${this.hostId}.${cid}.${nowMs.toString(36)}`;
    return { token: `${head}.${hmacB64u(this.key, head)}`, cid, iat: nowMs };
  }

  verify(token: string, nowMs: number, windowMs: number): ChallengeVerdict {
    const parts = token.split('.');
    if (parts.length !== 5 || parts[0] !== ATTENDANCE_TOKEN_PREFIX || parts[1] !== this.hostId) return { ok: false, code: 'QR_INVALID' };
    const head = parts.slice(0, 4).join('.');
    if (!safeEqual(hmacB64u(this.key, head), parts[4])) return { ok: false, code: 'QR_INVALID' };
    const iat = parseInt(parts[3], 36);
    if (!Number.isFinite(iat)) return { ok: false, code: 'QR_INVALID' };
    if (iat > nowMs + 1000) return { ok: false, code: 'QR_INVALID' }; // from the future: not ours
    if (iat < this.notBeforeMs) return { ok: false, code: 'QR_EXPIRED' };
    if (nowMs - iat > windowMs) return { ok: false, code: 'QR_EXPIRED' };
    return { ok: true, cid: parts[2], iat };
  }
}

/** Remembers one-time values (challenge×device pairs, client nonces, server nonces) until they expire. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(private readonly maxEntries = 50_000) {}

  /** Returns false if the key was already seen (replay). */
  claim(key: string, nowMs: number, ttlMs: number): boolean {
    this.sweep(nowMs);
    if (this.seen.has(key)) return false;
    this.seen.set(key, nowMs + ttlMs);
    return true;
  }

  release(key: string): void {
    this.seen.delete(key);
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  private sweep(nowMs: number): void {
    if (this.seen.size < 256 && this.seen.size < this.maxEntries) return;
    for (const [k, exp] of this.seen) if (exp <= nowMs) this.seen.delete(k);
    if (this.seen.size > this.maxEntries) {
      const drop = this.seen.size - this.maxEntries;
      let i = 0;
      for (const k of this.seen.keys()) {
        this.seen.delete(k);
        if (++i >= drop) break;
      }
    }
  }
}

/** Server-issued single-use nonces for signed status / live-socket requests. */
export class NonceStore {
  private readonly nonces = new Map<string, number>();

  issue(nowMs: number, ttlMs = 30_000): { nonce: string; expiresAt: number } {
    this.sweep(nowMs);
    const nonce = randomBytes(18).toString('base64url');
    this.nonces.set(nonce, nowMs + ttlMs);
    return { nonce, expiresAt: nowMs + ttlMs };
  }

  /** Consumes the nonce (single use). */
  consume(nonce: string, nowMs: number): boolean {
    const exp = this.nonces.get(nonce);
    if (exp === undefined) return false;
    this.nonces.delete(nonce);
    return exp > nowMs;
  }

  private sweep(nowMs: number): void {
    if (this.nonces.size < 500) return;
    for (const [k, exp] of this.nonces) if (exp <= nowMs) this.nonces.delete(k);
    if (this.nonces.size > 5000) this.nonces.clear();
  }
}

export interface RegistrationTokenRecord {
  tid: string;
  type: RequestType;
  employeeId?: string; // set for replacement enrollment
  issuedBy: string;
  issuedAt: number;
  expiresAt: number;
  usedAt?: number;
}

/** One-time registration QR tokens created through an administrator-authorized workflow. */
export class RegistrationTokens {
  private readonly tokens = new Map<string, RegistrationTokenRecord>();

  constructor(
    private readonly key: Buffer,
    private readonly hostId: string,
  ) {}

  issue(input: { type: RequestType; employeeId?: string; issuedBy: string; nowMs: number; ttlMs: number }): { token: string; record: RegistrationTokenRecord } {
    this.sweep(input.nowMs);
    const tid = randomBytes(16).toString('base64url');
    const head = `${REGISTRATION_TOKEN_PREFIX}.${this.hostId}.${tid}`;
    const record: RegistrationTokenRecord = {
      tid,
      type: input.type,
      employeeId: input.employeeId,
      issuedBy: input.issuedBy,
      issuedAt: input.nowMs,
      expiresAt: input.nowMs + input.ttlMs,
    };
    this.tokens.set(tid, record);
    return { token: `${head}.${hmacB64u(this.key, head)}`, record };
  }

  private lookup(token: string): RegistrationTokenRecord | null {
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== REGISTRATION_TOKEN_PREFIX || parts[1] !== this.hostId) return null;
    if (!safeEqual(hmacB64u(this.key, parts.slice(0, 3).join('.')), parts[3])) return null;
    return this.tokens.get(parts[2]) ?? null;
  }

  /** Validates and burns the token. */
  consume(token: string, nowMs: number): { ok: true; record: RegistrationTokenRecord } | { ok: false; reason: 'invalid' | 'expired' | 'used' } {
    const rec = this.lookup(token);
    if (!rec) return { ok: false, reason: 'invalid' };
    if (rec.usedAt) return { ok: false, reason: 'used' };
    if (rec.expiresAt <= nowMs) return { ok: false, reason: 'expired' };
    rec.usedAt = nowMs;
    return { ok: true, record: rec };
  }

  /** Validates without burning (used to show which employee a replacement token belongs to). */
  peek(token: string, nowMs: number): { ok: true; record: RegistrationTokenRecord } | { ok: false; reason: 'invalid' | 'expired' | 'used' } {
    const rec = this.lookup(token);
    if (!rec) return { ok: false, reason: 'invalid' };
    if (rec.usedAt) return { ok: false, reason: 'used' };
    if (rec.expiresAt <= nowMs) return { ok: false, reason: 'expired' };
    return { ok: true, record: rec };
  }

  /** Puts a consumed token back (used when the request failed validation after consumption). */
  restore(tid: string): void {
    const rec = this.tokens.get(tid);
    if (rec) rec.usedAt = undefined;
  }

  revokeAll(): void {
    this.tokens.clear();
  }

  private sweep(nowMs: number): void {
    for (const [k, r] of this.tokens) if (r.expiresAt + 60_000 < nowMs) this.tokens.delete(k);
  }
}
