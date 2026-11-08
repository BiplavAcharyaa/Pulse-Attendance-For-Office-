import { webcrypto } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { b64u, parseScan, signingMessage } from '../src/shared/protocol';
import type { PublicKeyJwk, SessionInfo } from '../src/shared/types';
import { deviceIdFromJwk } from '../src/server/crypto';
import { PulseService, type ServiceOptions } from '../src/server/service';

export const subtle = webcrypto.subtle;

export interface TestHost {
  svc: PulseService;
  dir: string;
  clock: { t: number };
  session: SessionInfo;
  admin: (method: string, args?: unknown, token?: string) => Promise<any>;
  stop: () => Promise<void>;
  restart: () => Promise<TestHost>;
  attendanceToken: () => string;
}

/** Monday 2026-10-12 09:00 in Asia/Kathmandu (UTC+05:45) */
export const MONDAY_9AM = Date.parse('2026-10-12T03:15:00Z');

export async function startHost(opts: { dir?: string; t?: number; password?: string; keepSession?: boolean; extra?: Partial<ServiceOptions> } = {}): Promise<TestHost> {
  const dir = opts.dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'pulse-test-')));
  const clock = { t: opts.t ?? MONDAY_9AM };
  const svc = await PulseService.create({
    dir: undefined,
    dataDir: dir,
    now: () => clock.t,
    mono: () => clock.t,
    bindOverride: '127.0.0.1',
    httpsPortOverride: 0,
    setupPortOverride: 0,
    disableTimers: true,
    ...opts.extra,
  } as ServiceOptions);
  await svc.start();
  let session: SessionInfo;
  if (svc.adminAuth.needsSetup()) {
    session = await svc.adminAuth.setup({ username: 'owner', displayName: 'Owner One', password: opts.password ?? 'Correct-Horse-9' });
    await svc.updateSettings({ timezone: 'Asia/Kathmandu', minIntervalSeconds: 60 }, 'test');
  } else {
    session = await svc.adminAuth.login({ username: 'owner', password: opts.password ?? 'Correct-Horse-9' }, 'test');
  }
  const host: TestHost = {
    svc,
    dir,
    clock,
    session,
    async admin(method, args, token) {
      let r = await svc.admin.call(method, token ?? session.token, args);
      if (!token && !r.ok && r.error.code === 'SESSION_EXPIRED') {
        // The simulated clock jumps hours at a time; sign in again like a person would.
        session = await svc.adminAuth.login({ username: 'owner', password: opts.password ?? 'Correct-Horse-9' }, 'test');
        host.session = session;
        r = await svc.admin.call(method, session.token, args);
      }
      return r;
    },
    async stop() {
      await svc.stop();
    },
    async restart() {
      await svc.stop();
      return startHost({ dir, t: clock.t, extra: opts.extra });
    },
    attendanceToken() {
      const url = svc.terminal.rotate().url;
      const scan = parseScan(url);
      if (!scan || scan.kind !== 'attendance') throw new Error('terminal not in attendance mode');
      return scan.token;
    },
  };
  return host;
}

export async function must<T = any>(p: Promise<any>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.data as T;
}

export interface HttpResult {
  status: number;
  body: any;
  headers: Record<string, any>;
  raw: string;
}

export function request(
  svc: PulseService,
  method: string,
  p: string,
  body?: unknown,
  opts: { headers?: Record<string, string>; rawBody?: string; host?: string } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const payload = opts.rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = https.request(
      {
        host: '127.0.0.1',
        port: svc.http.httpsPort,
        method,
        path: p,
        ca: svc.tls.caCertPem,
        servername: 'localhost',
        headers: {
          Host: opts.host ?? `127.0.0.1:${svc.http.httpsPort}`,
          ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: any = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* not json */
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers, raw });
        });
      },
    );
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** A simulated enrolled phone: holds a P-256 key pair exactly like the browser app does. */
export class Phone {
  deviceId: string;
  requestId?: string;
  pollSecret?: string;

  private constructor(
    public svc: PulseService,
    private readonly keys: CryptoKeyPair,
    readonly jwk: PublicKeyJwk,
  ) {
    this.deviceId = deviceIdFromJwk(jwk);
  }

  static async create(svc: PulseService): Promise<Phone> {
    const keys = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const j = (await subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey;
    return new Phone(svc, keys, { kty: 'EC', crv: 'P-256', x: j.x!, y: j.y! });
  }

  async sign(message: string): Promise<string> {
    const sig = await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, new TextEncoder().encode(message));
    return b64u.encode(new Uint8Array(sig));
  }

  async register(token: string, who: { fullName: string; employeeId: string; phone: string }): Promise<HttpResult> {
    const r = await request(this.svc, 'POST', '/api/register', { token, ...who, publicKey: this.jwk, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile' });
    if (r.status === 200) {
      this.requestId = r.body.data.requestId;
      this.pollSecret = r.body.data.pollSecret;
    }
    return r;
  }

  async registrationStatus(): Promise<HttpResult> {
    return request(this.svc, 'POST', '/api/register/status', { requestId: this.requestId, pollSecret: this.pollSecret });
  }

  async status(): Promise<HttpResult> {
    const n = await request(this.svc, 'GET', '/api/device/nonce');
    const nonce = n.body.data.nonce as string;
    const signature = await this.sign(signingMessage({ purpose: 'status', hostId: this.svc.hostId, deviceId: this.deviceId, challenge: nonce }));
    return request(this.svc, 'POST', '/api/device/status', { deviceId: this.deviceId, nonce, signature });
  }

  async scanBody(token: string, intent: 'check-in' | 'check-out' | 'auto', clientNonce = b64u.encode(crypto.getRandomValues(new Uint8Array(12))), idempotencyKey?: string) {
    const signature = await this.sign(
      signingMessage({ purpose: 'attendance', hostId: this.svc.hostId, deviceId: this.deviceId, challenge: token, extra: `${intent}|${clientNonce}` }),
    );
    return { deviceId: this.deviceId, token, intent, clientNonce, signature, ...(idempotencyKey ? { idempotencyKey } : {}) };
  }

  async scan(token: string, intent: 'check-in' | 'check-out' | 'auto'): Promise<HttpResult> {
    return request(this.svc, 'POST', '/api/attendance', await this.scanBody(token, intent));
  }

  async serverNonce(): Promise<string> {
    const n = await request(this.svc, 'GET', '/api/device/nonce');
    return n.body.data.nonce as string;
  }

  async scanPermanent(token: string, intent: 'check-in' | 'check-out'): Promise<HttpResult> {
    return request(this.svc, 'POST', '/api/attendance', await this.scanBody(token, intent, await this.serverNonce()));
  }
}

/** Registers + approves an employee phone through the real HTTPS API and admin workflow. */
export async function enroll(host: TestHost, who: { fullName: string; employeeId: string; phone: string }): Promise<Phone> {
  const phone = await Phone.create(host.svc);
  await must(host.admin('terminal.setMode', { mode: 'registration' }));
  const regUrl = host.svc.terminal.getCurrent().url;
  const scan = parseScan(regUrl)!;
  const r = await phone.register(scan.token, who);
  host.svc.phone.resetRateLimits();
  if (r.status !== 200) throw new Error(`register failed: ${JSON.stringify(r.body)}`);
  await must(host.admin('requests.approve', { requestId: phone.requestId }));
  await must(host.admin('terminal.setMode', { mode: 'attendance' }));
  return phone;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
