import { b64u, canonicalJwk, signingMessage, type SigningParts } from '../../shared/protocol';
import type { PublicKeyJwk } from '../../shared/types';

/**
 * The phone's identity: an ECDSA P-256 key pair created by the browser. The private key is generated
 * non-extractable and lives only in this browser's IndexedDB; JavaScript can ask it to sign but can never read it.
 * Only the public key is ever sent to the office computer.
 */
export interface PendingRequest {
  requestId: string;
  pollSecret: string;
  employeeId: string;
  fullName: string;
  submittedAt: string;
}
export interface Enrollment {
  employeeId: string;
  fullName: string;
  enrolledAt: string;
}
export interface Identity {
  privateKey: CryptoKey;
  jwk: PublicKeyJwk;
  deviceId: string;
  createdAt: string;
  request?: PendingRequest;
  enrollment?: Enrollment;
}

const DB = 'pulse-device';
const STORE = 'kv';
const KEY = 'identity';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB unavailable'));
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error ?? new Error('IndexedDB write failed'));
      t.onabort = () => reject(t.error ?? new Error('IndexedDB write aborted'));
    });
  } finally {
    db.close();
  }
}

export async function deviceIdFromJwk(jwk: PublicKeyJwk): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJwk(jwk))));
  return 'dev_' + b64u.encode(digest.subarray(0, 16));
}

export const cryptoAvailable = () => typeof crypto !== 'undefined' && !!crypto.subtle && typeof indexedDB !== 'undefined';

export async function loadIdentity(): Promise<Identity | null> {
  const v = (await tx('readonly', (s) => s.get(KEY))) as Identity | undefined;
  return v ?? null;
}

export async function saveIdentity(id: Identity): Promise<void> {
  await tx('readwrite', (s) => s.put(id, KEY));
}

export async function createIdentity(): Promise<Identity> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const j = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  if (!j.x || !j.y) throw new Error('This browser could not create a device key.');
  const jwk: PublicKeyJwk = { kty: 'EC', crv: 'P-256', x: j.x, y: j.y };
  const id: Identity = { privateKey: pair.privateKey, jwk, deviceId: await deviceIdFromJwk(jwk), createdAt: new Date().toISOString() };
  await saveIdentity(id);
  return id;
}

export async function clearIdentity(): Promise<void> {
  await tx('readwrite', (s) => s.delete(KEY));
}

/** Signs the canonical PULSE message; returns an IEEE-P1363 (r‖s) signature, base64url. */
export async function sign(id: Identity, parts: Omit<SigningParts, 'deviceId'>): Promise<string> {
  const msg = signingMessage({ ...parts, deviceId: id.deviceId });
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, id.privateKey, new TextEncoder().encode(msg));
  return b64u.encode(new Uint8Array(sig));
}

export function randomNonce(): string {
  return b64u.encode(crypto.getRandomValues(new Uint8Array(12)));
}
