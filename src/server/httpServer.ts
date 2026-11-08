import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { LiveEvent } from '../shared/types';
import { PulseError } from './errors';
import { normalizeIp } from './netpolicy';
import type { PulseService } from './service';
import type { TlsMaterial } from './tls';

const MAX_BODY = 8 * 1024;
const MAX_WS_TOTAL = 300;
const MAX_WS_PER_IP = 12;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

interface WsState {
  authed: boolean;
  alive: boolean;
  ip: string;
  deviceId?: string;
  requestId?: string;
}

export class PhoneHttpServer {
  httpsPort = 0;
  setupPort = 0;
  listening = false;
  private httpsServer: https.Server | null = null;
  private setupServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private tls: TlsMaterial | null = null;
  private address = '127.0.0.1';
  private readonly sockets = new Map<WebSocket, WsState>();
  private heartbeat: NodeJS.Timeout | null = null;
  private busListener: ((e: LiveEvent) => void) | null = null;

  constructor(
    private readonly svc: PulseService,
    private readonly webRoot?: string,
  ) {}

  get wsClientCount(): number {
    return this.sockets.size;
  }

  // ───────────── lifecycle ─────────────
  async start(opts: { address: string; httpsPort: number; setupPort: number; tls: TlsMaterial }): Promise<void> {
    this.tls = opts.tls;
    this.address = opts.address;
    this.httpsServer = https.createServer(
      { key: opts.tls.leafKeyPem, cert: opts.tls.leafCertPem + opts.tls.caCertPem, minVersion: 'TLSv1.2' },
      (req, res) => void this.handle(req, res),
    );
    this.httpsServer.requestTimeout = 15_000;
    this.httpsServer.headersTimeout = 10_000;
    this.httpsServer.keepAliveTimeout = 5_000;
    this.httpsServer.maxHeadersCount = 40;
    this.httpsServer.on('upgrade', (req, socket, head) => void this.upgrade(req, socket as Duplex, head));
    this.httpsServer.on('tlsClientError', () => undefined);
    this.httpsServer.on('clientError', (_e, sock) => sock.destroy());

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, normalizeIp(req.socket.remoteAddress)));

    await this.listen(this.httpsServer, opts.address, opts.httpsPort, 'HTTPS');
    this.httpsPort = (this.httpsServer.address() as AddressInfo).port;

    try {
      this.setupServer = http.createServer((req, res) => void this.handleSetup(req, res));
      this.setupServer.requestTimeout = 10_000;
      await this.listen(this.setupServer, opts.address, opts.setupPort, 'setup HTTP');
      this.setupPort = (this.setupServer.address() as AddressInfo).port;
    } catch (e) {
      // The trust-bootstrap page is a convenience; the attendance service must still run without it.
      console.error('[pulse] setup page unavailable:', (e as Error).message);
      this.setupServer = null;
      this.setupPort = 0;
    }

    this.busListener = (e) => this.onLive(e);
    this.svc.bus.on('live', this.busListener);
    this.heartbeat = setInterval(() => this.pingAll(), 25_000);
    this.heartbeat.unref?.();
    this.listening = true;
  }

  private listen(server: http.Server | https.Server, host: string, port: number, label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => {
        reject(new Error(e.code === 'EADDRINUSE' ? `${label} port ${port} on ${host} is already in use. Change the port in Settings or close the other program.` : `${label} server failed: ${e.message}`));
      };
      server.once('error', onError);
      server.listen({ host, port }, () => {
        server.off('error', onError);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.listening = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.busListener) this.svc.bus.off('live', this.busListener);
    this.busListener = null;
    for (const ws of this.sockets.keys()) ws.terminate();
    this.sockets.clear();
    this.wss?.close();
    this.wss = null;
    const close = (s: http.Server | https.Server | null) =>
      new Promise<void>((resolve) => {
        if (!s) return resolve();
        s.closeAllConnections?.();
        s.close(() => resolve());
      });
    await Promise.all([close(this.httpsServer), close(this.setupServer)]);
    this.httpsServer = null;
    this.setupServer = null;
  }

  // ───────────── request handling ─────────────
  private allowedHost(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
    const s = this.svc.settings();
    const names = new Set<string>(['localhost', '127.0.0.1', this.address.toLowerCase(), os.hostname().toLowerCase(), ...s.hostnames.map((h) => h.toLowerCase()), ...(this.tls?.names ?? []).map((n) => n.toLowerCase())]);
    return names.has(host);
  }

  private baseHeaders(): Record<string, string> {
    return {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    };
  }

  private json(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { ...this.baseHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(text);
  }

  private sendError(res: http.ServerResponse, e: unknown): void {
    if (e instanceof PulseError) {
      if (e.status === 413) {
        res.setHeader('Connection', 'close');
        res.once('finish', () => res.req.destroy());
      }
      const retry: Record<string, string> = typeof e.details?.retryAfterMs === 'number' ? { 'Retry-After': String(Math.ceil((e.details.retryAfterMs as number) / 1000)) } : {};
      return this.json(res, e.status, { ok: false, error: { code: e.code, message: e.message, retryAfterMs: e.details?.retryAfterMs } }, retry);
    }
    console.error('[pulse] unexpected error:', e);
    this.json(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong on the office computer. Attendance was NOT recorded.' } });
  }

  private readBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ct = req.headers['content-type'] ?? '';
      if (!/^application\/json\b/i.test(ct)) return reject(new PulseError('BAD_REQUEST', 'Expected application/json', 415));
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          if (size - c.length <= MAX_BODY) reject(new PulseError('BAD_REQUEST', 'Request too large', 413));
          return; // keep draining without buffering; the socket is closed after the 413 is sent
        }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new PulseError('BAD_REQUEST', 'Invalid JSON', 400));
        }
      });
      req.on('error', () => reject(new PulseError('BAD_REQUEST', 'Request aborted', 400)));
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ip = normalizeIp(req.socket.remoteAddress);
    try {
      if (!this.svc.netPolicy.allows(ip)) {
        await this.svc.audit.recordThrottled(`netdeny:${ip}`, { type: 'security.network-denied', severity: 'warning', actor: 'anonymous', summary: `Request from ${ip} refused by the network policy`, details: { ip } });
        res.writeHead(403, this.baseHeaders()).end('Forbidden');
        return;
      }
      if (!this.allowedHost(req.headers.host)) {
        res.writeHead(421, this.baseHeaders()).end('Unknown host name');
        return;
      }
      const url = new URL(req.url ?? '/', 'https://pulse.invalid');
      const p = url.pathname;
      const method = req.method ?? 'GET';
      const rc = { ip };

      if (p.startsWith('/api/')) {
        if (method === 'GET' && p === '/api/info') return this.json(res, 200, { ok: true, data: this.svc.phone.info() });
        if (method === 'GET' && p === '/api/device/nonce') return this.json(res, 200, { ok: true, data: await this.svc.phone.nonce(rc) });
        if (method !== 'POST') return this.json(res, 405, { ok: false, error: { code: 'METHOD', message: 'Method not allowed' } }, { Allow: 'POST' });
        const body = await this.readBody(req);
        switch (p) {
          case '/api/register/peek': return this.json(res, 200, { ok: true, data: await this.svc.phone.peekRegistration(body, rc) });
          case '/api/register': return this.json(res, 200, { ok: true, data: await this.svc.phone.register(body, rc) });
          case '/api/register/status': return this.json(res, 200, { ok: true, data: await this.svc.phone.registrationStatus(body, rc) });
          case '/api/device/status': return this.json(res, 200, { ok: true, data: await this.svc.phone.deviceStatus(body, rc) });
          case '/api/attendance': return this.json(res, 200, { ok: true, data: await this.svc.phone.submitAttendance(body, rc) });
          default: return this.json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown endpoint' } });
        }
      }

      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { ...this.baseHeaders(), Allow: 'GET, HEAD' }).end();
        return;
      }
      if (p === '/pulse-ca.crt' || p === '/pulse-ca.pem') return this.sendCa(res, p.endsWith('.pem'));
      await this.serveStatic(p, req, res);
    } catch (e) {
      this.sendError(res, e);
    }
  }

  private sendCa(res: http.ServerResponse, pem: boolean): void {
    if (!this.tls) {
      res.writeHead(503).end();
      return;
    }
    const body = pem ? Buffer.from(this.tls.caCertPem) : this.tls.caCertDer;
    res.writeHead(200, {
      ...this.baseHeaders(),
      'Content-Type': pem ? 'application/x-pem-file' : 'application/x-x509-ca-cert',
      'Content-Disposition': `attachment; filename="${pem ? 'pulse-ca.pem' : 'pulse-ca.crt'}"`,
      'Cache-Control': 'no-store',
      'Content-Length': String(body.length),
    });
    res.end(body);
  }

  private async serveStatic(p: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.webRoot) {
      res.writeHead(503, this.baseHeaders()).end('The mobile app has not been built. Run "npm run build".');
      return;
    }
    let rel: string;
    if (p === '/' || p === '/index.html' || p === '/m' || p === '/m/' || p === '/mobile.html') rel = 'mobile.html';
    else rel = decodeURIComponent(p).replace(/^\/+/, '');
    const ext = path.extname(rel).toLowerCase();
    if (!MIME[ext] || rel === 'index.html' || rel.includes('\0')) {
      res.writeHead(404, this.baseHeaders()).end('Not found');
      return;
    }
    const root = path.resolve(this.webRoot);
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep)) {
      res.writeHead(404, this.baseHeaders()).end('Not found');
      return;
    }
    let data: Buffer;
    try {
      data = await fs.readFile(full);
    } catch {
      res.writeHead(404, this.baseHeaders()).end('Not found');
      return;
    }
    const headers: Record<string, string> = { ...this.baseHeaders(), 'Content-Type': MIME[ext], 'Content-Length': String(data.length) };
    if (ext === '.html') {
      const host = (req.headers.host ?? '').replace(/[^A-Za-z0-9.:\-\[\]]/g, '');
      headers['Content-Security-Policy'] = `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self' wss://${host}; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
      headers['Cache-Control'] = 'no-cache';
    } else {
      headers['Cache-Control'] = rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  // ───────────── trust-bootstrap page (plain HTTP, CA download only) ─────────────
  private async handleSetup(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ip = normalizeIp(req.socket.remoteAddress);
    if (!this.svc.netPolicy.allows(ip) || !this.allowedHost(req.headers.host)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const p = new URL(req.url ?? '/', 'http://pulse.invalid').pathname;
    if (req.method !== 'GET') return void res.writeHead(405).end();
    if (p === '/pulse-ca.crt' || p === '/pulse-ca.pem') return this.sendCa(res, p.endsWith('.pem'));
    if (p !== '/') return void res.writeHead(404).end('Not found');
    const s = this.svc.settings();
    const httpsUrl = this.svc.baseUrl();
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PULSE phone setup</title>
<style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#fff;color:#1a1a1f}main{max-width:560px;margin:0 auto;padding:24px 18px 48px}h1{font-size:22px;color:#111114;margin:8px 0 4px}h2{font-size:16px;color:#111114;margin:24px 0 6px}p,li{color:#4a4a55}a.btn{display:inline-block;background:#d4101f;color:#fff;text-decoration:none;padding:12px 16px;border-radius:10px;font-weight:600;margin:6px 8px 6px 0}code{background:#fdecee;padding:2px 6px;border-radius:6px;word-break:break-all}.card{background:#fff;border:1px solid #ececf0;border-radius:14px;padding:16px;margin-top:14px}</style></head><body><main>
<h1>PULSE phone setup</h1><p>${esc(s.orgName)} · one-time setup so your phone trusts the office attendance system and can use the camera.</p>
<div class="card"><h2>Step 1 — install the office certificate</h2><a class="btn" href="/pulse-ca.crt">Download certificate</a><a class="btn" style="background:#111114" href="/pulse-ca.pem">PEM format</a>
<p><b>Android:</b> Settings → Security → Encryption &amp; credentials → Install a certificate → <b>CA certificate</b> → choose the downloaded file.</p>
<p><b>iPhone / iPad:</b> open the downloaded profile in Settings → "Profile Downloaded" → Install. Then Settings → General → About → Certificate Trust Settings → enable full trust for <b>PULSE Local CA</b>.</p>
<p>Check the fingerprint (SHA-256) matches the one on the office screen / administrator dashboard:<br><code>${esc(this.tls?.caFingerprint ?? '')}</code></p></div>
<div class="card"><h2>Step 2 — open the attendance page</h2><a class="btn" href="${esc(httpsUrl)}">Open PULSE attendance</a><p>Address: <code>${esc(httpsUrl)}</code></p>
<p>Save it to your home screen (Share → Add to Home Screen on iPhone; ⋮ → Add to Home screen on Android). On iPhone this also keeps your phone registration from being cleared.</p></div>
</main></body></html>`;
    res.writeHead(200, { ...this.baseHeaders(), 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" });
    res.end(html);
  }

  // ───────────── WebSocket (phones) ─────────────
  private async upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const ip = normalizeIp((req.socket as { remoteAddress?: string }).remoteAddress);
    const reject = (code: number, text: string) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const url = new URL(req.url ?? '/', 'https://pulse.invalid');
    if (url.pathname !== '/ws') return reject(404, 'Not Found');
    if (!this.svc.netPolicy.allows(ip)) return reject(403, 'Forbidden');
    if (!this.allowedHost(req.headers.host)) return reject(421, 'Misdirected Request');
    const origin = req.headers.origin;
    if (origin && origin !== `https://${req.headers.host}`) return reject(403, 'Forbidden');
    const perIp = [...this.sockets.values()].filter((s) => s.ip === ip).length;
    if (this.sockets.size >= MAX_WS_TOTAL || perIp >= MAX_WS_PER_IP) return reject(429, 'Too Many Requests');
    this.wss!.handleUpgrade(req, socket, head, (ws) => this.wss!.emit('connection', ws, req));
  }

  private onConnection(ws: WebSocket, ip: string): void {
    const state: WsState = { authed: false, alive: true, ip };
    this.sockets.set(ws, state);
    const authTimer = setTimeout(() => {
      if (!state.authed) ws.close(4001, 'auth timeout');
    }, 5000);
    ws.on('pong', () => (state.alive = true));
    ws.on('close', () => {
      clearTimeout(authTimer);
      this.sockets.delete(ws);
    });
    ws.on('error', () => ws.terminate());
    ws.on('message', (raw) => {
      void (async () => {
        let msg: { type?: string } & Record<string, unknown>;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return ws.close(4000, 'bad message');
        }
        if (state.authed) {
          if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', serverTime: new Date(this.svc.now()).toISOString() }));
          return;
        }
        try {
          if (msg.type === 'hello') {
            const dev = await this.svc.phone.authenticateLive(msg, { ip });
            state.authed = true;
            state.deviceId = dev.deviceId;
            ws.send(JSON.stringify({ type: 'ready', serverTime: new Date(this.svc.now()).toISOString() }));
          } else if (msg.type === 'watch') {
            const status = await this.svc.phone.registrationStatus(msg, { ip });
            state.authed = true;
            state.requestId = String(msg.requestId);
            ws.send(JSON.stringify({ type: 'registration', ...status }));
          } else {
            ws.close(4000, 'bad message');
          }
        } catch (e) {
          const pe = e instanceof PulseError ? e : new PulseError('INTERNAL', 'Error', 500);
          ws.send(JSON.stringify({ type: 'error', code: pe.code, message: pe.message }));
          ws.close(4002, pe.code);
        }
      })();
    });
  }

  private pingAll(): void {
    for (const [ws, st] of this.sockets) {
      if (!st.alive) {
        ws.terminate();
        continue;
      }
      st.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }

  private sendTo(filter: (s: WsState) => boolean, payload: unknown): void {
    const text = JSON.stringify(payload);
    for (const [ws, st] of this.sockets) if (st.authed && filter(st) && ws.readyState === WebSocket.OPEN) ws.send(text);
  }

  private onLive(e: LiveEvent): void {
    if (this.sockets.size === 0) return;
    switch (e.type) {
      case 'request.decided': {
        const id = e.data.requestId;
        this.sendTo((s) => s.requestId === id, { type: 'registration-changed' });
        break;
      }
      case 'approval.requested':
      case 'approval.decided':
      case 'attendance.saved':
      case 'correction.saved': {
        const empId = e.type === 'attendance.saved' ? e.data.event.employeeId : e.data.employeeId;
        this.sendTo((s) => !!s.deviceId && this.svc.devices.getDevice(s.deviceId)?.employeeId === empId, { type: 'attendance-changed' });
        break;
      }
      case 'device.changed': {
        if (e.data.status !== 'revoked') break;
        for (const [ws, st] of this.sockets) {
          if (st.deviceId === e.data.deviceId) {
            ws.send(JSON.stringify({ type: 'revoked' }));
            ws.close(4003, 'revoked');
          }
        }
        break;
      }
      default:
        break;
    }
  }
}
