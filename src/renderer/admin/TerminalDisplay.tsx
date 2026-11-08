import { CheckCircle2, ShieldCheck, Wifi, WifiOff, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useLive } from './api';
import { Logo } from './ui';
import { Countdown, QrFrame } from './QrView';

/** Public-facing reception screen: only the QR, a clock, and first names of recent verified scans. */
export function TerminalDisplay() {
  const live = useLive();
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const toastOk = live.lastSaved && now.getTime() - live.lastSaved.at < 5000 ? live.lastSaved : null;
  const toastBad = live.lastRejected && now.getTime() - Date.parse(live.lastRejected.at) < 5000 ? live.lastRejected : null;
  const reg = live.mode === 'registration';
  return (
    <div className="recep">
      <div className="recep-top">
        <Logo size={52} />
        <div>
          <div className="brand-name">PULSE</div>
          <div className="brand-sub">Attendance Intelligence Terminal</div>
        </div>
        <div className="recep-clock">
          {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
          <small>{now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</small>
        </div>
      </div>

      <div className="recep-main" style={{ position: 'relative' }}>
        {toastOk ? <div className="recep-toast ok"><CheckCircle2 size={26} /> {toastOk.name} · {toastOk.kind === 'check-in' ? 'Checked in' : 'Checked out'} {toastOk.local}</div> : null}
        {toastBad ? <div className="recep-toast bad"><XCircle size={26} /> {toastBad.message}</div> : null}
        <h2>{reg ? 'Register your phone' : 'Scan to check in or out'}</h2>
        <QrFrame text={live.qr?.url ?? null} label={reg ? 'Registration QR code' : 'Attendance QR code'} />
        <div style={{ width: 'min(52vh, 50vw)' }}><Countdown qr={live.qr} skew={live.skew} /></div>
        <p>{reg ? 'Scan with your phone camera and follow the steps. An administrator will approve your request.' : live.qr?.qrMode === 'permanent' ? 'Open PULSE on your registered phone and point the camera here.' : 'Open PULSE on your registered phone and point the camera here. The code changes every few seconds.'}</p>
      </div>

      <div className="recep-side">
        <h3>Recent</h3>
        {live.feed.length === 0 ? <div className="muted">Check-ins will appear here.</div> : null}
        {live.feed.slice(0, 7).map((f) => (
          <div key={f.id} className={`feed-item ${f.kind === 'check-out' ? 'out' : ''}`}>
            <span className="tick"><CheckCircle2 size={22} /></span>
            <div>
              <b>{f.name}</b>
              <span>{f.kind === 'check-in' ? 'Checked in' : 'Checked out'} · {f.local}{f.classification === 'grace' ? ' · grace' : f.classification === 'late' || f.classification === 'very-late' ? ' · late' : f.classification === 'early-leave' ? ' · early leave' : ''}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="recep-bottom">
        <span className="row">{live.status === 'live' ? <Wifi size={15} color="#1f9d63" /> : <WifiOff size={15} color="#d4101f" />} {live.status === 'live' ? 'Host connected' : 'Reconnecting to host…'}</span>
        <span className="row"><ShieldCheck size={15} /> Every scan is verified against the phone’s device key</span>
      </div>
    </div>
  );
}
