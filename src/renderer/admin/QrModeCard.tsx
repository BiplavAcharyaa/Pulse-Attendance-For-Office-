import { CheckCircle2, Infinity as InfinityIcon, RefreshCw, Timer } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { QrMode, QrModeView } from '../../shared/types';
import { useAuth, useRefreshOn } from './api';
import { Banner, Button, Card, Chip, Modal, useAction, when } from './ui';

const LABEL: Record<QrMode, string> = { permanent: 'Permanent QR Code', timer: 'Timer-Based QR Code' };

export function QrModeCard() {
  const { call, can } = useAuth();
  const { busy, run } = useAction();
  const [view, setView] = useState<QrModeView | null>(null);
  const [confirmRegen, setConfirmRegen] = useState(false);
  const canEdit = can('write');

  const load = useCallback(() => {
    call<QrModeView>('qrmode.get').then(setView).catch(() => undefined);
  }, [call]);
  useEffect(load, [load]);
  useRefreshOn(['qr.mode'], load, 50);

  if (!view) return <Card title="QR code mode">Loading…</Card>;

  const choose = async (mode: QrMode) => {
    if (mode === view.activeMode) return;
    const r = await run(`mode-${mode}`, () => call<{ qrMode: QrModeView }>('qrmode.set', { mode, expectedRevision: view.revision }), `${LABEL[mode]} is now active`);
    if (r) setView(r.qrMode);
    else load();
  };

  const regenerate = async () => {
    const r = await run('regen', () => call<{ qrMode: QrModeView }>('qrmode.regeneratePermanent', { expectedRevision: view.revision }), 'New permanent QR code generated');
    setConfirmRegen(false);
    if (r) setView(r.qrMode);
    else load();
  };

  const opt = (mode: QrMode, icon: React.ReactNode, title: string, text: string) => {
    const on = view.activeMode === mode;
    return (
      <button type="button" className={`qrmode-opt ${on ? 'on' : ''}`} aria-pressed={on} disabled={!canEdit || busy !== null} onClick={() => void choose(mode)}>
        <span className="qrmode-ico">{icon}</span>
        <span className="qrmode-txt">
          <b>{title}</b>
          <span>{text}</span>
        </span>
        {on ? <Chip tone="mint" icon={<CheckCircle2 size={13} />}>Active</Chip> : <Chip tone="grey">Inactive</Chip>}
      </button>
    );
  };

  return (
    <Card title="QR code mode" sub="Only one mode is active at a time" action={<Chip tone={view.activeMode === 'permanent' ? 'blue' : 'navy'}>Active: {LABEL[view.activeMode]}</Chip>}>
      <div className="col" style={{ gap: 12 }}>
        <div className="qrmode-grid" role="group" aria-label="QR code mode">
          {opt('permanent', <InfinityIcon size={18} />, 'Permanent QR Code', 'One fixed code that stays the same until an administrator regenerates it.')}
          {opt('timer', <Timer size={18} />, 'Timer-Based QR Code', `A rotating code that changes every ${view.rotationSeconds} seconds (change this in Settings).`)}
        </div>

        {view.activeMode === 'permanent' ? (
          <div className="banner info" style={{ margin: 0 }}>
            <InfinityIcon size={18} />
            <div className="grow">
              <b>Permanent code in use</b>
              Employees scan the same code every day. Rotating codes are rejected while this mode is active. Each scan is still verified against the phone’s device key and a one-time server check.
            </div>
          </div>
        ) : (
          <div className="banner info" style={{ margin: 0 }}>
            <Timer size={18} />
            <div className="grow">
              <b>Rotating code in use</b>
              The code changes automatically. Permanent codes are rejected while this mode is active.
            </div>
          </div>
        )}

        <dl className="kv">
          <dt>Permanent code</dt>
          <dd style={{ wordBreak: 'normal' }}>{view.hasPermanent ? `Generation ${view.permanentGeneration}, created ${when(view.permanentCreatedAt)} by ${view.permanentCreatedBy}` : 'Not created yet — it is created the first time you activate Permanent mode'}</dd>
          <dt>Last mode change</dt>
          <dd>{when(view.changedAt)} by {view.changedBy}</dd>
        </dl>

        <div className="row wrap">
          <Button disabled={!canEdit || !view.hasPermanent} loading={busy === 'regen'} onClick={() => setConfirmRegen(true)}>
            <RefreshCw size={15} /> Regenerate permanent code
          </Button>
          {!canEdit ? <span className="muted" style={{ fontSize: 12.5 }}>Only administrators can change the QR code mode.</span> : null}
        </div>
      </div>

      {confirmRegen ? (
        <Modal
          title="Regenerate the permanent QR code?"
          onClose={() => setConfirmRegen(false)}
          footer={<><Button onClick={() => setConfirmRegen(false)}>Cancel</Button><Button variant="danger" loading={busy === 'regen'} onClick={() => void regenerate()}>Regenerate</Button></>}
        >
          <Banner tone="warn" title="The current permanent code will stop working immediately">
            Anything you printed or displayed with the old code must be replaced with the new one.{view.activeMode === 'timer' ? ' Timer-Based mode stays active; the new code is used when you switch to Permanent mode.' : ''}
          </Banner>
        </Modal>
      ) : null}
    </Card>
  );
}
