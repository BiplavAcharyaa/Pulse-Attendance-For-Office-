import { Activity, ClipboardCheck, ClipboardList, FileSpreadsheet, Inbox, LayoutDashboard, Clock3, LogOut, QrCode, ScrollText, Settings as Cog, Smartphone, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AuthProvider, LiveProvider, publicCall, useAuth, useLive, useRefreshOn } from './api';
import { Login } from './Login';
import { TerminalDisplay } from './TerminalDisplay';
import { OverviewPage } from './pages/Overview';
import { TerminalPage } from './pages/Terminal';
import { DevicesPage, EmployeesPage, RequestsPage } from './pages/People';
import { AttendancePage } from './pages/Attendance';
import { ApprovalsPage } from './pages/Approvals';
import { ShiftsPage } from './pages/Shifts';
import { ExportsPage } from './pages/Exports';
import { AuditPage } from './pages/Audit';
import { SettingsPage } from './pages/Settings';
import { Logo, ToastProvider, initials } from './ui';

type PageKey = 'overview' | 'terminal' | 'requests' | 'employees' | 'devices' | 'attendance' | 'approvals' | 'shifts' | 'exports' | 'audit' | 'settings';

const NAV: Array<{ group: string; items: Array<{ key: PageKey; label: string; sub: string; icon: ReactNode }> }> = [
  {
    group: 'Live',
    items: [
      { key: 'overview', label: 'Overview', sub: "Today's attendance at a glance", icon: <LayoutDashboard size={18} /> },
      { key: 'terminal', label: 'QR terminal', sub: 'Live attendance and registration codes', icon: <QrCode size={18} /> },
    ],
  },
  {
    group: 'People',
    items: [
      { key: 'requests', label: 'Requests', sub: 'Phones waiting for approval', icon: <Inbox size={18} /> },
      { key: 'employees', label: 'Employees', sub: 'Directory and enrollment', icon: <Users size={18} /> },
      { key: 'devices', label: 'Phones', sub: 'Registered devices and revocation', icon: <Smartphone size={18} /> },
    ],
  },
  {
    group: 'Records',
    items: [
      { key: 'attendance', label: 'Attendance', sub: 'History and corrections', icon: <ClipboardList size={18} /> },
      { key: 'approvals', label: 'Approvals', sub: 'Late check-ins and overtime awaiting a decision', icon: <ClipboardCheck size={18} /> },
      { key: 'shifts', label: 'Shifts', sub: 'Timings and automatic detection', icon: <Clock3 size={18} /> },
      { key: 'exports', label: 'Exports', sub: 'Excel reports', icon: <FileSpreadsheet size={18} /> },
      { key: 'audit', label: 'Audit & security', sub: 'Tamper-evident log and suspicious activity', icon: <ScrollText size={18} /> },
    ],
  },
  { group: 'System', items: [{ key: 'settings', label: 'Settings', sub: 'Rules, network, backups, accounts', icon: <Cog size={18} /> }] },
];

function Clock() {
  const live = useLive();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const tz = live.health?.timezone;
  let time = '';
  let date = '';
  try {
    const d = new Date(now + live.skew);
    time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: tz });
    date = d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });
  } catch {
    time = new Date(now).toLocaleTimeString();
  }
  return (
    <div className="clock" aria-label="Office time">
      {time}
      <small>{date}{tz ? ` · ${tz}` : ''}</small>
    </div>
  );
}

function Shell() {
  const { auth, call, signOut } = useAuth();
  const live = useLive();
  const [page, setPage] = useState<PageKey>('overview');
  const [pending, setPending] = useState(0);
  const [pendingApprovals, setPendingApprovals] = useState(0);

  const countPending = useCallback(() => {
    call<unknown[]>('requests.list', { status: 'pending' }).then((l) => setPending(l.length)).catch(() => undefined);
  }, [call]);
  useEffect(countPending, [countPending]);
  useRefreshOn(['request.created', 'request.decided'], countPending);
  const countApprovals = useCallback(() => {
    call<unknown[]>('approvals.list', { status: 'pending' }).then((l) => setPendingApprovals(l.length)).catch(() => undefined);
  }, [call]);
  useEffect(countApprovals, [countApprovals]);
  useRefreshOn(['approval.requested', 'approval.decided', 'correction.saved'], countApprovals);

  const cur = NAV.flatMap((g) => g.items).find((i) => i.key === page)!;
  const h = live.health;
  const tone = live.status !== 'live' || (h && !h.listening) || h?.storage.status === 'critical' ? 'bad' : h?.storage.status === 'degraded' || h?.clock.suspect ? 'warn' : '';

  const view = (() => {
    switch (page) {
      case 'overview': return <OverviewPage go={(p) => setPage(p as PageKey)} />;
      case 'terminal': return <TerminalPage />;
      case 'requests': return <RequestsPage />;
      case 'employees': return <EmployeesPage />;
      case 'devices': return <DevicesPage />;
      case 'attendance': return <AttendancePage />;
      case 'approvals': return <ApprovalsPage />;
      case 'shifts': return <ShiftsPage />;
      case 'exports': return <ExportsPage />;
      case 'audit': return <AuditPage />;
      case 'settings': return <SettingsPage />;
    }
  })();

  return (
    <div className="shell">
      <aside className="side">
        <div className="brand">
          <Logo size={44} />
          <div>
            <div className="brand-name">PULSE</div>
            <div className="brand-sub">Attendance</div>
          </div>
        </div>
        <nav className="nav" aria-label="Main">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="nav-group">{g.group}</div>
              {g.items.map((i) => (
                <button key={i.key} className={page === i.key ? 'active' : ''} aria-current={page === i.key ? 'page' : undefined} onClick={() => setPage(i.key)}>
                  {i.icon}
                  {i.label}
                  {i.key === 'requests' && pending > 0 ? <span className="badge">{pending}</span> : null}
                  {i.key === 'approvals' && pendingApprovals > 0 ? <span className="badge">{pendingApprovals}</span> : null}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-foot">
          <div className="host-pill" title={h ? `${h.httpsUrl}` : undefined}>
            <span className={`dot ${tone} ${tone === '' ? 'pulse' : ''}`} />
            <div>
              <b>{live.status !== 'live' ? 'Reconnecting…' : !h ? 'Starting…' : h.listening ? 'Host online' : 'Phones cannot connect'}</b>
              {h ? `${h.lanAddress}:${h.httpsPort} · ${h.wsClients} phone${h.wsClients === 1 ? '' : 's'}` : '—'}
            </div>
          </div>
          <div className="user-row">
            <span className="avatar">{initials(auth!.admin.displayName)}</span>
            <div className="who"><b>{auth!.admin.displayName}</b><span>{auth!.admin.role}</span></div>
            <button className="btn ghost sm" onClick={signOut} aria-label="Sign out" title="Sign out"><LogOut size={16} /></button>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="top">
          <div>
            <h1>{cur.label}</h1>
            <div className="sub">{cur.sub}</div>
          </div>
          <div className="spacer" />
          {live.status !== 'live' ? <span className="chip amber"><Activity size={13} /> Live updates paused</span> : null}
          <Clock />
        </header>
        <div className="content" key={page}>{view}</div>
      </main>
    </div>
  );
}

function Gate() {
  const { auth } = useAuth();
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  const check = useCallback(() => {
    publicCall<{ setupRequired: boolean }>('auth.status').then((s) => setSetupRequired(s.setupRequired)).catch(() => setSetupRequired(false));
  }, []);
  useEffect(check, [check]);
  useEffect(() => { window.__pulseReady = true; }, []);

  if (auth) {
    return (
      <LiveProvider role="admin">
        <Shell />
      </LiveProvider>
    );
  }
  if (setupRequired === null) return <div className="muted" style={{ padding: 40 }}>Starting…</div>;
  return <Login setupRequired={setupRequired} onDone={check} />;
}

export function App() {
  const terminal = new URLSearchParams(window.location.search).get('mode') === 'terminal';
  useEffect(() => {
    if (terminal) window.__pulseReady = true;
  }, [terminal]);
  return (
    <AuthProvider>
      <ToastProvider>
        {terminal ? (
          <LiveProvider role="terminal">
            <TerminalDisplay />
          </LiveProvider>
        ) : (
          <Gate />
        )}
      </ToastProvider>
    </AuthProvider>
  );
}
