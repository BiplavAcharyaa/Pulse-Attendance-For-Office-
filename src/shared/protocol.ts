// Wire-protocol helpers shared by the host (Node) and the phone (browser).
// Only uses globals available in both: btoa/atob, TextEncoder.

export const PROTOCOL = 'PULSE/1';

export type SignPurpose = 'attendance' | 'status' | 'live';

export const b64u = {
  encode(bytes: Uint8Array): string {
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(s: string): Uint8Array {
    const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

export interface SigningParts {
  purpose: SignPurpose;
  hostId: string;
  deviceId: string;
  challenge: string; // QR token (attendance) or server nonce (status / live)
  extra?: string; // attendance: "<intent>|<clientNonce>"
}

/** Canonical byte string that a phone signs and the host re-derives. */
export function signingMessage(p: SigningParts): string {
  return [PROTOCOL, p.purpose, p.hostId, p.deviceId, p.challenge, p.extra ?? ''].join('\n');
}

/** Canonical JSON of a public JWK, used to derive the device ID on both sides. */
export function canonicalJwk(jwk: { kty: string; crv: string; x: string; y: string }): string {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

export const ATTENDANCE_TOKEN_PREFIX = 'PL1';
export const PERMANENT_TOKEN_PREFIX = 'PP1';
export const REGISTRATION_TOKEN_PREFIX = 'PR1';

export function isPermanentToken(token: string): boolean {
  return token.startsWith(`${PERMANENT_TOKEN_PREFIX}.`);
}

export interface ParsedScan {
  kind: 'attendance' | 'registration';
  token: string;
}

/**
 * Extracts a PULSE token from whatever a QR contained: a URL such as
 * https://host:8443/#a=PL1.… , or the bare token.
 */
export function parseScan(text: string): ParsedScan | null {
  const raw = text.trim();
  if (raw.length > 400) return null;
  let candidate = raw;
  const hashIdx = raw.indexOf('#');
  if (hashIdx >= 0) {
    const params = new URLSearchParams(raw.slice(hashIdx + 1));
    candidate = params.get('a') ?? params.get('r') ?? '';
  }
  if (/^PL1\.[A-Za-z0-9_.-]+$/.test(candidate)) return { kind: 'attendance', token: candidate };
  if (/^PP1\.[A-Za-z0-9_.-]+$/.test(candidate)) return { kind: 'attendance', token: candidate };
  if (/^PR1\.[A-Za-z0-9_.-]+$/.test(candidate)) return { kind: 'registration', token: candidate };
  return null;
}

export const ERROR_MESSAGES: Record<string, string> = {
  QR_EXPIRED: 'That QR code has expired. Scan the code currently shown on the office screen.',
  QR_INVALID: 'This is not a valid PULSE attendance code.',
  QR_INACTIVE: 'This QR code is not in use right now. Scan the code currently shown on the office screen.',
  NONCE_INVALID: 'Phone verification expired. Please scan again.',
  DEVICE_UNKNOWN: 'This phone is not registered with this office system.',
  DEVICE_REVOKED: 'This phone has been revoked by an administrator.',
  EMPLOYEE_INACTIVE: 'Your employee profile is inactive. Please contact an administrator.',
  SIGNATURE_INVALID: 'Phone verification failed. Please try again.',
  REPLAY: 'This scan was already used. Scan the code currently shown on the office screen.',
  NETWORK_DENIED: 'Attendance can only be recorded from the office network.',
  ALREADY_CHECKED_IN: 'You are already checked in.',
  NOT_CHECKED_IN: 'You have no open check-in to close.',
  DAY_COMPLETE: 'Your attendance for today is already complete.',
  TOO_SOON: 'Please wait a moment before recording another event.',
  TOO_EARLY: 'Check-in is not open yet.',
  NO_SHIFT_OPEN: 'Check-in is not open for any shift right now.',
  CHECKOUT_NOT_OPEN: 'Check-out is not open yet.',
  APPROVAL_PENDING: 'Your late check-in is waiting for administrator approval. Nothing more is needed from you.',
  APPROVAL_REJECTED: 'An administrator did not approve your late check-in for this shift. Please speak to them.',
  SHIFT_AMBIGUOUS: 'The shift could not be determined from the current time. Please contact an administrator. Nothing was recorded.',
  RATE_LIMITED: 'Too many attempts. Please wait a moment and try again.',
  STORAGE_FULL: 'The office computer has no free disk space. Attendance was NOT recorded.',
  STORAGE_ERROR: 'The office computer could not save the record. Attendance was NOT recorded.',
  CLOCK_SUSPECT: 'The office computer clock needs administrator attention. Attendance was NOT recorded.',
  BAD_REQUEST: 'The request was not understood.',
  INTERNAL: 'Something went wrong on the office computer. Attendance was NOT recorded.',
};
