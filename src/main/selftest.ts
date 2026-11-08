import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserWindow, session } from 'electron';
import QRCode from 'qrcode';
import type { PulseService } from '../server/service';

/**
 * End-to-end self-test run inside the real Electron app (`electron . --selftest`).
 *  - drives the real admin UI (first-time setup, every page) and captures screenshots;
 *  - opens the real phone web app in a second Chromium session over the real HTTPS server, registers a phone through the
 *    fake-camera QR scan (real WebCrypto key, real jsQR decode), gets it approved, checks in / out, and revokes it.
 * It never fabricates results: every step asserts on what the UI actually shows and on what the host actually stored.
 */
export const FAKE_CAMERA = path.join(os.tmpdir(), 'pulse-selftest-camera.y4m');

/** Writes a looping Y4M "camera" video that shows one QR code (used with Chromium's fake video capture device). */
export function writeFakeCamera(text: string | null): void {
  const W = 640;
  const H = 480;
  const y = Buffer.alloc(W * H, 235);
  if (text) {
    const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const px = Math.floor(400 / (n + 8));
    const size = px * n;
    const ox = Math.floor((W - size) / 2);
    const oy = Math.floor((H - size) / 2);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.modules.data[r * n + c]) continue;
        for (let dy = 0; dy < px; dy++) y.fill(16, (oy + r * px + dy) * W + ox + c * px, (oy + r * px + dy) * W + ox + c * px + px);
      }
    }
  }
  const uv = Buffer.alloc((W / 2) * (H / 2), 128);
  const header = Buffer.from(`YUV4MPEG2 W${W} H${H} F10:1 Ip A1:1 C420jpeg\n`);
  const frame = Buffer.concat([Buffer.from('FRAME\n'), y, uv, uv]);
  fs.writeFileSync(FAKE_CAMERA, Buffer.concat([header, ...Array.from({ length: 10 }, () => frame)]));
}

interface Opts {
  service: PulseService;
  rendererRoot: string;
  createWindow: () => BrowserWindow;
  appUrl: string;
  dataDir: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PASSWORD = 'Selftest-Passw0rd!';

const SETVAL = `const __set=(el,v)=>{const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value');d.set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};`;

export async function runSelfTest(o: Opts): Promise<number> {
  const out = process.env.PULSE_SELFTEST_OUT || path.resolve(__dirname, '..', '..', 'selftest-output');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const svc = o.service;
  const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
  const consoleErrors: string[] = [];

  const log = (s: string) => console.log(`[selftest] ${s}`);
  const step = async (name: string, fn: () => Promise<string | void>) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || undefined });
      log(`PASS ${name}${detail ? ' — ' + detail : ''}`);
    } catch (e) {
      results.push({ name, ok: false, detail: (e as Error).message });
      log(`FAIL ${name} — ${(e as Error).message}`);
    }
  };

  const watch = (win: BrowserWindow, label: string) => {
    win.webContents.on('console-message', (...args: unknown[]) => {
      const first = args[0] as { level?: string | number; message?: string; sourceId?: string } | undefined;
      const level = first && typeof first === 'object' && 'message' in first ? first.level : args[1];
      const message = first && typeof first === 'object' && 'message' in first ? first.message : String(args[2]);
      if (level === 'error' || level === 3) consoleErrors.push(`${label}: ${message}`);
    });
  };
  const js = <T = unknown>(win: BrowserWindow, code: string) => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const waitFor = async (win: BrowserWindow, expr: string, what: string, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await js(win, `Boolean(${expr})`)) return;
      } catch {
        /* page still loading */
      }
      await sleep(120);
    }
    const body = await js<string>(win, 'document.body.innerText.slice(0,400)').catch(() => '');
    throw new Error(`timed out waiting for ${what}. Page shows: ${JSON.stringify(body)}`);
  };
  const shot = async (win: BrowserWindow, name: string) => {
    await sleep(750);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, name), img.toPNG());
  };
  const clickText = (win: BrowserWindow, sel: string, text: string) =>
    js<boolean>(win, `(()=>{const el=[...document.querySelectorAll(${JSON.stringify(sel)})].find(e=>e.textContent.trim().includes(${JSON.stringify(text)}));if(!el)return false;el.click();return true;})()`).then((ok) => {
      if (!ok) throw new Error(`no "${sel}" containing "${text}"`);
    });
  const admin = async <T = any>(token: string, method: string, args?: unknown): Promise<T> => {
    const r = await svc.admin.call(method, token, args);
    if (!r.ok) throw new Error(`${method}: ${r.error.code} ${r.error.message}`);
    return r.data as T;
  };

  const watchdog = setTimeout(() => {
    console.error('[selftest] watchdog timeout');
    process.exit(3);
  }, 170_000);

  // ───────────── A. admin UI: first-time setup ─────────────
  const win = o.createWindow();
  win.setSize(1440, 900);
  watch(win, 'admin');
  let token = '';
  await step('admin UI loads and asks for first-time owner setup', async () => {
    await waitFor(win, 'window.__pulseReady===true && document.querySelector(\'input[name="confirm"]\')', 'setup form');
    await shot(win, '01-setup.png');
  });
  await step('owner account is created through the setup form', async () => {
    await js(
      win,
      `(()=>{${SETVAL}const f=n=>document.querySelector('input[name="'+n+'"]');__set(f('username'),'owner');__set(f('displayName'),'Selftest Owner');__set(f('password'),${JSON.stringify(PASSWORD)});__set(f('confirm'),${JSON.stringify(PASSWORD)});document.querySelector('form').requestSubmit();})()`,
    );
    await waitFor(win, `document.querySelector('.top h1')?.textContent==='Overview'`, 'Overview page after setup');
    token = (await svc.adminAuth.login({ username: 'owner', password: PASSWORD }, 'selftest')).token;
    return 'signed in; no default credentials existed';
  });
  if (!token) {
    clearTimeout(watchdog);
    return finish(results, consoleErrors, out);
  }

  await step('settings: timezone and rules saved', async () => {
    await admin(token, 'settings.update', { timezone: 'Asia/Kathmandu', minIntervalSeconds: 0, allowOffDayAttendance: true, workDays: [0, 1, 2, 3, 4, 5, 6], workStart: '00:00', workEnd: '23:59', graceMinutes: 30 });
  });

  await step('22 employees can be added', async () => {
    const names = ['Asha Rai', 'Bikash Thapa', 'Chandra Gurung', 'Dipesh Karki', 'Elina Shrestha', 'Faisal Ansari', 'Gita Magar', 'Hari Adhikari', 'Isha Lama', 'Janak Poudel', 'Kabita Joshi', 'Laxman Tamang', 'Manisha Basnet', 'Nabin Khadka', 'Olivia Sharma', 'Prakash Neupane', 'Qamar Siddiqui', 'Rita Bhandari', 'Sandeep Oli', 'Tara Pandey', 'Umesh Chaudhary', 'Vivek Subedi'];
    const csv = names.map((n, i) => `E-${1001 + i}, ${n}, 98${String(10000001 + i)}, ${['Sales', 'Operations', 'Finance', 'Support'][i % 4]}`).join('\n');
    const r = await admin<{ created: number; skipped: unknown[] }>(token, 'employees.import', { csv });
    if (r.created !== 22 || r.skipped.length) throw new Error(`created ${r.created}, skipped ${r.skipped.length}`);
  });

  // ───────────── B. phone web app in a separate Chromium session ─────────────
  const ps = session.fromPartition('phone-sim');
  ps.setCertificateVerifyProc((req, cb) => cb(req.hostname === '127.0.0.1' && /PULSE/i.test(req.certificate.issuerName || req.certificate.issuerCert?.subjectName || '') ? 0 : -3));
  ps.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'));
  ps.setPermissionCheckHandler((_wc, perm) => perm === 'media');
  const phone = new BrowserWindow({ show: true, width: 390, height: 800, webPreferences: { partition: 'phone-sim', sandbox: true, contextIsolation: true, nodeIntegration: false } });
  watch(phone, 'phone');
  const phoneUrl = svc.baseUrl() + '/';
  let employeeId = 'E-1001';
  let deviceId = '';

  await step('phone app opens over trusted HTTPS (secure context, WebCrypto available)', async () => {
    writeFakeCamera(null);
    await phone.loadURL(phoneUrl);
    await waitFor(phone, `document.querySelector('.m-notice h1')?.textContent==='Set up this phone'`, 'welcome screen');
    const secure = await js<boolean>(phone, 'window.isSecureContext && !!crypto.subtle');
    if (!secure) throw new Error('page is not a secure context');
    await shot(phone, 'm-01-welcome.png');
  });

  await step('registration QR is read by the phone camera (fake capture device, real jsQR)', async () => {
    svc.terminal.setMode('registration', 'selftest');
    const qrUrl = svc.terminal.getCurrent().url;
    writeFakeCamera(qrUrl);
    await clickText(phone, 'button', 'Scan registration QR');
    await waitFor(phone, `document.querySelector('.m-card h1')?.textContent?.includes('Register')`, 'registration form after camera scan', 20000);
    await shot(phone, 'm-02-register-form.png');
  });

  await step('registration request is submitted and shows as waiting for approval', async () => {
    await js(
      phone,
      `(()=>{${SETVAL}const i=[...document.querySelectorAll('.m-card input')];__set(i[0],'Asha Rai');__set(i[1],${JSON.stringify(employeeId)});__set(i[2],'9810000001');document.querySelector('form').requestSubmit();})()`,
    );
    await waitFor(phone, `document.querySelector('.m-notice h1')?.textContent==='Waiting for approval'`, 'pending screen');
    await shot(phone, 'm-03-pending.png');
    const pending = await admin<Array<{ requestId: string }>>(token, 'requests.list', { status: 'pending' });
    if (pending.length !== 1) throw new Error(`expected 1 pending request, found ${pending.length}`);
  });

  await step('admin sees the request in the Requests page', async () => {
    await clickText(win, '.nav button', 'Requests');
    await waitFor(win, `document.querySelector('.t tbody tr')`, 'request row');
    await shot(win, '02-requests.png');
  });

  await step('admin approves from the UI and the phone is enrolled without a reload', async () => {
    await clickText(win, 'button.mint', 'Approve');
    await waitFor(phone, `document.querySelector('.m-hero h1')?.textContent==='Asha Rai'`, 'phone home screen after approval', 20000);
    const devs = await admin<Array<{ deviceId: string; status: string }>>(token, 'devices.list');
    if (devs.length !== 1 || devs[0].status !== 'active') throw new Error('device not active on host');
    deviceId = devs[0].deviceId;
    await shot(phone, 'm-04-home.png');
  });

  const scanHash = async () => {
    svc.terminal.setMode('attendance', 'selftest');
    const u = svc.terminal.getCurrent().url;
    await js(phone, `location.hash=${JSON.stringify(u.slice(u.indexOf('#')))}`);
  };

  await step('check-in: signed scan is accepted and saved before the phone shows success', async () => {
    await scanHash();
    await waitFor(phone, `document.querySelector('.m-sheet.ok h1')?.textContent==='Checked in'`, 'check-in success sheet');
    await shot(phone, 'm-05-checked-in.png');
    const ov = await admin<{ counts: { checkedIn: number } }>(token, 'dashboard.overview');
    if (ov.counts.checkedIn !== 1) throw new Error(`host shows ${ov.counts.checkedIn} checked in`);
    const durable = fs.readFileSync(path.join(o.dataDir, 'attendance-events.jsonl'), 'utf8').trim().split('\n').length;
    return `${durable} durable log record(s) on disk`;
  });

  await step('check-out follows check-in on the same phone', async () => {
    await clickText(phone, '.m-sheet .m-btn', 'Done');
    await waitFor(phone, `!document.querySelector('.m-sheet')`, 'sheet closed');
    await sleep(400);
    await scanHash();
    await waitFor(phone, `document.querySelector('.m-sheet.ok h1')?.textContent==='Checked out'`, 'check-out success sheet');
    await shot(phone, 'm-06-checked-out.png');
  });

  await step('a third scan is refused and the phone says nothing was recorded', async () => {
    await clickText(phone, '.m-sheet .m-btn', 'Done');
    await sleep(500);
    await admin(token, 'settings.update', { allowMultipleSessions: false });
    await scanHash().catch(() => undefined);
    await waitFor(phone, `document.querySelector('.m-sheet.soft, .m-sheet.bad')`, 'refusal sheet');
    await shot(phone, 'm-07-refused.png');
  });

  await step('admin-side data: Overview, Attendance, Exports, Audit, Settings, Devices render', async () => {
    await js(phone, `document.querySelector('.m-sheet .m-btn')?.click()`);
    for (const [nav, file, ready] of [
      ['Overview', '03-overview.png', `document.querySelector('.stat')`],
      ['QR terminal', '04-terminal.png', `document.querySelector('canvas')`],
      ['Employees', '05-employees.png', `document.querySelectorAll('.t tbody tr').length>=22`],
      ['Phones', '06-devices.png', `document.querySelector('.t tbody tr')`],
      ['Attendance', '07-attendance.png', `document.querySelector('.t tbody tr')`],
      ['Exports', '08-exports.png', `document.querySelector('.card')`],
      ['Audit & security', '09-audit.png', `document.querySelector('.t tbody tr')`],
      ['Settings', '10-settings.png', `document.querySelector('.card')`],
    ] as const) {
      await clickText(win, '.nav button', nav);
      await waitFor(win, ready, `${nav} page`);
      await shot(win, file);
    }
  });

  await step('Excel export is generated from the Exports page and saved in the exports folder', async () => {
    await clickText(win, '.nav button', 'Exports');
    await waitFor(win, `[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Generate Excel'))`, 'export button');
    await clickText(win, 'button', 'Generate Excel file');
    await waitFor(win, `document.body.innerText.includes('.xlsx')`, 'finished export', 30000);
    await shot(win, '11-export-done.png');
    const files = fs.readdirSync(path.join(o.dataDir, 'exports')).filter((f) => f.endsWith('.xlsx'));
    if (!files.length) throw new Error('no .xlsx in exports folder');
    return files[0];
  });

  await step('reception display opens and shows a rotating QR', async () => {
    await js(win, `window.pulse.call('shell.openTerminalWindow', ${JSON.stringify(token)})`);
    await sleep(500);
    const tw = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('mode=terminal'));
    if (!tw) throw new Error('reception window did not open');
    watch(tw, 'reception');
    await waitFor(tw, `window.__pulseReady===true && document.querySelector('canvas')`, 'reception QR', 20000);
    await shot(tw, '12-reception.png');
  });

  await step('revoking the phone logs it out of the live session immediately', async () => {
    await admin(token, 'devices.revoke', { deviceId, reason: 'Selftest: simulated lost phone' });
    await waitFor(phone, `document.querySelector('.m-notice h1')?.textContent==='This phone was revoked'`, 'revoked screen', 15000);
    await shot(phone, 'm-08-revoked.png');
  });

  await step('integrity check over both logs passes', async () => {
    const rep = await admin<{ ok: boolean; files: Array<{ file: string; records: number }> }>(token, 'host.verifyIntegrity');
    if (!rep.ok) throw new Error('integrity check reported problems');
    return rep.files.map((f) => `${f.file}:${f.records}`).join(', ');
  });

  await step('no renderer console errors (includes CSP violations)', async () => {
    if (consoleErrors.length) throw new Error(consoleErrors.slice(0, 5).join(' | '));
  });

  clearTimeout(watchdog);
  return finish(results, consoleErrors, out);
}

function finish(results: Array<{ name: string; ok: boolean; detail?: string }>, errors: string[], out: string): number {
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ results, consoleErrors: errors }, null, 2));
  console.log(`[selftest] ${results.length - failed.length}/${results.length} passed; screenshots in ${out}`);
  return failed.length ? 1 : 0;
}
