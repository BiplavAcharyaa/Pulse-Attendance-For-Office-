import { createHash, createHmac, createPublicKey, randomBytes, scrypt, timingSafeEqual, verify as nodeVerify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { b64u, canonicalJwk } from '../shared/protocol';
import type { PublicKeyJwk } from '../shared/types';

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function deviceIdFromJwk(jwk: PublicKeyJwk): string {
  const digest = createHash('sha256').update(canonicalJwk(jwk)).digest();
  return 'dev_' + b64u.encode(digest.subarray(0, 16));
}

const keyCache = new Map<string, KeyObject>();

/** Throws if the JWK is not a valid point on P-256. */
export function importPublicKey(jwk: PublicKeyJwk): KeyObject {
  const id = deviceIdFromJwk(jwk);
  let k = keyCache.get(id);
  if (!k) {
    k = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, format: 'jwk' });
    if (keyCache.size > 2000) keyCache.clear();
    keyCache.set(id, k);
  }
  return k;
}

/** Verifies a WebCrypto ECDSA P-256/SHA-256 signature (IEEE-P1363 r||s, base64url). */
export function verifyDeviceSignature(jwk: PublicKeyJwk, message: string, signatureB64u: string): boolean {
  try {
    const sig = Buffer.from(b64u.decode(signatureB64u));
    if (sig.length !== 64) return false;
    return nodeVerify('sha256', Buffer.from(message, 'utf8'), { key: importPublicKey(jwk), dsaEncoding: 'ieee-p1363' }, sig);
  } catch {
    return false;
  }
}

export function hmacB64u(key: Buffer, data: string, bytes = 16): string {
  return createHmac('sha256', key).update(data).digest().subarray(0, bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ───────────── Password hashing (scrypt, per-user random salt) ─────────────
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

function scryptAsync(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, 32, { N: n, r, p, maxmem: 256 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts;
  try {
    const key = await scryptAsync(password, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
    const expected = Buffer.from(hash, 'base64url');
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('at least 12 characters');
  if (password.length > 128) problems.push('at most 128 characters');
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) problems.push('upper- and lower-case letters');
  if (!/[0-9]/.test(password)) problems.push('a digit');
  return problems;
}
