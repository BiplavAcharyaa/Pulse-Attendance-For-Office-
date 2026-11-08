import jsQR from 'jsqr';
import { CameraOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { parseScan, type ParsedScan } from '../../shared/protocol';

/** Full-screen camera scanner. Calls onScan once with the first valid PULSE code. */
export function Scanner({ onScan, onClose }: { onScan: (s: ParsedScan) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const done = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let last = 0;
    let lastHintAt = 0;

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('This browser cannot use the camera on this page. Open the HTTPS address shown on the office setup page.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      } catch (e) {
        const name = (e as DOMException).name;
        setError(
          name === 'NotAllowedError' || name === 'SecurityError'
            ? 'Camera permission was denied. Allow camera access for this site in your browser settings, then try again.'
            : name === 'NotFoundError'
              ? 'No camera was found on this phone.'
              : 'The camera could not be started. Close other apps that use the camera and try again.',
        );
        return;
      }
      if (stopped) return stream.getTracks().forEach((t) => t.stop());
      const v = video.current!;
      v.srcObject = stream;
      v.setAttribute('playsinline', 'true');
      await v.play().catch(() => undefined);

      const tick = (t: number) => {
        raf = requestAnimationFrame(tick);
        if (done.current || t - last < 70 || v.readyState < 2 || !ctx) return;
        last = t;
        const scale = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
        const w = Math.max(1, Math.round(v.videoWidth * scale));
        const h = Math.max(1, Math.round(v.videoHeight * scale));
        canvas.width = w;
        canvas.height = h;
        ctx.drawImage(v, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        const code = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        if (!code?.data) return;
        const parsed = parseScan(code.data);
        if (parsed) {
          done.current = true;
          navigator.vibrate?.(40);
          onScan(parsed);
        } else if (t - lastHintAt > 2500) {
          lastHintAt = t;
          setHint('That QR code is not a PULSE code.');
        }
      };
      raf = requestAnimationFrame(tick);
    })();

    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="scanner" role="dialog" aria-label="QR scanner">
      <video ref={video} muted playsInline />
      <div className="scan-frame" aria-hidden />
      <button className="scan-close" onClick={onClose} aria-label="Close scanner"><X size={22} /></button>
      <div className="scan-msg">
        {error ? (
          <div className="scan-err"><CameraOff size={20} /> {error}</div>
        ) : (
          <>
            <b>Point the camera at the office screen</b>
            <span>{hint || 'The code is read automatically'}</span>
          </>
        )}
      </div>
    </div>
  );
}
