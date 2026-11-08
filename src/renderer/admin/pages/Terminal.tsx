import { CheckCircle2, Copy, MonitorUp, QrCode, RefreshCw, ShieldCheck, UserPlus, Wifi, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { HostHealth } from '../../../shared/types';
import { useAuth, useLive } from '../api';
import { Countdown, QrFrame } from '../QrView';
import { QrModeCard } from '../QrModeCard';
import { Button, Card, Chip, useAction, useToast } from '../ui';

export function TerminalPage() {
  const { call, can } = useAuth();
  const live = useLive();
  const toast = useToast();
  const { busy, run } = useAction();
  const [health, setHealth] = useState<HostHealth | null>(null);

  useEffect(() => {
    const load = () => call<HostHealth>('host.health').then(setHealth).catch(() => undefined);
    void load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [call]);

  const mode = live.mode;
  const qr = live.qr;
  const lastOk = live.lastSaved && Date.now() - live.lastSaved.at < 15000 ? live.lastSaved : null;
  const lastBad = live.lastRejected && Date.now() - Date.parse(live.lastRejected.at) < 15000 ? live.lastRejected : null;

  return (
    <div className="term">
      <div className="card qr-card">
        <div className="tabs" role="tablist" aria-label="QR mode">
          <button className={mode === 'attendance' ? 'on' : ''} disabled={!can('write')} onClick={() => run('mode', () => call('terminal.setMode', { mode: 'attendance' }))}>
            <QrCode size={14} style={{ verticalAlign: -2 }} /> Attendance QR
          </button>
          <button className={mode === 'registration' ? 'on' : ''} disabled={!can('write')} onClick={() => run('mode', () => call('terminal.setMode', { mode: 'registration' }))}>
            <UserPlus size={14} style={{ verticalAlign: -2 }} /> Registration QR
          </button>
        </div>
        <QrFrame text={qr?.url ?? null} label={mode === 'attendance' ? (qr?.qrMode === 'permanent' ? 'Permanent attendance QR code' : 'Live attendance QR code') : 'One-time registration QR code'} />
        <Countdown qr={qr} skew={live.skew} />
        {mode === 'registration' ? (
          <div className="col" style={{ width: '100%' }}>
            <div className="banner info" style={{ margin: 0 }}>
              <ShieldCheck size={18} />
              <div className="grow">
                <b>One-time registration code</b>
                Each employee scans this once to request enrollment. You approve every request in Requests. A fresh code appears automatically after each use.
              </div>
            </div>
            <Button loading={busy === 'newcode'} onClick={() => run('newcode', () => call('terminal.newRegistrationCode'))}>
              <RefreshCw size={15} /> Issue a new code now
            </Button>
          </div>
        ) : qr?.qrMode === 'permanent' ? (
          <div className="muted" style={{ fontSize: 12.5, textAlign: 'center' }}>
            Permanent code — it does not change until an administrator regenerates it. Each scan is checked against the phone’s device key on this computer.
          </div>
        ) : (
          <div className="muted" style={{ fontSize: 12.5, textAlign: 'center' }}>
            Changes every {Math.round((qr?.rotationMs ?? 3000) / 1000)} seconds. Each scan is checked against the phone’s device key on this computer.
          </div>
        )}
      </div>

      <div className="col">
        <QrModeCard />
        <div className={`verify ${lastOk ? 'ok' : lastBad ? 'bad' : ''}`} role="status" aria-live="polite">
          <span className="big">{lastOk ? <CheckCircle2 size={22} /> : lastBad ? <XCircle size={22} /> : <ShieldCheck size={22} color="#6b6b76" />}</span>
          <div>
            {lastOk ? (
              <>
                <b>{lastOk.name} {lastOk.kind === 'check-in' ? 'checked in' : 'checked out'} · {lastOk.local}</b>
                Verified and saved to disk.
                {lastOk.warned ? <div className="warn-banner" style={{ marginTop: 8 }}>SERIOUS ATTENDANCE WARNING shown on the employee’s phone</div> : null}
              </>
            ) : lastBad ? (
              <>
                <b>Scan rejected ({lastBad.code})</b>
                {lastBad.message}
              </>
            ) : (
              <>
                <b>Waiting for scans</b>
                Verification results appear here instantly.
              </>
            )}
          </div>
        </div>

        <Card title="Reception display" sub="Show the attendance QR on a second screen or TV">
          <div className="row wrap">
            <Button variant="primary" disabled={!can('write')} onClick={() => run('open', () => call('shell.openTerminalWindow'), 'Reception display opened')}>
              <MonitorUp size={16} /> Open reception display
            </Button>
            <Button onClick={() => call('shell.closeTerminalWindow').catch(() => undefined)}>Close it</Button>
            <span className="muted" style={{ fontSize: 12.5 }}>Press F11 in that window for full screen. It shows no administrator controls.</span>
          </div>
        </Card>

        <Card title="Connection" sub="What phones connect to">
          <dl className="kv">
            <dt>Live channel</dt>
            <dd><Chip tone={live.status === 'live' ? 'mint' : live.status === 'connecting' ? 'amber' : 'rose'}>{live.status === 'live' ? 'Connected' : live.status === 'connecting' ? 'Connecting…' : 'Offline'}</Chip></dd>
            <dt>Phone address</dt>
            <dd className="mono">{health?.httpsUrl ?? '…'} <button className="btn ghost sm" aria-label="Copy address" onClick={() => health && navigator.clipboard.writeText(health.httpsUrl).then(() => toast.ok('Address copied'))}><Copy size={13} /></button></dd>
            <dt>First-time setup page</dt>
            <dd className="mono">{health?.setupUrl ?? '…'} <button className="btn ghost sm" aria-label="Copy setup address" onClick={() => health && navigator.clipboard.writeText(health.setupUrl).then(() => toast.ok('Address copied'))}><Copy size={13} /></button></dd>
            <dt>Phones connected</dt>
            <dd><Wifi size={14} style={{ verticalAlign: -2 }} /> {health?.wsClients ?? 0} live</dd>
            <dt>Certificate</dt>
            <dd className="mono" style={{ fontSize: 11.5 }}>{health?.tls.caFingerprint}</dd>
          </dl>
          <div className="muted" style={{ marginTop: 10, fontSize: 12.5 }}>New phones open the setup page once to trust the office certificate (needed for the camera), then use the phone address above.</div>
        </Card>

        <Card title="Latest check-ins" pad>
          {live.feed.length === 0 ? <div className="muted">Nothing yet this session.</div> : (
            <div className="timeline">
              {live.feed.slice(0, 6).map((f) => (
                <div key={f.id} className="tl-item">
                  <span className={`tl-ico ${f.kind === 'check-in' ? 'tone-mint' : 'tone-blue'}`}><CheckCircle2 size={15} /></span>
                  <div className="tl-main"><b>{f.name}</b> {f.kind === 'check-in' ? 'checked in' : 'checked out'}<div>{f.local}{f.classification === 'grace' ? ' · grace' : f.classification === 'late' || f.classification === 'very-late' ? ' · late' : f.classification === 'early-leave' ? ' · early leave' : ''}{f.warned ? ' · SERIOUS ATTENDANCE WARNING' : ''}</div></div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
