import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AdminRole, AdminView, ExportStatus, HostHealth, LiveEvent, TerminalMode, TerminalQr } from '../../shared/types';

export class ApiFail extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const RANK: Record<AdminRole, string[]> = {
  owner: ['read', 'export', 'write', 'settings', 'admins'],
  admin: ['read', 'export', 'write'],
  auditor: ['read', 'export'],
};

interface AuthState {
  token: string;
  admin: AdminView;
}

interface Ctx {
  auth: AuthState | null;
  signIn: (s: { token: string; admin: AdminView }) => void;
  signOut: () => void;
  call: <T = any>(method: string, args?: unknown) => Promise<T>;
  can: (perm: 'read' | 'export' | 'write' | 'settings' | 'admins') => boolean;
}

const AuthContext = createContext<Ctx>(null as unknown as Ctx);
export const useAuth = () => useContext(AuthContext);

/** Public calls (no session): status, setup, login. */
export async function publicCall<T = any>(method: string, args?: unknown): Promise<T> {
  const r = await window.pulse.call(method, undefined, args);
  if (!r.ok) throw new ApiFail(r.error.code, r.error.message);
  return r.data as T;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const authRef = useRef<AuthState | null>(null);
  authRef.current = auth;

  const signOut = useCallback(() => {
    const t = authRef.current?.token;
    setAuth(null);
    if (t) void window.pulse.call('auth.logout', t);
  }, []);

  const call = useCallback(
    async <T,>(method: string, args?: unknown): Promise<T> => {
      const t = authRef.current?.token;
      const r = await window.pulse.call(method, t, args);
      if (!r.ok) {
        if (r.error.code === 'UNAUTHENTICATED' || r.error.code === 'SESSION_EXPIRED') setAuth(null);
        throw new ApiFail(r.error.code, r.error.message);
      }
      return r.data as T;
    },
    [],
  );

  const value = useMemo<Ctx>(
    () => ({
      auth,
      signIn: (s) => setAuth(s),
      signOut,
      call,
      can: (perm) => !!auth && RANK[auth.admin.role].includes(perm),
    }),
    [auth, signOut, call],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ───────────── live channel ─────────────
export interface LiveState {
  status: 'connecting' | 'live' | 'offline';
  qr: TerminalQr | null;
  skew: number; // host clock − local clock (ms), so countdowns follow the host
  mode: TerminalMode;
  health: HostHealth | null;
  exportStatus: ExportStatus | null;
  lastRejected: { code: string; message: string; at: string } | null;
  lastSaved: { name: string; kind: string; local: string; classification: string; warned: boolean; at: number } | null;
  feed: Array<{ id: string; name: string; kind: string; local: string; classification: string; warned: boolean }>;
}

type Listener = (e: LiveEvent) => void;

interface LiveCtx extends LiveState {
  subscribe: (fn: Listener) => () => void;
}
const LiveContext = createContext<LiveCtx>(null as unknown as LiveCtx);
export const useLive = () => useContext(LiveContext);

const INITIAL: LiveState = { status: 'connecting', qr: null, skew: 0, mode: 'attendance', health: null, exportStatus: null, lastRejected: null, lastSaved: null, feed: [] };

export function LiveProvider({ children, role }: { children: ReactNode; role: 'admin' | 'terminal' }) {
  const { auth, call } = useAuth();
  const [state, setState] = useState<LiveState>(INITIAL);
  const listeners = useRef(new Set<Listener>());
  const token = auth?.token;

  const subscribe = useCallback((fn: Listener) => {
    listeners.current.add(fn);
    return () => listeners.current.delete(fn);
  }, []);

  useEffect(() => {
    if (role === 'admin' && !token) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const apply = (e: LiveEvent) => {
      setState((s) => {
        switch (e.type) {
          case 'qr':
            return { ...s, qr: e.data, skew: e.data.hostTime - Date.now(), mode: e.data.mode };
          case 'terminal.mode':
            return { ...s, mode: e.data.mode };
          case 'health':
            return { ...s, health: e.data };
          case 'export.progress':
            return { ...s, exportStatus: e.data };
          case 'attendance.rejected':
            return { ...s, lastRejected: { code: e.data.code, message: e.data.message, at: e.data.at }, lastSaved: null };
          case 'attendance.saved': {
            const ev = e.data.event;
            const item = { id: ev.id, name: e.data.employeeName, kind: ev.kind, local: ev.localTime.slice(0, 5), classification: ev.classification, warned: !!e.data.warning };
            return { ...s, lastSaved: { ...item, at: Date.now() }, lastRejected: null, feed: [item, ...s.feed].slice(0, 12) };
          }
          default:
            return s;
        }
      });
      listeners.current.forEach((fn) => fn(e));
    };

    const connect = async () => {
      setState((s) => ({ ...s, status: 'connecting' }));
      try {
        const url = (await window.pulse.env()).liveUrl;
        if (!url) throw new Error('no endpoint');
        ws = new WebSocket(url);
        ws.onopen = async () => {
          const auth =
            role === 'admin' ? { type: 'auth', token } : { type: 'auth', terminalKey: await window.pulse.terminalKey() };
          ws!.send(JSON.stringify(auth));
        };
        ws.onmessage = (m) => {
          const msg = JSON.parse(String(m.data));
          if (msg.type === 'ready') {
            retry = 0;
            setState((s) => ({ ...s, status: 'live' }));
            // Initial snapshot; afterwards the host pushes 'health' events.
            if (role === 'admin') {
              void call<HostHealth>('host.health').then((h) => setState((s) => ({ ...s, health: h }))).catch(() => undefined);
              void call<ExportStatus>('export.status').then((x) => setState((s) => ({ ...s, exportStatus: s.exportStatus ?? (x.state === 'idle' ? null : x) }))).catch(() => undefined);
            }
          } else if (msg.type === 'event') apply(msg.event as LiveEvent);
        };
        ws.onclose = () => {
          if (closed) return;
          setState((s) => ({ ...s, status: 'offline' }));
          timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 8000));
        };
        ws.onerror = () => ws?.close();
      } catch {
        if (closed) return;
        setState((s) => ({ ...s, status: 'offline' }));
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 8000));
      }
    };
    void connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
      setState(INITIAL);
    };
  }, [role, token, call]);

  const value = useMemo<LiveCtx>(() => ({ ...state, subscribe }), [state, subscribe]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

/** Calls `fn` (debounced) whenever one of the listed live events arrives. */
export function useRefreshOn(types: LiveEvent['type'][], fn: () => void, delay = 150) {
  const { subscribe } = useLive();
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe((e) => {
      if (types.includes(e.type)) {
        if (t) clearTimeout(t);
        t = setTimeout(() => ref.current(), delay);
      }
    });
    return () => {
      off();
      if (t) clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, delay, types.join('|')]);
}
