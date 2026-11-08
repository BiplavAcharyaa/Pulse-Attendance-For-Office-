import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, safeStorage, session, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { PulseService } from '../server/service';
import type { SecretProtector } from '../server/storage/secrets';
import { FAKE_CAMERA, runSelfTest, writeFakeCamera } from './selftest';

const SCHEME = 'app';
const HOST = 'pulse';
const APP_URL = `${SCHEME}://${HOST}/index.html`;

protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

const isSelfTest = process.argv.includes('--selftest');
if (isSelfTest) {
  // Chromium's fake capture device lets the self-test exercise the real camera + QR decoding path.
  writeFakeCamera(null);
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-video-capture', FAKE_CAMERA);
}
let service: PulseService | null = null;
let mainWindow: BrowserWindow | null = null;
let terminalWindow: BrowserWindow | null = null;
const terminalContents = new Set<number>();
let quitting = false;

const rendererRoot = path.resolve(__dirname, '..', '..', 'dist-renderer');

function createProtector(): SecretProtector | undefined {
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    // On Linux Electron may fall back to a hard-coded key ("basic_text"); that is not protection.
    const backend = (safeStorage as unknown as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend?.();
    if (process.platform === 'linux' && (!backend || backend === 'basic_text' || backend === 'unknown')) return undefined;
    return {
      name: 'os-protected',
      encrypt: (b) => safeStorage.encryptString(b.toString('base64')),
      decrypt: (b) => Buffer.from(safeStorage.decryptString(b), 'base64'),
    };
  } catch {
    return undefined;
  }
}

/** Restrict the data folder to the current Windows user (best effort; failures are non-fatal and logged). */
function hardenPermissions(dir: string): void {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* ignore */
    }
    return;
  }
  const user = os.userInfo().username;
  execFile('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`, '/grant:r', 'SYSTEM:(OI)(CI)F'], { windowsHide: true }, (err) => {
    if (err) console.error('[pulse] could not restrict data-folder permissions:', err.message);
  });
}

function isTrustedSender(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  return url.startsWith(`${SCHEME}://${HOST}/`);
}

function createWindow(opts: { terminal: boolean }): BrowserWindow {
  const win = new BrowserWindow({
    width: opts.terminal ? 1280 : 1440,
    height: opts.terminal ? 800 : 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#FFFFFF',
    icon: path.join(rendererRoot, 'pulse-icon.png'),
    title: opts.terminal ? 'PULSE — Reception Display' : 'PULSE — Attendance Intelligence Terminal',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged || isSelfTest,
    },
  });
  win.setMenuBarVisibility(false);
  const wc = win.webContents;
  if (opts.terminal) terminalContents.add(wc.id);
  wc.on('destroyed', () => terminalContents.delete(wc.id));
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith(`${SCHEME}://${HOST}/`)) e.preventDefault();
  });
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') win.setFullScreen(!win.isFullScreen());
    if (input.type === 'keyDown' && input.key === 'Escape' && win.isFullScreen()) win.setFullScreen(false);
  });
  win.once('ready-to-show', () => win.show());
  void win.loadURL(opts.terminal ? `${APP_URL}?mode=terminal` : APP_URL);
  return win;
}

function registerAppProtocol(): void {
  const csp = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    'connect-src ws://127.0.0.1:*',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return new Response('Not found', { status: 404 });
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
    const full = path.resolve(rendererRoot, rel);
    if (!full.startsWith(rendererRoot + path.sep) || rel.includes('\0')) return new Response('Forbidden', { status: 403 });
    try {
      const res = await net.fetch(pathToFileURL(full).toString());
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', csp);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Cache-Control', 'no-store');
      return new Response(res.body, { status: res.status, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function lockDownSession(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  // The desktop app has no reason to talk to anything except its own bundle and the loopback live channel.
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url;
    const ok = u.startsWith(`${SCHEME}://`) || u.startsWith('ws://127.0.0.1:') || u.startsWith('devtools:') || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('file://');
    cb({ cancel: !ok });
  });
}

function registerIpc(svc: PulseService): void {
  ipcMain.handle('pulse:env', (e) => {
    if (!isTrustedSender(e)) throw new Error('Untrusted sender');
    return { platform: process.platform, version: app.getVersion(), mode: terminalContents.has(e.sender.id) ? 'terminal' : 'admin', exportsDir: svc.exportsDir, liveUrl: svc.live.url };
  });

  ipcMain.handle('pulse:terminal-key', (e) => {
    if (!isTrustedSender(e) || !terminalContents.has(e.sender.id)) return null;
    return svc.terminalKey;
  });

  ipcMain.handle('pulse:call', async (e, method: unknown, token: unknown, args: unknown) => {
    if (!isTrustedSender(e) || terminalContents.has(e.sender.id)) {
      return { ok: false, error: { code: 'FORBIDDEN', message: 'Not allowed from this window' } };
    }
    if (typeof method !== 'string' || method.length > 64) return { ok: false, error: { code: 'BAD_REQUEST', message: 'Bad request' } };
    const tok = typeof token === 'string' && token.length <= 200 ? token : undefined;

    // Operations that need the shell/OS are handled here, after the same session + role check.
    switch (method) {
      case 'shell.revealExport':
      case 'shell.openExports':
      case 'shell.openTerminalWindow':
      case 'shell.closeTerminalWindow': {
        try {
          svc.adminAuth.authorize(tok, method === 'shell.revealExport' || method === 'shell.openExports' ? 'export' : 'write');
        } catch (err) {
          const pe = err as { code?: string; message?: string };
          return { ok: false, error: { code: pe.code ?? 'UNAUTHENTICATED', message: pe.message ?? 'Please sign in' } };
        }
        if (method === 'shell.openExports') {
          const r = await shell.openPath(svc.exportsDir);
          return r ? { ok: false, error: { code: 'OPEN_FAILED', message: r } } : { ok: true, data: {} };
        }
        if (method === 'shell.revealExport') {
          const file = path.resolve(String((args as { filePath?: string })?.filePath ?? ''));
          if (!file.startsWith(path.resolve(svc.exportsDir) + path.sep) || !fs.existsSync(file)) {
            return { ok: false, error: { code: 'NOT_FOUND', message: 'That file is no longer in the exports folder' } };
          }
          shell.showItemInFolder(file);
          return { ok: true, data: {} };
        }
        if (method === 'shell.closeTerminalWindow') {
          terminalWindow?.close();
          return { ok: true, data: {} };
        }
        if (terminalWindow && !terminalWindow.isDestroyed()) {
          terminalWindow.focus();
        } else {
          terminalWindow = createWindow({ terminal: true });
          terminalWindow.on('closed', () => (terminalWindow = null));
        }
        return { ok: true, data: {} };
      }
      default:
        return svc.admin.call(method, tok, args, 'desktop');
    }
  });
}

async function boot(): Promise<void> {
  const dataDir = process.env.PULSE_DATA_DIR || path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  hardenPermissions(dataDir);
  lockDownSession();
  registerAppProtocol();
  Menu.setApplicationMenu(null);

  try {
    service = await PulseService.create({
      dataDir,
      protector: createProtector(),
      webRoot: rendererRoot,
      ...(isSelfTest ? { bindOverride: '127.0.0.1', httpsPortOverride: 0, setupPortOverride: 0, disableTimers: true } : {}),
    });
    await service.start();
  } catch (e) {
    const msg = (e as Error).message;
    console.error('[pulse] startup failed:', msg);
    if (!isSelfTest) dialog.showErrorBox('PULSE could not start', `${msg}\n\nData folder: ${dataDir}`);
    app.exit(1);
    return;
  }
  registerIpc(service);

  if (isSelfTest) {
    const code = await runSelfTest({ service, rendererRoot, createWindow: () => createWindow({ terminal: false }), appUrl: APP_URL, dataDir });
    await service.stop();
    app.exit(code);
    return;
  }
  mainWindow = createWindow({ terminal: false });
  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

if (!app.requestSingleInstanceLock() && !isSelfTest) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.on('before-quit', (e) => {
    if (quitting || !service) return;
    e.preventDefault();
    quitting = true;
    void service.stop().finally(() => app.exit(0));
  });
  app.on('window-all-closed', () => app.quit());
  void app.whenReady().then(boot);
  // Never expose remote debugging or accept unexpected URLs.
  app.on('web-contents-created', (_e, wc: WebContents) => {
    wc.on('will-redirect', (ev, url) => {
      if (!url.startsWith(`${SCHEME}://${HOST}/`) && !url.startsWith('https://127.0.0.1:')) ev.preventDefault();
    });
  });
}
