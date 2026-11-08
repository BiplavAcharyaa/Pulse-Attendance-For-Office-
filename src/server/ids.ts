import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32

function encodeTime(ms: number): string {
  let out = '';
  let n = ms;
  for (let i = 0; i < 10; i++) {
    out = ALPHABET[n % 32] + out;
    n = Math.floor(n / 32);
  }
  return out;
}

function randomPart(len: number): string {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % 32];
  return out;
}

/** Time-sortable unique ID: prefix_TTTTTTTTTTRRRRRRRRRRRR */
export function newId(prefix: string, nowMs: number = Date.now()): string {
  return `${prefix}_${encodeTime(nowMs)}${randomPart(12)}`;
}

export function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}
