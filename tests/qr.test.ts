import jsQR from 'jsqr';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { ChallengeAuthority } from '../src/server/tokens';
import { parseScan } from '../src/shared/protocol';

/** Renders a QR to an RGBA bitmap exactly the way a camera frame would present it (with quiet zone), then decodes it. */
function decode(text: string, px = 6) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const quiet = 4;
  const side = (n + quiet * 2) * px;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      if (!qr.modules.data[r * n + c]) continue;
      for (let dy = 0; dy < px; dy++)
        for (let dx = 0; dx < px; dx++) {
          const i = (((r + quiet) * px + dy) * side + (c + quiet) * px + dx) * 4;
          data[i] = 11; data[i + 1] = 31; data[i + 2] = 58;
        }
    }
  return jsQR(data, side, side)?.data ?? null;
}

describe('QR round trip', () => {
  const authority = new ChallengeAuthority(Buffer.alloc(32, 7), 'hostid1234');
  it('a rotating attendance QR decodes back to the same URL and parses as an attendance token', () => {
    const { token } = authority.issue(Date.now());
    const url = `https://192.168.1.20:8443/#a=${token}`;
    const text = decode(url);
    expect(text).toBe(url);
    expect(parseScan(text!)).toEqual({ kind: 'attendance', token });
  });
  it('rejects foreign QR codes', () => {
    expect(parseScan(decode('https://example.com/#a=evil')!)).toBeNull();
    expect(parseScan(decode('WIFI:S:office;T:WPA;P:secret;;')!)).toBeNull();
  });
});
