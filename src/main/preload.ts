// Sandboxed preload: exposes a tiny, fixed bridge. The renderer never sees Node, fs, or ipcRenderer itself.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('pulse', {
  call: (method: string, token: string | undefined, args?: unknown) => ipcRenderer.invoke('pulse:call', method, token, args),
  env: () => ipcRenderer.invoke('pulse:env'),
  terminalKey: () => ipcRenderer.invoke('pulse:terminal-key'),
});
