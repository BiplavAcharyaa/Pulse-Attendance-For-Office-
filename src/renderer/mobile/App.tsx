import { AlertTriangle, Check, CheckCircle2, Clock, Fingerprint, Home, LogIn, LogOut, Loader2, ScanLine, ShieldCheck, Smartphone, Trash2, WifiOff, XCircle } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ERROR_MESSAGES, isPermanentToken, parseScan, type ParsedScan } from '../../shared/protocol';
import { apiGet, apiPost, postIdempotent, MobileError, type AttendanceResult, type HostInfo, type RegistrationStatus, type StatusView } from './api';
import { clearIdentity, createIdentity, cryptoAvailable, loadIdentity, randomNonce, saveIdentity, sign, type Identity } from './deviceKeys';
import { Scanner } from './scanner';

type Screen =
  | { k: 'boot' }
  | { k: 'insecure'; why: 'context' | 'storage' }
  | { k: 'welcome' }
  | { k: 'register'; token: string; peek?: { type: string; employee?: { id: string; fullName: string } }; error?: string }
  | { k: 'pending' }
  | { k: 'rejected'; reason?: string }
  | { k: 'home' }
  | { k: 'revoked' }
  | { k: 'unknown' }
  | { k: 'inactive' };

type Outcome =
  | { ok: true; res: AttendanceResult }
  | { ok: false; code: string; message: string };

const mins = (m: number) => (m ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : '—');
const hm = (t?: string) => (t ? t.slice(0, 5) : '—');
const humanError = (e: unknown): { code: string; message: string } => {
  if (e instanceof MobileError) return { code: e.code, message: ERROR_MESSAGES[e.code] && e.code !== 'TOKEN_INVALID' ? ERROR_MESSAGES[e.code] : e.message };
  return { code: 'INTERNAL', message: (e as Error)?.message || 'Something went wrong.' };
};

async function fetchStatus(id: Identity): Promise<StatusView> {
  const { nonce } = await apiGet<{ nonce: string }>('/api/device/nonce');
  const signature = await sign(id, { purpose: 'status', hostId: await hostId(), challenge: nonce });
  return apiPost<StatusView>('/api/device/status', { deviceId: id.deviceId, nonce, signature });
}

let cachedHost: HostInfo | null = null;
async function hostInfo(): Promise<HostInfo> {
  if (!cachedHost) cachedHost = await apiGet<HostInfo>('/api/info');
  return cachedHost;
}
const hostId = async () => (await hostInfo()).hostId;

function Shell({ children, foot }: { children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="m-shell">
      <header className="m-head">
        <img className="m-mark" src="./pulse-icon.png" width={34} height={34} alt="PULSE" draggable={false} />
        <b>PULSE</b>
        <span>Attendance</span>
      </header>
      <main className="m-main">{children}</main>
      {foot}
    </div>
  );
}

function Notice({ tone, icon, title, children, actions }: { tone: 'bad' | 'warn' | 'ok' | 'info'; icon: ReactNode; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className={`m-notice ${tone}`}>
      <div className="m-notice-ico">{icon}</div>
      <h1>{title}</h1>
      {children ? <div className="m-notice-body">{children}</div> : null}
      {actions ? <div className="m-actions">{actions}</div> : null}
    </div>
  );
}

// ───────────────────────── root ─────────────────────────
export function App() {
  const [screen, setScreen] = useState<Screen>({ k: 'boot' });
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [status, setStatus] = useState<StatusView | null>(null);
  const [scanning, setScanning] = useState(false);
  const [busy, setBusy] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [tab, setTab] = useState<'home' | 'device'>('home');
  const [live, setLive] = useState(false);
  const idRef = useRef<Identity | null>(null);
  idRef.current = identity;
  const processing = useRef(false);

  const deviceProblem = useCallback((e: unknown): boolean => {
    const code = e instanceof MobileError ? e.code : '';
    if (code === 'DEVICE_REVOKED') return setScreen({ k: 'revoked' }), true;
    if (code === 'DEVICE_UNKNOWN') return setScreen({ k: 'unknown' }), true;
    if (code === 'EMPLOYEE_INACTIVE') return setScreen({ k: 'inactive' }), true;
    return false;
  }, []);

  const refresh = useCallback(async () => {
    const id = idRef.current;
    if (!id?.enrollment) return;
    try {
      setStatus(await fetchStatus(id));
    } catch (e) {
      if (!deviceProblem(e)) {
        /* offline: keep the last known status */
      }
    }
  }, [deviceProblem]);

  const processAttendance = useCallback(
    async (token: string) => {
      const id = idRef.current;
      if (!id?.enrollment || processing.current) return;
      processing.current = true;
      setScanning(false);
      setBusy('Verifying with the office computer…');
      try {
        const st = await fetchStatus(id);
        setStatus(st);
        if (st.status.nextAction === 'none') {
          const ap = st.status.approval?.status;
          const code = ap === 'pending' ? 'APPROVAL_PENDING' : ap === 'rejected' ? 'APPROVAL_REJECTED' : 'DAY_COMPLETE';
          setOutcome({ ok: false, code, message: ERROR_MESSAGES[code] });
          return;
        }
        const intent = 'auto';
        const clientNonce = isPermanentToken(token) ? (await apiGet<{ nonce: string }>('/api/device/nonce')).nonce : randomNonce();
        const signature = await sign(id, { purpose: 'attendance', hostId: await hostId(), challenge: token, extra: `${intent}|${clientNonce}` });
        const res = await postIdempotent<AttendanceResult>('/api/attendance', { deviceId: id.deviceId, token, intent, clientNonce, signature, idempotencyKey: randomNonce() });
        navigator.vibrate?.([30, 40, 60]);
        setOutcome({ ok: true, res });
        setStatus((s) => (s ? { ...s, status: res.status } : s));
      } catch (e) {
        if (!deviceProblem(e)) setOutcome({ ok: false, ...humanError(e) });
      } finally {
        setBusy('');
        processing.current = false;
      }
    },
    [deviceProblem],
  );

  const handleScan = useCallback(
    (s: ParsedScan) => {
      const id = idRef.current;
      if (s.kind === 'registration') {
        setScanning(false);
        void startRegistration(s.token);
        return;
      }
      if (!id?.enrollment) {
        setScanning(false);
        setOutcome({ ok: false, code: 'DEVICE_UNKNOWN', message: id?.request ? 'Your phone is still waiting for administrator approval. You can record attendance once it is approved.' : ERROR_MESSAGES.DEVICE_UNKNOWN + ' Scan the registration QR first.' });
        return;
      }
      void processAttendance(s.token);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [processAttendance],
  );

  async function startRegistration(token: string) {
    try {
      const peek = await apiPost<{ type: string; employee?: { id: string; fullName: string } }>('/api/register/peek', { token });
      setScreen({ k: 'register', token, peek });
    } catch (e) {
      setScreen({ k: 'register', token, error: humanError(e).message });
    }
  }

  // boot
  useEffect(() => {
    (async () => {
      if (!window.isSecureContext || !cryptoAvailable()) return setScreen({ k: 'insecure', why: 'context' });
      void navigator.storage?.persist?.().catch(() => undefined);
      let id: Identity | null = null;
      try {
        id = await loadIdentity();
      } catch {
        return setScreen({ k: 'insecure', why: 'storage' });
      }
      setIdentity(id);
      idRef.current = id;

      const scan = parseScan(window.location.href);
      if (scan) history.replaceState(null, '', window.location.pathname + window.location.search);

      if (scan?.kind === 'registration') return void startRegistration(scan.token);
      if (id?.enrollment) {
        setScreen({ k: 'home' });
        await refresh();
        if (scan?.kind === 'attendance') void processAttendance(scan.token);
        return;
      }
      if (id?.request) return setScreen({ k: 'pending' });
      setScreen({ k: 'welcome' });
      if (scan?.kind === 'attendance') setOutcome({ ok: false, code: 'DEVICE_UNKNOWN', message: ERROR_MESSAGES.DEVICE_UNKNOWN + ' Scan the registration QR first.' });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // hash changes while the app is open (e.g. camera app opens the link in this tab)
  useEffect(() => {
    const h = () => {
      const scan = parseScan(window.location.href);
      if (!scan) return;
      history.replaceState(null, '', window.location.pathname + window.location.search);
      handleScan(scan);
    };
    window.addEventListener('hashchange', h);
    return () => window.removeEventListener('hashchange', h);
  }, [handleScan]);

  // live socket + refresh when returning to the app
  useEffect(() => {
    if (screen.k !== 'home' || !identity?.enrollment) return;
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const { nonce } = await apiGet<{ nonce: string }>('/api/device/nonce');
        const signature = await sign(identity, { purpose: 'live', hostId: await hostId(), challenge: nonce });
        if (closed) return;
        ws = new WebSocket(`wss://${location.host}/ws`);
        ws.onopen = () => ws!.send(JSON.stringify({ type: 'hello', deviceId: identity.deviceId, nonce, signature }));
        ws.onmessage = (m) => {
          let msg: { type?: string; code?: string };
          try { msg = JSON.parse(String(m.data)); } catch { return; }
          if (msg.type === 'ready') { retry = 0; setLive(true); }
          else if (msg.type === 'attendance-changed') void refresh();
          else if (msg.type === 'revoked') setScreen({ k: 'revoked' });
          else if (msg.type === 'error' && msg.code === 'DEVICE_REVOKED') setScreen({ k: 'revoked' });
        };
        ws.onclose = () => {
          setLive(false);
          if (!closed) timer = setTimeout(connect, Math.min(2000 * 2 ** retry++, 20000));
        };
        ws.onerror = () => ws?.close();
      } catch (e) {
        if (closed) return;
        if (deviceProblem(e)) return;
        timer = setTimeout(connect, Math.min(2000 * 2 ** retry++, 20000));
      }
    };
    void connect();
    const vis = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', vis);
    return () => {
      closed = true;
      clearTimeout(timer);
      ws?.close();
      document.removeEventListener('visibilitychange', vis);
    };
  }, [screen.k, identity, refresh, deviceProblem]);

  const resetPhone = async () => {
    await clearIdentity().catch(() => undefined);
    setIdentity(null);
    idRef.current = null;
    setStatus(null);
    setTab('home');
    setScreen({ k: 'welcome' });
  };

  const overlays = (
    <>
      {scanning ? <Scanner onScan={handleScan} onClose={() => setScanning(false)} /> : null}
      {busy ? (
        <div className="m-busy" role="status"><Loader2 className="m-spin" size={28} /><span>{busy}</span></div>
      ) : null}
      {outcome ? <ResultSheet outcome={outcome} onClose={() => setOutcome(null)} /> : null}
    </>
  );

  let body: ReactNode;
  switch (screen.k) {
    case 'boot':
      body = <div className="m-center"><Loader2 className="m-spin" size={28} /></div>;
      break;
    case 'insecure':
      body = <Insecure why={screen.why} />;
      break;
    case 'welcome':
      body = (
        <Notice tone="info" icon={<Smartphone size={30} />} title="Set up this phone" actions={<button className="m-btn primary" onClick={() => setScanning(true)}><ScanLine size={18} /> Scan registration QR</button>}>
          <p>Ask an administrator to show the <b>registration QR</b> on the office screen, then scan it here. You will enter your details once and the administrator approves your phone.</p>
          <p className="m-small">Your phone creates a private key that never leaves it. Nothing is stored in cookies.</p>
        </Notice>
      );
      break;
    case 'register':
      body = <RegisterForm s={screen} identity={identity} onCancel={() => setScreen(identity?.enrollment ? { k: 'home' } : identity?.request ? { k: 'pending' } : { k: 'welcome' })} onSubmitted={(id) => { setIdentity(id); idRef.current = id; setScreen({ k: 'pending' }); }} />;
      break;
    case 'pending':
      body = identity?.request ? (
        <Pending
          identity={identity}
          onApproved={(id) => { setIdentity(id); idRef.current = id; setScreen({ k: 'home' }); void refresh(); }}
          onRejected={async (reason) => { const id = { ...identity, request: undefined }; await saveIdentity(id).catch(() => undefined); setIdentity(id); setScreen({ k: 'rejected', reason }); }}
          onLost={async () => { const id = { ...identity, request: undefined }; await saveIdentity(id).catch(() => undefined); setIdentity(id); setScreen({ k: 'welcome' }); }}
        />
      ) : null;
      break;
    case 'rejected':
      body = (
        <Notice tone="bad" icon={<XCircle size={30} />} title="Registration was not approved" actions={<button className="m-btn primary" onClick={() => setScreen({ k: 'welcome' })}>Start again</button>}>
          {screen.reason ? <p>Reason: {screen.reason}</p> : null}
          <p>Please speak to an administrator, then scan a new registration QR.</p>
        </Notice>
      );
      break;
    case 'revoked':
      body = (
        <Notice tone="bad" icon={<ShieldCheck size={30} />} title="This phone was revoked" actions={<button className="m-btn" onClick={() => void resetPhone()}>Remove registration from this phone</button>}>
          <p>An administrator has revoked this phone, so attendance can no longer be recorded with it.</p>
          <p>If you have a new phone, or this one was reset, ask an administrator for a <b>replacement-phone QR</b> and scan it on the new phone.</p>
        </Notice>
      );
      break;
    case 'unknown':
      body = (
        <Notice tone="warn" icon={<AlertTriangle size={30} />} title="The office does not recognise this phone" actions={<><button className="m-btn" onClick={() => void refresh().then(() => setScreen({ k: 'home' }))}>Try again</button><button className="m-btn" onClick={() => void resetPhone()}>Register again</button></>}>
          <p>This can happen if the office computer’s data was restored or reset, or your registration was removed.</p>
          <p>Ask an administrator for a registration QR and scan it to register this phone again.</p>
        </Notice>
      );
      break;
    case 'inactive':
      body = (
        <Notice tone="warn" icon={<AlertTriangle size={30} />} title="Your profile is inactive" actions={<button className="m-btn" onClick={() => void refresh().then(() => setScreen({ k: 'home' }))}>Check again</button>}>
          <p>Your employee profile is currently inactive. Please contact an administrator.</p>
        </Notice>
      );
      break;
    case 'home':
      body = tab === 'home' ? (
        <HomeView status={status} live={live} onScan={() => setScanning(true)} identity={identity} />
      ) : (
        <DeviceView identity={identity} status={status} onReset={resetPhone} />
      );
      break;
  }

  const foot = screen.k === 'home' ? (
    <nav className="m-tabs" aria-label="Sections">
      <button className={tab === 'home' ? 'on' : ''} onClick={() => setTab('home')}><Home size={20} />Today</button>
      <button className={tab === 'device' ? 'on' : ''} onClick={() => setTab('device')}><Fingerprint size={20} />My phone</button>
    </nav>
  ) : undefined;

  return (
    <Shell foot={foot}>
      {body}
      {overlays}
    </Shell>
  );
}

// ───────────────────────── screens ─────────────────────────
function Insecure({ why }: { why: 'context' | 'storage' }) {
  const host = location.hostname;
  return (
    <Notice tone="warn" icon={<WifiOff size={30} />} title={why === 'storage' ? 'Browser storage is unavailable' : 'A secure connection is needed'}>
      {why === 'storage' ? (
        <>
          <p>PULSE keeps a private key on this phone using the browser’s secure storage, which is blocked right now.</p>
          <p>Turn off private/incognito mode and allow site data for this address, then reload.</p>
        </>
      ) : (
        <>
          <p>The camera and the phone’s security key only work on a <b>trusted HTTPS</b> page. This page is not trusted yet.</p>
          <ol className="m-steps">
            <li>Open <span className="mono">http://{host}:8081</span> (setup page) on this phone.</li>
            <li>Download and install the <b>office certificate</b> and mark it as trusted.</li>
            <li>Then open <span className="mono">https://{host}:{location.port || '8443'}</span> again.</li>
          </ol>
          <p className="m-small">The administrator can find the exact steps for Android and iPhone in the PULSE desktop app under Settings → Phone certificate.</p>
        </>
      )}
    </Notice>
  );
}

function RegisterForm({ s, identity, onCancel, onSubmitted }: { s: Extract<Screen, { k: 'register' }>; identity: Identity | null; onCancel: () => void; onSubmitted: (id: Identity) => void }) {
  const lock = s.peek?.employee;
  const [fullName, setFullName] = useState(lock?.fullName ?? '');
  const [employeeId, setEmployeeId] = useState(lock?.id ?? '');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState(s.error ?? '');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      // Reuse a key that is still waiting for approval; otherwise create a fresh one.
      const id = identity && !identity.enrollment && !identity.request ? identity : await createIdentity();
      const body = { token: s.token, fullName: fullName.trim(), employeeId: employeeId.trim(), phone: phone.trim(), publicKey: id.jwk, userAgent: navigator.userAgent.slice(0, 280) };
      const r = await apiPost<{ requestId: string; pollSecret: string }>('/api/register', body);
      const next: Identity = { ...id, enrollment: undefined, request: { requestId: r.requestId, pollSecret: r.pollSecret, employeeId: body.employeeId, fullName: body.fullName, submittedAt: new Date().toISOString() } };
      await saveIdentity(next);
      onSubmitted(next);
    } catch (err) {
      setError(humanError(err).message);
    } finally {
      setBusy(false);
    }
  };

  if (s.error) {
    return <Notice tone="bad" icon={<XCircle size={30} />} title="Registration code problem" actions={<button className="m-btn" onClick={onCancel}>Back</button>}><p>{s.error}</p></Notice>;
  }
  return (
    <form className="m-card" onSubmit={submit}>
      <h1>{s.peek?.type === 'replacement' ? 'Register your new phone' : 'Register this phone'}</h1>
      {identity?.enrollment ? <div className="m-warn">This phone is already registered as {identity.enrollment.fullName}. Continuing replaces that registration on this phone.</div> : null}
      <label>Full name<input value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required minLength={2} maxLength={80} /></label>
      <label>Employee ID<input value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} disabled={!!lock} autoCapitalize="characters" autoComplete="off" required maxLength={32} /></label>
      <label>Phone number<input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" required maxLength={24} /></label>
      {error ? <div className="m-err" role="alert">{error}</div> : null}
      <button className="m-btn primary" disabled={busy} type="submit">{busy ? <Loader2 className="m-spin" size={18} /> : <Check size={18} />} Send for approval</button>
      <button className="m-btn ghost" type="button" onClick={onCancel}>Cancel</button>
      <p className="m-small">An administrator must approve this request before the phone can record attendance.</p>
    </form>
  );
}

function Pending({ identity, onApproved, onRejected, onLost }: { identity: Identity; onApproved: (id: Identity) => void; onRejected: (reason?: string) => void; onLost: () => void }) {
  const req = identity.request!;
  const [offline, setOffline] = useState(false);
  const handled = useRef(false);

  const apply = useCallback(
    async (st: RegistrationStatus) => {
      if (handled.current) return;
      if (st.status === 'approved') {
        if (st.deviceId && st.deviceId !== identity.deviceId) return; // not this key — keep waiting rather than trust it
        handled.current = true;
        const next: Identity = { ...identity, request: undefined, enrollment: { employeeId: st.employee?.id ?? req.employeeId, fullName: st.employee?.fullName ?? req.fullName, enrolledAt: new Date().toISOString() } };
        await saveIdentity(next);
        onApproved(next);
      } else if (st.status === 'rejected') {
        handled.current = true;
        onRejected(st.reason);
      }
    },
    [identity, req, onApproved, onRejected],
  );

  useEffect(() => {
    let stop = false;
    const poll = async () => {
      try {
        await apply(await apiPost<RegistrationStatus>('/api/register/status', { requestId: req.requestId, pollSecret: req.pollSecret }));
        setOffline(false);
      } catch (e) {
        if (e instanceof MobileError && e.code === 'NOT_FOUND') {
          if (!handled.current) { handled.current = true; onLost(); }
        } else setOffline(true);
      }
    };
    void poll();
    const t = setInterval(() => !stop && void poll(), 4000);

    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`wss://${location.host}/ws`);
      ws.onopen = () => ws!.send(JSON.stringify({ type: 'watch', requestId: req.requestId, pollSecret: req.pollSecret }));
      ws.onmessage = (m) => {
        try {
          const msg = JSON.parse(String(m.data));
          if (msg.type === 'registration') void apply(msg as RegistrationStatus);
          else if (msg.type === 'registration-changed') void poll();
        } catch { /* ignore */ }
      };
    } catch { /* polling covers it */ }
    return () => { stop = true; clearInterval(t); ws?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Notice tone="info" icon={<Clock size={30} />} title="Waiting for approval">
      <p><b>{req.fullName}</b> ({req.employeeId}), your request was sent. An administrator needs to approve this phone — this page updates by itself.</p>
      {offline ? <p className="m-small"><WifiOff size={14} /> Connection lost; still trying…</p> : <p className="m-small m-pulse"><span className="m-dot" /> Listening for the decision</p>}
    </Notice>
  );
}

function HomeView({ status, live, onScan, identity }: { status: StatusView | null; live: boolean; onScan: () => void; identity: Identity | null }) {
  const name = status?.employee.fullName ?? identity?.enrollment?.fullName ?? '';
  const st = status?.status;
  const next = st?.nextAction;
  const apStatus = st?.approval?.status;
  const label = next === 'check-out' ? 'Scan to check out' : next === 'none' ? (apStatus === 'pending' ? 'Awaiting approval' : apStatus === 'rejected' ? 'Not approved' : 'Done for today') : 'Scan to check in';
  const chip =
    !st ? ['grey', 'Loading'] : st.state === 'checked-in' ? ['mint', 'Checked in'] : st.state === 'checked-out' ? ['blue', 'Checked out'] : ['grey', 'Not checked in'];
  return (
    <>
      <section className="m-hero">
        <div className="m-hello">Hello,</div>
        <h1>{name || '…'}</h1>
        <div className="m-sub">{status ? `${status.employee.id}${status.employee.department ? ' · ' + status.employee.department : ''}` : ' '}</div>
        <span className={`m-chip ${chip[0]}`}>{chip[1]}</span>
        {st?.today.classification === 'late' ? <span className="m-chip rose">Late +{st.today.minutesLate ?? 0}m</span> : st?.today.classification === 'grace' ? <span className="m-chip yellow">Grace +{st.today.minutesLate ?? 0}m</span> : null}
        {st?.today.earlyLeave ? <span className="m-chip rose">Early leave</span> : null}
        {st?.today.overtimeStatus === 'pending' ? <span className="m-chip amber">Overtime awaiting approval</span> : st?.today.overtimeStatus === 'approved' ? <span className="m-chip mint">Overtime approved</span> : st?.today.overtimeStatus === 'rejected' ? <span className="m-chip grey">Overtime not approved</span> : null}
        {apStatus === 'pending' && st?.approval?.kind === 'late-check-in' ? <span className="m-chip amber">Check-in awaiting approval</span> : apStatus === 'rejected' && st?.approval?.kind === 'late-check-in' ? <span className="m-chip rose">Check-in not approved</span> : null}
      </section>

      <section className="m-card">
        <div className="m-grid3">
          <div><span>Check-in</span><b>{hm(st?.today.checkInLocal)}</b></div>
          <div><span>Check-out</span><b>{hm(st?.today.checkOutLocal)}</b></div>
          <div><span>Worked</span><b>{st ? mins(st.today.workedMinutes) : '—'}</b></div>
        </div>
      </section>

      <button className="m-scan" onClick={onScan} disabled={next === 'none'}>
        {next === 'check-out' ? <LogOut size={26} /> : next === 'none' ? <CheckCircle2 size={26} /> : <LogIn size={26} />}
        <span>{label}</span>
        <small>{next === 'none' ? (apStatus === 'pending' ? 'An administrator will review your late check-in' : apStatus === 'rejected' ? (st?.approval?.reason ?? 'Please speak to an administrator') : 'Your attendance for today is complete') : 'Point your camera at the screen at the office'}</small>
      </button>

      <div className={`m-live ${live ? 'on' : ''}`}><span className="m-dot" /> {live ? 'Connected to the office' : 'Connecting…'}{status ? ` · ${status.orgName}` : ''}</div>
    </>
  );
}

function DeviceView({ identity, status, onReset }: { identity: Identity | null; status: StatusView | null; onReset: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone;
  return (
    <>
      <section className="m-card">
        <h2>This phone</h2>
        <dl className="m-kv">
          <dt>Employee</dt><dd>{identity?.enrollment?.fullName} ({identity?.enrollment?.employeeId})</dd>
          <dt>Registered</dt><dd>{identity?.enrollment ? new Date(identity.enrollment.enrolledAt).toLocaleDateString() : '—'}</dd>
          <dt>Device ID</dt><dd className="mono">{identity?.deviceId}</dd>
          <dt>Office</dt><dd>{status?.orgName ?? '—'}</dd>
        </dl>
        <p className="m-small"><ShieldCheck size={14} /> The private key is locked inside this browser and never leaves the phone.</p>
      </section>

      {ios && !standalone ? (
        <section className="m-card"><h2>Tip for iPhone</h2><p className="m-small">Tap Share → <b>Add to Home Screen</b> so PULSE opens like an app and keeps its registration reliably.</p></section>
      ) : null}

      <section className="m-card">
        <h2>Lost or replaced your phone?</h2>
        <p className="m-small">Tell an administrator. They revoke the old phone and give you a one-time QR to register the new one. Do not share your phone with anyone.</p>
        {!confirm ? (
          <button className="m-btn" onClick={() => setConfirm(true)}><Trash2 size={16} /> Remove registration from this phone</button>
        ) : (
          <div className="m-warn">
            This deletes the key from this phone. You will need a new registration QR and administrator approval to use it again.
            <div className="m-actions row"><button className="m-btn danger" onClick={onReset}>Yes, remove it</button><button className="m-btn" onClick={() => setConfirm(false)}>Cancel</button></div>
          </div>
        )}
      </section>
    </>
  );
}

function ResultSheet({ outcome, onClose }: { outcome: Outcome; onClose: () => void }) {
  const warned = outcome.ok && !!outcome.res.warning;
  useEffect(() => {
    if (!outcome.ok || warned) return;
    const t = setTimeout(onClose, 9000);
    return () => clearTimeout(t);
  }, [outcome, onClose, warned]);
  if (outcome.ok) {
    const r = outcome.res;
    const held = !!r.pendingApproval;
    const label = held ? 'Sent for approval' : r.event.kind === 'check-in' ? 'Checked in' : 'Checked out';
    const cls = r.event.classification;
    return (
      <div className={`m-sheet ${held ? 'soft' : 'ok'}`} role="alertdialog" aria-live="assertive">
        <div className="m-check">{held ? <Clock size={50} /> : <Check size={54} strokeWidth={3} />}</div>
        <h1>{label}</h1>
        <div className="m-time">{r.event.localTime.slice(0, 5)}</div>
        <p>{r.employee.fullName}</p>
        {r.shift ? <p className="m-small">{r.shift.name}</p> : null}
        <div className="row">
          {held ? <span className="m-chip amber">Awaiting approval</span> : cls === 'late' || cls === 'very-late' ? <span className="m-chip rose">Late by {r.event.minutes ?? 0} min</span> : cls === 'grace' ? <span className="m-chip yellow">Grace · {r.event.minutes ?? 0} min after start</span> : cls === 'on-time' ? <span className="m-chip mint">On time</span> : cls === 'early-leave' ? <span className="m-chip rose">Early leave</span> : cls === 'overtime' ? <span className="m-chip amber">Overtime awaiting approval</span> : null}
        </div>
        {r.warning ? (
          <div className="m-alarm" role="alert">
            <h2><AlertTriangle size={20} /> Serious attendance warning</h2>
            <div className="m-who">{r.warning.employeeName} · {r.warning.employeeId}</div>
            <div className="m-counts">
              <span className={r.warning.graceExceeded ? 'hit' : ''}><b>{r.warning.graceCount}</b>Grace this month<br />limit {r.warning.graceLimit}</span>
              <span className={r.warning.lateExceeded ? 'hit' : ''}><b>{r.warning.lateCount}</b>Late this month<br />limit {r.warning.lateLimit}</span>
            </div>
            <ul>{r.warning.violations.map((v) => <li key={v}>{v}</li>)}</ul>
            <p>{r.warning.message}</p>
          </div>
        ) : null}
        <p className="m-small">{r.message}</p>
        <p className="m-small">{held ? 'Recorded on the office computer as a request.' : 'Saved on the office computer.'}</p>
        <button className="m-btn primary" onClick={onClose}>{r.warning ? 'I understand' : 'Done'}</button>
      </div>
    );
  }
  const soft = ['ALREADY_CHECKED_IN', 'DAY_COMPLETE', 'NOT_CHECKED_IN', 'TOO_SOON', 'TOO_EARLY', 'NO_SHIFT_OPEN', 'SHIFT_AMBIGUOUS', 'CHECKOUT_NOT_OPEN', 'APPROVAL_PENDING', 'APPROVAL_REJECTED'].includes(outcome.code);
  return (
    <div className={`m-sheet ${soft ? 'soft' : 'bad'}`} role="alertdialog" aria-live="assertive">
      <div className="m-check">{soft ? <AlertTriangle size={50} /> : <XCircle size={54} />}</div>
      <h1>{soft ? 'Nothing was recorded' : 'Attendance NOT recorded'}</h1>
      <p>{outcome.message}</p>
      <button className="m-btn primary" onClick={onClose}>OK</button>
    </div>
  );
}
