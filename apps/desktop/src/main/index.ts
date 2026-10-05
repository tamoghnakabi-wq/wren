import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, session, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { deviceJson, publicJson } from './api';
import * as chatgpt from './chatgpt';
import { APP_ORIGIN, APP_URL, loadDevice, loadPolicy, permissionsReduced, saveDevice, savePolicy, type DeviceCredentials, type Policy } from './config';
import { closeBrowser, killAllJobs } from './host';
import { DeviceRunner, setApproveScript } from './runner';
import { Updater } from './updater';
import { approveScriptPath } from '../engines/claude-code';

const DIST = __dirname;
setApproveScript(approveScriptPath(DIST));

// `Wren --selftest`: boot, check the packaged pieces, print JSON, exit (used by CI on each OS).
if (process.argv.includes('--selftest')) {
  app.whenReady().then(async () => {
    const { existsSync } = await import('node:fs');
    const { safeStorage } = await import('electron');
    let playwright = false;
    try {
      await import('playwright-core');
      playwright = true;
    } catch {
      playwright = false;
    }
    const approve = approveScriptPath(DIST);
    const result = {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      appUrl: APP_URL,
      safeStorage: safeStorage.isEncryptionAvailable(),
      playwright,
      approveHelper: existsSync(approve),
      grokHook: existsSync(approve.replace(/mcp-approve\.mjs$/, 'grok-hook.mjs')),
      preload: existsSync(join(DIST, 'preload.js')),
    };
    process.stdout.write(JSON.stringify(result) + '\n');
    app.exit(result.playwright && result.approveHelper && result.grokHook && result.preload ? 0 : 1);
  });
}
app.setName('Wren');
if (process.env.WREN_DATA_DIR) app.setPath('userData', process.env.WREN_DATA_DIR);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let pairing: { pairId: string; pollSecret: string; userCode: string; timer: NodeJS.Timeout } | null = null;

const runner = new DeviceRunner(
  () => pushStatus(),
  (sessionId) => showWindow(`/app/s/${sessionId}`),
);
const updater = new Updater(() => pushStatus());

if (!process.argv.includes('--selftest') && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

function computerName(): string {
  try {
    if (process.platform === 'darwin') return execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim();
  } catch {
    /* fall through */
  }
  return hostname().replace(/\.local$/, '');
}

// ------------------------------------------------------------------ status

function status() {
  const d = loadDevice();
  const caps = runner.state.capabilities;
  const st = chatgpt.status();
  return {
    version: app.getVersion(),
    platform: process.platform,
    linked: !!d,
    deviceId: d?.deviceId,
    deviceName: runner.state.deviceName ?? computerName(),
    account: runner.state.account ?? d?.account,
    connected: runner.state.connected,
    runningRuns: runner.state.running,
    lastError: runner.state.lastError,
    chatgpt: st,
    engines: { claudeCode: caps?.claudeCode ?? { installed: false }, grokBuild: caps?.grokBuild ?? { installed: false } },
    local: caps?.local ?? { baseUrl: loadPolicy().localModelUrl, reachable: false, models: [] },
    update: updater.state,
  };
}

function pushStatus() {
  if (win && !win.isDestroyed()) win.webContents.send('wren:status', status());
  updateTray();
}

// ------------------------------------------------------------------ window

function showWindow(path?: string) {
  if (!win || win.isDestroyed()) createWindow(path);
  else {
    if (path) void win.loadURL(`${APP_URL}${path}`);
    win.show();
    win.focus();
    // Come back the way it was closed.
    if (restoreFullScreen) {
      restoreFullScreen = false;
      win.setFullScreen(true);
    }
  }
}

/**
 * Close-to-tray. On macOS, hiding a full-screen window leaves its Space black
 * with the app still frontmost, so leave full screen first and hide after.
 */
let restoreFullScreen = false;
function hideWindow() {
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen()) {
    restoreFullScreen = true;
    win.once('leave-full-screen', () => win?.hide());
    win.setFullScreen(false);
    return;
  }
  win.hide();
}

function createWindow(path = '/app') {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 380,
    minHeight: 560,
    title: 'Wren',
    backgroundColor: '#121110',
    show: false,
    webPreferences: {
      preload: join(DIST, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: 'persist:wren',
      spellcheck: true,
      additionalArguments: [`--wren-origin=${APP_ORIGIN}`],
    },
  });
  win.once('ready-to-show', () => win?.show());
  void win.loadURL(`${APP_URL}${path}`);

  // Only our own origin may load in the window; everything else opens in the browser.
  win.webContents.on('will-navigate', (e, url) => {
    if (new URL(url).origin !== APP_ORIGIN) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3) return; // aborted navigation
    void win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(offlinePage(desc, url))}`);
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideWindow();
      if (process.platform === 'win32' && Notification.isSupported() && !trayHintShown) {
        trayHintShown = true;
        new Notification({ title: 'Wren is still running', body: 'Agents keep working in the background. Use the tray icon to open or quit Wren.' }).show();
      }
    }
  });
}
let trayHintShown = false;

function offlinePage(desc: string, url: string) {
  return `<!doctype html><title>Wren</title><body style="font-family:system-ui;background:#121110;color:#f3f1ee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center;max-width:420px"><h2 style="font-weight:600">Can’t reach Wren</h2><p style="color:#b3ada6">${desc}. Check your connection — agents already running on this computer keep going.</p><button onclick="location.href='${url.replace(/'/g, '')}'" style="margin-top:12px;padding:10px 18px;border-radius:12px;border:0;background:#f3f1ee;color:#121110;font-weight:600">Try again</button></div></body>`;
}

// ------------------------------------------------------------------ tray

function trayIcon() {
  const img = nativeImage.createFromPath(join(DIST, '..', 'build', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  if (process.platform === 'darwin') img.setTemplateImage(true);
  return img;
}

function updateTray() {
  if (!tray) return;
  const s = status();
  const lines = [s.linked ? (s.connected ? `Connected as ${s.account?.email ?? 'you'}` : 'Connecting…') : 'Not linked yet', s.runningRuns ? `${s.runningRuns} task${s.runningRuns > 1 ? 's' : ''} running here` : 'No tasks running here'];
  tray.setToolTip(`Wren — ${lines.join(' · ')}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...lines.map((l) => ({ label: l, enabled: false })),
      { type: 'separator' },
      { label: 'Open Wren', click: () => showWindow() },
      { label: updater.state.ready ? `Restart to update to ${updater.state.version}` : 'Check for updates', click: () => (updater.state.ready ? installUpdate() : void updater.check()) },
      { type: 'separator' },
      { label: 'Stop all tasks on this computer', enabled: s.runningRuns > 0, click: () => runner.abortAll() },
      { label: 'Quit Wren', click: () => quit() },
    ]),
  );
}

function quit() {
  app.quit(); // cleanup happens in before-quit, which every way of quitting goes through
}

/** Stop everything this app started, once, however Wren is quit (⌘Q, menu, tray, update). */
let cleanedUp = false;
function shutdown() {
  quitting = true;
  if (cleanedUp) return;
  cleanedUp = true;
  runner.abortAll();
  killAllJobs();
  void closeBrowser();
}

function installUpdate() {
  updater.install(() => shutdown());
}

// ------------------------------------------------------------------ pairing

async function startPairing(): Promise<{ userCode: string; pairId: string }> {
  if (pairing) clearInterval(pairing.timer);
  const { status: code, data } = await publicJson<{ pairId: string; userCode: string; pollSecret: string; interval: number; error?: string }>('/api/device/pair/start', {
    name: computerName().slice(0, 60),
    platform: process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
    arch: process.arch,
    appVersion: app.getVersion(),
  });
  if (code !== 200) throw new Error(data.error ?? 'Could not start linking.');
  const timer = setInterval(async () => {
    if (!pairing) return;
    const r = await publicJson<{ status: string; deviceId?: string; token?: string; channel?: string; account?: DeviceCredentials['account']; supabase?: DeviceCredentials['supabase'] }>('/api/device/pair/poll', { pairId: pairing.pairId, pollSecret: pairing.pollSecret }).catch(() => null);
    if (!r) return;
    if (r.data.status === 'approved' && r.data.token) {
      clearInterval(timer);
      pairing = null;
      saveDevice({ deviceId: r.data.deviceId!, token: r.data.token, channel: r.data.channel!, account: r.data.account, supabase: r.data.supabase!, appUrl: APP_URL });
      runner.start();
      pushStatus();
    } else if (r.status === 410) {
      clearInterval(timer);
      pairing = null;
    }
  }, (data.interval ?? 2) * 1000);
  pairing = { pairId: data.pairId, pollSecret: data.pollSecret, userCode: data.userCode, timer };
  setTimeout(() => {
    if (pairing?.timer === timer) {
      clearInterval(timer);
      pairing = null;
    }
  }, 15 * 60_000);
  return { userCode: data.userCode, pairId: data.pairId };
}

// ------------------------------------------------------------------ IPC

function fromApp(e: IpcMainInvokeEvent) {
  const url = e.senderFrame?.url ?? '';
  try {
    return new URL(url).origin === APP_ORIGIN;
  } catch {
    return false;
  }
}

function handle(channel: string, fn: (...args: unknown[]) => unknown) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromApp(e)) throw new Error('Not allowed');
    return fn(...args);
  });
}

function registerIpc() {
  handle('status', () => status());
  handle('link', () => startPairing());
  handle('unlink', async () => {
    const ok = await dialog.showMessageBox({ type: 'question', message: 'Unlink this computer from your Wren account?', detail: 'Tasks will stop running here until you link it again.', buttons: ['Cancel', 'Unlink'], defaultId: 0, cancelId: 0 });
    if (ok.response !== 1) return;
    runner.abortAll();
    runner.stop();
    saveDevice(null);
    pushStatus();
  });
  handle('getPolicy', () => loadPolicy());
  handle('setPolicy', (p) => {
    const cur = loadPolicy();
    const next: Policy = { ...cur, ...(p as Partial<Policy>) };
    // Folders can only be added through the native picker, never from the page.
    next.folders = (next.folders ?? []).filter((f) => cur.folders.includes(f));
    if (typeof next.localModelUrl !== 'string' || !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(next.localModelUrl)) next.localModelUrl = cur.localModelUrl;
    savePolicy(next);
    app.setLoginItemSettings({ openAtLogin: !!next.launchAtLogin });
    if (permissionsReduced(cur, next)) runner.permissionsReduced();
    void runner.tick();
    return next;
  });
  handle('addFolder', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Allow agents to use a folder', buttonLabel: 'Allow folder', properties: ['openDirectory', 'createDirectory'] });
    const cur = loadPolicy();
    if (!r.canceled && r.filePaths[0] && !cur.folders.includes(r.filePaths[0])) {
      cur.folders.push(r.filePaths[0]);
      savePolicy(cur);
      void runner.tick();
    }
    return cur;
  });
  handle('chatgptSignIn', async () => {
    try {
      const s = await chatgpt.signIn();
      void runner.tick();
      pushStatus();
      return { ok: true, ...s };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  handle('chatgptSignOut', async () => {
    const r = await chatgpt.signOut();
    void runner.tick();
    pushStatus();
    if (!r.revoked) new Notification({ title: 'Signed out of ChatGPT on this computer', body: 'Remote revocation wasn’t confirmed. You can also disconnect Wren in ChatGPT Settings → Apps.' }).show();
  });
  handle('openEngineLogin', (engine) => openEngineLogin(engine === 'grok-build' ? 'grok-build' : 'claude-code'));
  handle('checkUpdate', () => updater.check());
  handle('installUpdate', () => installUpdate());
  // Remote approvals off: the web page can only *open* this native prompt; the user answers it here.
  handle('decideApproval', async (runId, approvalId) => {
    const id = /^[0-9a-f-]{36}$/i;
    if (typeof runId !== 'string' || typeof approvalId !== 'string' || !id.test(runId) || !id.test(approvalId)) return { error: 'Invalid approval.' };
    try {
      const a = await deviceJson<{ title: string; status: string; reason: string | null; args: Record<string, unknown>; agentName: string }>(`/api/device/runs/${runId}/approval-info`, { id: approvalId });
      if (a.status !== 'pending') return { error: `This request was already ${a.status}.` };
      const opts: Electron.MessageBoxOptions = {
        type: 'warning',
        title: 'Wren approval',
        message: `${a.agentName} wants to: ${a.title}`,
        detail: `${a.reason ? `This ${a.reason}.\n\n` : ''}${typeof a.args.command === 'string' ? a.args.command : JSON.stringify(a.args, null, 2).slice(0, 800)}`,
        buttons: ['Deny', 'Approve'],
        defaultId: 0,
        cancelId: 0,
      };
      const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
      await deviceJson(`/api/device/runs/${runId}/decide`, { id: approvalId, approve: r.response === 1 });
      return { decided: true };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
  handle('openExternal', (url) => {
    if (typeof url === 'string' && /^https:\/\//.test(url)) void shell.openExternal(url);
  });
}

function openEngineLogin(engine: 'claude-code' | 'grok-build') {
  const cmd = engine === 'claude-code' ? 'claude' : 'grok login';
  if (process.platform === 'darwin') {
    const f = join(app.getPath('temp'), `wren-${engine}-login.command`);
    writeFileSync(f, `#!/bin/bash\necho "Signing in to ${engine === 'claude-code' ? 'Claude Code (type /login if asked)' : 'Grok Build'}…"\n${cmd}\n`, { mode: 0o755 });
    void shell.openPath(f);
  } else if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', 'cmd.exe', '/k', cmd], { detached: true, stdio: 'ignore' }).unref();
  }
}

// ------------------------------------------------------------------ lifecycle

if (!process.argv.includes('--selftest')) app.whenReady().then(() => {
  session.fromPartition('persist:wren').setPermissionRequestHandler((wc, permission, cb) => {
    const ok = permission === 'notifications' || permission === 'clipboard-sanitized-write';
    cb(ok && new URL(wc.getURL()).origin === APP_ORIGIN);
  });
  registerIpc();
  createWindow();
  tray = new Tray(trayIcon());
  tray.on('click', () => showWindow());
  updateTray();
  if (loadDevice()) runner.start();
  else if (process.env.WREN_AUTOPAIR === '1') {
    // Development/test aid: print a pairing code to approve from a signed-in session.
    startPairing().then((p) => console.log(`WREN_PAIR_CODE=${p.userCode}`), (e) => console.error('pairing failed', e));
  }
  const policy = loadPolicy();
  if (policy.launchAtLogin) app.setLoginItemSettings({ openAtLogin: true });
  try {
    updater.cleanup();
  } catch {
    /* best effort */
  }
  setTimeout(() => void updater.check(), 15_000);
  setInterval(() => void updater.check(), 4 * 60 * 60_000);
});

app.on('activate', () => showWindow());
app.on('before-quit', () => shutdown());
app.on('window-all-closed', () => {
  // Keep running in the background (tray / menu bar) so agents can keep working.
});
