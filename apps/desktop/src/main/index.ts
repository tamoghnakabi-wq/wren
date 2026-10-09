import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, session, shell, Tray, type IpcMainInvokeEvent } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { deviceJson, publicJson, revokeToken } from './api';
import * as chatgpt from './chatgpt';
import { APP_ORIGIN, changedPolicy, dataDir, APP_URL, loadDevice, loadPolicy, permissionsReduced, saveDevice, savePolicy, type Policy } from './config';
import { stopAllEngines } from '../engines/common';
import { closeBrowser, stopAllJobs } from './host';
import { createPairing, type PairAnswer, type PairStart } from './pairing';
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
    // `--update` also downloads the latest release through the updater's real path (network; CI).
    let updateDownload: { version: string; bytes: number } | { error: string } | undefined;
    if (process.argv.includes('--update')) updateDownload = await new Updater(() => {}).selfTestDownload().catch((e: Error) => ({ error: e.message }));
    // `--proctree`: something a command leaves running is found and stopped (CI, on each OS).
    // It also checks that an installer still at work is recognised by its process (W-96).
    const proctree = process.argv.includes('--proctree')
      ? await Promise.all([procTreeSelfTest(), installerSelfTest()]).then(
          ([tree, installer]) => ({ ...tree, installer, ok: tree.ok && installer.ok }),
          (e: Error) => ({ ok: false, error: e.message }),
        )
      : undefined;
    // `--browser`: the agent browser is found by its own report and stopped with all it started (CI, on each OS).
    const browser = process.argv.includes('--browser') ? await browserSelfTest().catch((e: Error) => ({ ok: false, error: e.message })) : undefined;
    const result = {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      appUrl: APP_URL,
      safeStorage: safeStorage.isEncryptionAvailable(),
      playwright,
      // The approval server Claude Code starts: it must run, read its private file and pass on a decision.
      approveHelper: existsSync(approve) && (await approveHelperSelfTest(approve).catch(() => false)),
      grokHook: existsSync(approve.replace(/mcp-approve\.mjs$/, 'grok-hook.mjs')),
      preload: existsSync(join(DIST, 'preload.js')),
      ...(updateDownload && { updateDownload }),
      ...(proctree && { proctree }),
      ...(browser && { browser }),
    };
    process.stdout.write(JSON.stringify(result) + '\n');
    app.exit(result.playwright && result.approveHelper && result.grokHook && result.preload && !(updateDownload && 'error' in updateDownload) && (!proctree || proctree.ok) && (!browser || browser.ok) ? 0 : 1);
  });
}
/** Start the approval server like Claude Code would and ask it once; true when Wren's answer comes back. */
async function approveHelperSelfTest(script: string): Promise<boolean> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { createServer } = await import('node:http');
  const dir = mkdtempSync(join(tmpdir(), 'wren-approve-test-'));
  const bridge = createServer((req, res) => {
    req.resume();
    req.on('end', () => res.end(JSON.stringify(req.headers.authorization === 'Bearer selftest' ? { behavior: 'allow' } : { behavior: 'deny', message: 'wrong token' })));
  });
  await new Promise<void>((r) => bridge.listen(0, '127.0.0.1', () => r()));
  const port = (bridge.address() as { port: number }).port;
  writeFileSync(join(dir, 'approval.json'), JSON.stringify({ url: `http://127.0.0.1:${port}/approve`, token: 'selftest' }));
  const child = spawn(process.execPath, [script], { env: { ELECTRON_RUN_AS_NODE: '1', WREN_APPROVAL_FILE: join(dir, 'approval.json') }, stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 20_000);
      child.on('error', () => resolve(false));
      let buf = '';
      child.on('exit', () => resolve(false));
      child.stdout.on('data', (d) => {
        buf += d;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          let m: { id?: number; result?: { content?: { text?: string }[] } };
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (m.id === 1) {
            send({ jsonrpc: '2.0', method: 'notifications/initialized' });
            send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Bash', input: { command: 'ls' } } } });
          } else if (m.id === 2) {
            resolve(/"behavior":"allow"/.test(m.result?.content?.[0]?.text ?? ''));
          }
        }
      });
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'wren-selftest', version: '1' } } });
    });
  } finally {
    clearTimeout(timer);
    child.kill();
    bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A stand-in installer recorded the way launchInstaller records the real one: recognised while it
 * runs, not once it has ended. On macOS it is started like the real one (bash running a script, the
 * only form that counts, W-120) and is also found without its pid (W-109); on Windows it is a
 * long-running system program. Uses its own marker in a temporary folder, never the data folder's
 * (a real update may be pending there) (W-107).
 */
async function installerSelfTest(): Promise<Record<string, unknown> & { ok: boolean }> {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'wren-installer-test-'));
  const marker = join(dir, 'update-pending.json');
  const win = process.platform === 'win32';
  const script = join(dir, 'install.sh');
  if (!win) writeFileSync(script, 'sleep 30\n', { mode: 0o700 });
  const cmd = win ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'PING.EXE') : '/bin/bash';
  const recorded = win ? cmd : script;
  // macOS: its own process group, so stopping it also stops the script's `sleep`.
  const child = spawn(cmd, win ? ['-n', '30', '127.0.0.1'] : [script], { stdio: 'ignore', windowsHide: true, detached: !win });
  const stop = () => {
    try {
      if (win) child.kill();
      else if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  };
  try {
    await new Promise<void>((ok, fail) => (child.once('spawn', ok), child.once('error', fail)));
    const probe = new Updater(() => {});
    writeFileSync(marker, JSON.stringify({ version: '0.0.0', pid: child.pid, installer: recorded, at: Date.now() }));
    const running = probe.installerState(marker);
    let withoutPid: string | undefined;
    if (!win) {
      writeFileSync(marker, JSON.stringify({ version: '0.0.0', installer: recorded, at: Date.now() }));
      withoutPid = probe.installerState(marker);
      writeFileSync(marker, JSON.stringify({ version: '0.0.0', pid: child.pid, installer: recorded, at: Date.now() }));
    }
    stop();
    await new Promise((r) => child.once('exit', r));
    const after = probe.installerState(marker);
    return { ok: running === 'running' && (win || withoutPid === 'running') && after === 'gone', running, withoutPid, after };
  } finally {
    stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Opens the agent browser (headless here) the way the host does, then has Playwright fail to close it:
 * Wren must find the browser by its own report and stop it with everything it started (W-138, W-139).
 */
async function browserSelfTest(): Promise<Record<string, unknown> & { ok: boolean }> {
  const { chromium } = await import('playwright-core');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { adoptBrowser, browserProcess, closeBrowser } = await import('./host');
  const { treeAlive } = await import('./proctree');
  const profile = mkdtempSync(join(tmpdir(), 'wren-browser-test-'));
  try {
    for (const channel of process.platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'msedge', 'chromium']) {
      const start = Date.now();
      const context = await chromium.launchPersistentContext(profile, { channel, headless: true }).catch(() => null);
      if (!context) continue;
      await context.newPage();
      const proc = await browserProcess(context, start);
      if (!proc) {
        await context.close().catch(() => {});
        return { ok: false, channel, found: false };
      }
      adoptBrowser({ controller: {} as never, close: () => new Promise<void>(() => {}), proc }); // as if Playwright hung
      const stopped = await closeBrowser(1000);
      const gone = !(await treeAlive(proc));
      return { ok: stopped && gone, channel, found: true, stopped, gone };
    }
    return { ok: false, error: 'no Chrome or Edge to test with' };
  } finally {
    await new Promise((r) => setTimeout(r, 500));
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      /* a temp folder */
    }
  }
}

/**
 * Starts a command that launches a hidden long-running child and exits at once. macOS/Linux: the
 * child is still counted as the command's (its process group) and is stopped. Windows: inside the
 * Job Object the child ends with the command; without it, it is found by parent id and stopped.
 */
async function procTreeSelfTest(): Promise<Record<string, unknown> & { ok: boolean }> {
  const { spawn } = await import('node:child_process');
  const { killTree, tracked, treeAlive } = await import('./proctree');
  const exited = (p: import('node:child_process').ChildProcess) => new Promise((r) => (p.exitCode !== null ? r(null) : p.once('exit', r)));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  if (process.platform !== 'win32') {
    const p = tracked(spawn('/bin/bash', ['-c', 'perl -e "select(undef,undef,undef,60)" & exit 0'], { detached: true, stdio: 'ignore' }));
    await exited(p);
    const leftover = await treeAlive(p);
    const stopped = await killTree(p, 0);
    const gone = !(await treeAlive(p));
    return { ok: leftover && stopped && gone, leftover, stopped, gone };
  }
  const { jobLibrary, spawnContained } = await import('./winjob');
  const child = "Start-Process -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 120'; 'started'";
  const dll = await jobLibrary();
  // With the same minimal environment agent commands get (agentEnv, W-108).
  const { agentEnv, toolEnv } = await import('./shellenv');
  const contained = await spawnContained(child, process.cwd(), agentEnv(process.env, await toolEnv()));
  await exited(contained);
  await sleep(2000);
  const endedWithCommand = !(await treeAlive(contained));
  const plain = tracked(spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', child], { windowsHide: true, stdio: 'ignore' }));
  await exited(plain);
  await sleep(1000);
  const orphanFound = await treeAlive(plain);
  const orphanStopped = (await killTree(plain, 0)) && !(await treeAlive(plain));
  return { ok: !!dll && endedWithCommand && orphanFound && orphanStopped, jobLibrary: !!dll, endedWithCommand, orphanFound, orphanStopped };
}

app.setName('Wren');
if (process.env.WREN_DATA_DIR) app.setPath('userData', process.env.WREN_DATA_DIR);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

const runner = new DeviceRunner(
  () => pushStatus(),
  (sessionId) => showWindow(`/app/s/${sessionId}`),
);
const updater = new Updater(() => pushStatus());

const primary = process.argv.includes('--selftest') || app.requestSingleInstanceLock();
if (!primary) {
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

let trayKey = '';

function updateTray() {
  if (!tray) return;
  const s = status();
  const u = updater.state;
  const lines = [s.linked ? (s.connected ? `Connected as ${s.account?.email ?? 'you'}` : 'Connecting…') : 'Not linked yet', s.runningRuns ? `${s.runningRuns} task${s.runningRuns > 1 ? 's' : ''} running here` : 'No tasks running here'];
  const updateLabel = u.ready ? `Restart to update to ${u.version}` : u.downloading ? `Downloading update ${u.version}…` : 'Check for updates';
  // Status is pushed every second while an update downloads; rebuild the menu only when it changes.
  const key = JSON.stringify([lines, updateLabel]);
  if (key === trayKey) return;
  trayKey = key;
  tray.setToolTip(`Wren — ${lines.join(' · ')}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...lines.map((l) => ({ label: l, enabled: false })),
      { type: 'separator' },
      { label: 'Open Wren', click: () => showWindow() },
      { label: updateLabel, enabled: !u.downloading, click: () => (updater.state.ready ? installUpdate() : void updater.check()) },
      { type: 'separator' },
      { label: 'Stop all tasks on this computer', enabled: s.runningRuns > 0, click: () => runner.abortAll() },
      { label: 'Quit Wren', click: () => quit() },
    ]),
  );
}

function quit() {
  app.quit(); // cleanup happens in before-quit, which every way of quitting goes through
}

/**
 * Stop everything this app started before it exits, however Wren is quit (⌘Q, menu, tray, an
 * update, logging out): runs end and report, then every engine CLI and command is stopped and
 * waited for, forced stops included. Quitting holds off until then, for at most QUIT_WAIT_MS.
 */
const QUIT_WAIT_MS = 15_000;
let cleanedUp = false;
let cleaning: Promise<void> | null = null;
function shutdown(e: Electron.Event) {
  quitting = true;
  if (cleanedUp) return;
  e.preventDefault();
  cleaning ??= (async () => {
    // Runs first (they stop their own work), then the browser, engines and commands side by side, so
    // a browser that won't close doesn't hold up the rest (W-124).
    const all = (async () => {
      const runs = await runner.suspend(8_000).catch(() => false);
      const [browser, engines, jobs] = await Promise.all([closeBrowser(), stopAllEngines().catch(() => false), stopAllJobs().catch(() => false)]);
      return runs && browser && engines && jobs;
    })().catch(() => false); // an error is "not confirmed", never a quit that doesn't happen
    const confirmed = await Promise.race([all, new Promise<false>((r) => setTimeout(() => r(false), QUIT_WAIT_MS))]);
    // Quitting never waits longer than that (W-78). What couldn't be confirmed stopped is reported at the
    // next start, not taken as done.
    if (!confirmed) {
      try {
        writeFileSync(join(dataDir(), 'quit-unconfirmed.json'), JSON.stringify({ at: Date.now() }));
      } catch {
        /* best effort */
      }
    }
    cleanedUp = true;
    app.quit();
    // A quit that began with SIGTERM (kill, a process manager) stalls here: Electron asks again
    // (before-quit) but never closes. Cleanup has had its turn, so save the session and exit.
    setTimeout(() => {
      session.fromPartition('persist:wren').flushStorageData();
      app.exit(0);
    }, 5000).unref();
  })();
}

function installUpdate() {
  // Every run, engine CLI and command is confirmed stopped before the update is staged; the rest
  // of the cleanup runs when the app quits. If anything won't stop, nothing is installed.
  return updater.install(
    async () => {
      const runsDone = await runner.suspend();
      const [browser, engines, jobs] = await Promise.all([closeBrowser(), stopAllEngines(), stopAllJobs()]);
      return runsDone && browser && engines && jobs;
    },
    () => runner.resume(),
  );
}

// ------------------------------------------------------------------ pairing

/** Development only: link without asking (`WREN_AUTOPAIR=1`); a packaged Wren always asks. */
const autopair = () => process.env.WREN_AUTOPAIR === '1' && !app.isPackaged;

/**
 * Whoever approves a pairing code gets this computer, and anything running in the page can start one.
 * So the user says here which account it goes to (W-142).
 */
async function confirmLink(email: string | undefined): Promise<boolean> {
  if (autopair()) return true;
  // Shown as plain text: no control or formatting characters from the account's address.
  const who = email?.replace(/[\p{C}\p{Z}]+/gu, ' ').trim().slice(0, 200) || 'this Wren account';
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Wren',
    message: `Link this computer to ${who}?`,
    detail: 'Agents of that account will be able to work on this computer, within the permissions you set here.',
    buttons: ['Cancel', 'Link'],
    defaultId: 0,
    cancelId: 0,
  };
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response === 1;
}

const pairing = createPairing({
  start: () =>
    publicJson<PairStart>('/api/device/pair/start', {
      name: computerName().slice(0, 60),
      platform: process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
      arch: process.arch,
      appVersion: app.getVersion(),
    }),
  poll: (pairId, pollSecret) => publicJson<PairAnswer>('/api/device/pair/poll', { pairId, pollSecret }),
  confirm: confirmLink,
  linked: () => !!loadDevice(),
  save: (d) => {
    saveDevice({ deviceId: d.deviceId!, token: d.token, channel: d.channel!, account: d.account, supabase: d.supabase!, appUrl: APP_URL });
    runner.start();
    pushStatus();
  },
  revoke: (token) => revokeToken(token),
});

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

async function confirmGrants(what: string[]): Promise<boolean> {
  const opts: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Wren',
    message: 'Allow agents on this computer to:',
    detail: what.map((w) => `• ${w}`).join('\n'),
    buttons: ['Cancel', 'Allow'],
    defaultId: 0,
    cancelId: 0,
  };
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response === 1;
}

function registerIpc() {
  handle('status', () => status());
  handle('link', () => {
    // Moving a linked computer to another account starts with Unlink (which asks here).
    if (loadDevice()) throw new Error('This computer is already linked. Unlink it first.');
    if (pairing.confirming) throw new Error('Answer the question in Wren’s window first.');
    return pairing.start();
  });
  handle('unlink', async () => {
    const ok = await dialog.showMessageBox({ type: 'question', message: 'Unlink this computer from your Wren account?', detail: 'Tasks will stop running here until you link it again.', buttons: ['Cancel', 'Unlink'], defaultId: 0, cancelId: 0 });
    if (ok.response !== 1) return;
    runner.abortAll();
    runner.stop();
    const d = loadDevice();
    saveDevice(null);
    pushStatus();
    if (d) await revokeToken(d.token, d.appUrl); // its token stops working too, not just forgotten here
  });
  handle('getPolicy', () => loadPolicy());
  handle('setPolicy', async (p) => {
    const { before, next } = await changedPolicy({ ...(p as Partial<Policy>) }, confirmGrants);
    savePolicy(next);
    app.setLoginItemSettings({ openAtLogin: next.launchAtLogin });
    if (permissionsReduced(before, next)) runner.permissionsReduced();
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

/** The last quit couldn't confirm every agent run, engine and command stopped (W-124): say so once. */
function reportUnconfirmedQuit() {
  try {
    const f = join(dataDir(), 'quit-unconfirmed.json');
    if (!existsSync(f)) return;
    rmSync(f, { force: true });
  } catch {
    return; // never in the way of starting
  }
  console.warn('[wren] the last quit could not confirm that every agent process stopped');
  if (Notification.isSupported()) {
    new Notification({ title: 'Wren', body: 'When Wren last quit, it couldn’t confirm that every agent command had stopped. If something is still running, you can end it in Activity Monitor (Task Manager on Windows).' }).show();
  }
}

/** No installer from an earlier Wren is at work, or it finished within `ms`. */
async function installerFinished(ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  for (;;) {
    if (!updater.installerRunning()) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

if (!process.argv.includes('--selftest')) app.whenReady().then(async () => {
  if (!primary) return; // quitting: another Wren is running (and owns the data folder)
  // Opened again while an update is being installed: start nothing (no agents, no window) and let
  // the installer finish; it opens the new version itself (W-96). Opening that new version is the
  // installer's last step, so one that is just finishing gets a few seconds to exit first.
  if (!(await installerFinished(8000))) {
    if (Notification.isSupported()) new Notification({ title: 'Wren is updating', body: 'It opens again by itself in a moment.' }).show();
    setTimeout(() => app.exit(0), 1500);
    return;
  }
  // Engine runs keep files in the data folder (Grok's hook plugin, Claude Code's approval files) and remove
  // them when they end; a crash can leave some behind (W-137). No run has started yet, so none are in use.
  for (const d of ['engines', 'approvals']) {
    try {
      rmSync(join(dataDir(), d), { recursive: true, force: true });
    } catch {
      /* never in the way of starting */
    }
  }
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
  else if (autopair()) {
    // Development/test aid: print a pairing code to approve from a signed-in session.
    pairing.start().then((p) => console.log(`WREN_PAIR_CODE=${p.userCode}`), (e) => console.error('pairing failed', e));
  }
  const policy = loadPolicy();
  if (policy.launchAtLogin) app.setLoginItemSettings({ openAtLogin: true });
  try {
    updater.cleanup();
  } catch {
    /* best effort */
  }
  reportUnconfirmedQuit();
  setTimeout(() => void updater.check(), 15_000);
  setInterval(() => void updater.check(), 4 * 60 * 60_000);
});

app.on('activate', () => showWindow());
app.on('before-quit', (e) => shutdown(e));
app.on('window-all-closed', () => {
  // Keep running in the background (tray / menu bar) so agents can keep working.
});
