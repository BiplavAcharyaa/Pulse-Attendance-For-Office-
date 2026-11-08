import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { LiveEvent } from '../shared/types';
import { safeEqual } from './crypto';
import type { PulseService } from './service';

type Role = 'admin' | 'terminal';

interface Client {
  role: Role;
  token?: string;
  alive: boolean;
}

/**
 * Loopback-only WebSocket that streams live updates to the desktop dashboard and the reception display.
 * It is never reachable from the LAN (bound to 127.0.0.1) and requires a valid admin session token or the
 * per-run terminal key as its first message, plus an allow-listed Origin.
 */
export class AdminLiveServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Map<WebSocket, Client>();
  private timer: NodeJS.Timeout | null = null;
  port = 0;
  private listener: ((e: LiveEvent) => void) | null = null;

  constructor(
    private readonly svc: PulseService,
    private readonly allowedOrigins: string[],
  ) {}

  get clientCount(): number {
    return [...this.clients.values()].filter((c) => c.role === 'admin').length;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    this.server = http.createServer((_req, res) => res.writeHead(404).end());
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
    this.server.on('upgrade', (req, socket, head) => {
      const origin = req.headers.origin ?? '';
      const hostOk = req.headers.host === `127.0.0.1:${this.port}` || req.headers.host === `localhost:${this.port}`;
      const originOk = this.allowedOrigins.includes(origin);
      if (!hostOk || !originOk || this.clients.size >= 20) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    this.listener = (e) => this.broadcast(e);
    this.svc.bus.on('live', this.listener);
    this.timer = setInterval(() => this.sweep(), 15_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.listener) this.svc.bus.off('live', this.listener);
    if (this.timer) clearInterval(this.timer);
    for (const ws of this.clients.keys()) ws.terminate();
    this.clients.clear();
    this.wss?.close();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
    this.server = null;
  }

  private onConnection(ws: WebSocket): void {
    let client: Client | null = null;
    const t = setTimeout(() => {
      if (!client) ws.close(4001, 'auth timeout');
    }, 5000);
    ws.on('close', () => {
      clearTimeout(t);
      this.clients.delete(ws);
    });
    ws.on('error', () => ws.terminate());
    ws.on('pong', () => {
      if (client) client.alive = true;
    });
    ws.on('message', (raw) => {
      if (client) return;
      let msg: { type?: string; token?: string; terminalKey?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return ws.close(4000, 'bad message');
      }
      if (msg.type !== 'auth') return ws.close(4000, 'bad message');
      if (typeof msg.terminalKey === 'string' && safeEqual(msg.terminalKey, this.svc.terminalKey)) {
        client = { role: 'terminal', alive: true };
      } else if (typeof msg.token === 'string' && this.svc.adminAuth.isValid(msg.token)) {
        client = { role: 'admin', token: msg.token, alive: true };
      } else {
        ws.send(JSON.stringify({ type: 'error', code: 'UNAUTHENTICATED' }));
        return ws.close(4002, 'unauthenticated');
      }
      this.clients.set(ws, client);
      ws.send(JSON.stringify({ type: 'ready', role: client.role }));
      // Initial snapshot so the screen is correct immediately.
      ws.send(JSON.stringify({ type: 'event', event: { type: 'qr', data: this.svc.terminal.getCurrent() } }));
      ws.send(JSON.stringify({ type: 'event', event: { type: 'terminal.mode', data: { mode: this.svc.terminal.getMode() } } }));
    });
  }

  private sweep(): void {
    for (const [ws, c] of this.clients) {
      if (c.role === 'admin' && c.token && !this.svc.adminAuth.isValid(c.token)) {
        ws.close(4004, 'session expired');
        continue;
      }
      if (!c.alive) {
        ws.terminate();
        continue;
      }
      c.alive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }

  /** Terminal displays only see what a public screen should show. */
  private forTerminal(e: LiveEvent): LiveEvent | null {
    switch (e.type) {
      case 'qr':
      case 'terminal.mode':
      case 'registration.token':
        return e;
      case 'attendance.saved': {
        const showNames = this.svc.settings().terminalShowsNames;
        const name = showNames ? e.data.employeeName : e.data.employeeName.split(/\s+/).map((p) => p[0]?.toUpperCase() ?? '').join('');
        return {
          type: 'attendance.saved',
          data: { event: { ...e.data.event, employeeId: '', deviceId: '', remoteAddr: '', challengeId: '', idempotencyKey: undefined, prevHash: '', hash: '' }, employeeName: name, counts: e.data.counts },
        };
      }
      case 'attendance.rejected':
        return { type: 'attendance.rejected', data: { code: e.data.code, message: e.data.message, at: e.data.at } };
      default:
        return null;
    }
  }

  private broadcast(e: LiveEvent): void {
    if (this.clients.size === 0) return;
    const full = JSON.stringify({ type: 'event', event: e });
    let lite: string | null | undefined;
    for (const [ws, c] of this.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (c.role === 'admin') ws.send(full);
      else {
        if (lite === undefined) {
          const t = this.forTerminal(e);
          lite = t ? JSON.stringify({ type: 'event', event: t }) : null;
        }
        if (lite) ws.send(lite);
      }
    }
  }
}
