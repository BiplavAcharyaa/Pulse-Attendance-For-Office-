import QRCode from 'qrcode';
import { useEffect, useRef, useState } from 'react';
import type { TerminalQr } from '../../shared/types';

/** Draws the QR into an off-screen canvas, then cross-fades so rotation every few seconds feels smooth. */
export function QrFrame({ text, label }: { text: string | null; label?: string }) {
  const a = useRef<HTMLCanvasElement>(null);
  const b = useRef<HTMLCanvasElement>(null);
  const [front, setFront] = useState<0 | 1>(0);
  const first = useRef(true);
  const current = useRef<0 | 1>(0);

  useEffect(() => {
    if (!text) return;
    const target = first.current ? 0 : current.current === 0 ? 1 : 0;
    const canvas = target === 0 ? a.current : b.current;
    if (!canvas) return;
    QRCode.toCanvas(canvas, text, { errorCorrectionLevel: 'M', margin: 1, width: 560, color: { dark: '#111114', light: '#FFFFFF' } })
      .then(() => {
        first.current = false;
        current.current = target;
        setFront(target);
      })
      .catch(() => undefined);
  }, [text]);

  return (
    <div className="qr-frame" role="img" aria-label={label ?? 'QR code'}>
      <canvas ref={a} className={front === 0 ? '' : 'hide'} />
      <canvas ref={b} className={front === 1 ? '' : 'hide'} />
      <i className="qr-corner tl" />
      <i className="qr-corner tr" />
      <i className="qr-corner bl" />
      <i className="qr-corner br" />
    </div>
  );
}

export function useCountdown(qr: TerminalQr | null, skew: number): { fraction: number; seconds: number } {
  const [t, setT] = useState({ fraction: 1, seconds: 0 });
  useEffect(() => {
    if (!qr || qr.qrMode === 'permanent' || qr.rotationMs <= 0) return;
    let raf = 0;
    const tick = () => {
      const now = Date.now() + skew;
      const left = Math.max(0, qr.expiresAt - now);
      setT({ fraction: Math.min(1, left / qr.rotationMs), seconds: Math.ceil(left / 1000) });
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [qr, skew]);
  return t;
}

export function Countdown({ qr, skew }: { qr: TerminalQr | null; skew: number }) {
  const { fraction, seconds } = useCountdown(qr, skew);
  if (!qr || qr.qrMode === 'permanent') return null;
  const label = qr.mode === 'attendance' ? 'Next code in' : 'Registration code expires in';
  const shown = qr.mode === 'attendance' ? `${seconds}s` : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <div className="countdown" aria-live="off">
      <div className="bar">
        <i style={{ width: `${fraction * 100}%` }} />
      </div>
      <div className="lbl">
        <span>{label}</span>
        <b className="num">{shown}</b>
      </div>
    </div>
  );
}
