import { contextBridge, ipcRenderer } from 'electron';

// Exposes window.wren to the Wren web app only (checked against the origin the
// main process passed in). Each call is re-checked in the main process.

const origin = (process.argv.find((a) => a.startsWith('--wren-origin=')) ?? '').slice('--wren-origin='.length);
/** 'hidden' when the window has no title bar (macOS, 0.1.52+): the page makes room for the window buttons. */
const titleBar = process.argv.includes('--wren-titlebar=hidden') ? 'hidden' : undefined;

if (origin && location.origin === origin) {
  const invoke = (ch: string, ...args: unknown[]) => ipcRenderer.invoke(ch, ...args);
  contextBridge.exposeInMainWorld('wren', {
    titleBar,
    status: () => invoke('status'),
    link: () => invoke('link'),
    unlink: () => invoke('unlink'),
    getPolicy: () => invoke('getPolicy'),
    setPolicy: (p: unknown) => invoke('setPolicy', p),
    addFolder: () => invoke('addFolder'),
    chatgptSignIn: () => invoke('chatgptSignIn'),
    chatgptSignOut: () => invoke('chatgptSignOut'),
    openEngineLogin: (engine: string) => invoke('openEngineLogin', engine),
    checkUpdate: () => invoke('checkUpdate'),
    installUpdate: () => invoke('installUpdate'),
    openExternal: (url: string) => invoke('openExternal', url),
    localUsage: (opts?: { refresh?: boolean }) => invoke('localUsage', { refresh: opts?.refresh === true }),
    planLimits: (opts?: { refresh?: boolean }) => invoke('planLimits', { refresh: opts?.refresh === true }),
    decideApproval: (runId: string, approvalId: string) => invoke('decideApproval', runId, approvalId),
    onStatus: (cb: (s: unknown) => void) => {
      const listener = (_e: unknown, s: unknown) => cb(s);
      ipcRenderer.on('wren:status', listener);
      return () => ipcRenderer.removeListener('wren:status', listener);
    },
  });
}
