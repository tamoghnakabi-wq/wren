import type { MenuItemConstructorOptions } from 'electron';
import type { UpdateState } from './updater';

// Wren's menu bar. On macOS the app menu has Check for Updates… under About and Settings… (⌘,) like
// other Mac apps, then the standard items; File, Edit, View and Window are Electron's usual ones (the
// menu Wren had before). On Windows, Settings… is in File and Check for Updates… in Help.

/** What the update item says: check, or install what's downloaded; nothing to choose while it downloads. */
export function updateMenuItem(u: UpdateState): { label: string; enabled: boolean } {
  if (u.ready) return { label: `Restart to Update to ${u.version}`, enabled: true };
  if (u.downloading) return { label: `Downloading Update ${u.version}…`, enabled: false };
  return { label: 'Check for Updates…', enabled: true };
}

export function menuTemplate(o: { platform: NodeJS.Platform; appName: string; update: UpdateState; onUpdate: () => void; onSettings: () => void }): MenuItemConstructorOptions[] {
  // Wren updates itself on macOS and Windows only.
  const updates = o.platform === 'darwin' || o.platform === 'win32';
  const u = updateMenuItem(o.update);
  const update: MenuItemConstructorOptions[] = updates ? [{ id: 'update', label: u.label, enabled: u.enabled, click: () => o.onUpdate() }] : [];
  const settings: MenuItemConstructorOptions = { id: 'settings', label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => o.onSettings() };
  const sep: MenuItemConstructorOptions = { type: 'separator' };
  if (o.platform === 'darwin') {
    return [
      { label: o.appName, submenu: [{ role: 'about' }, ...update, sep, settings, sep, { role: 'services' }, sep, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, sep, { role: 'quit' }] },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ];
  }
  return [
    { label: 'File', submenu: [settings, sep, { role: 'quit' }] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { label: 'Help', submenu: [...update, ...(updates ? [sep] : []), { role: 'about' }] },
  ];
}

export interface Prompt {
  type: 'info' | 'warning';
  message: string;
  detail: string;
  /** The first is the default; the last is what Escape picks. */
  buttons: string[];
}

export interface UpdatePromptDeps {
  /** This Wren's version. */
  version: string;
  check: () => Promise<UpdateState>;
  state: () => UpdateState;
  install: () => Promise<'started' | 'failed' | 'busy'>;
  /** Tasks running on this computer now (an update stops them). */
  running: () => number;
  /** Show a dialog; resolves with the index of the button chosen. */
  show: (p: Prompt) => Promise<number>;
}

const sentence = (t: string) => (/[.!?]$/.test(t) ? t : `${t}.`);
const at = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/**
 * What choosing the update item does (in the menu bar or the tray), with an answer each time: up to
 * date, couldn't check, downloading, or ready with an offer to restart. A download the user asked
 * about is followed to its end and they're told once how it went; updates Wren finds on its own stay
 * quiet (the item just turns into Restart to Update).
 */
export function updatePrompts(d: UpdatePromptDeps) {
  /** The version the user asked about, still downloading. */
  let following: string | null = null;
  let choosing = false;

  const ok = (p: Omit<Prompt, 'buttons'>) => d.show({ ...p, buttons: ['OK'] }).then(() => {});

  async function restart() {
    if ((await d.install()) !== 'failed') return;
    await ok({ type: 'warning', message: 'Wren couldn’t update', detail: sentence(d.state().error ?? 'The update could not be installed') });
  }

  async function offerRestart(u: UpdateState) {
    const n = d.running();
    const tasks = n ? ` ${n === 1 ? 'The task' : `The ${n} tasks`} running on this computer will be stopped.` : '';
    const choice = await d.show({ type: 'info', message: `Wren ${u.version} is ready to install`, detail: `Wren restarts to finish updating.${tasks}`, buttons: ['Restart Now', 'Later'] });
    if (choice === 0) await restart();
  }

  /** Where a download the user asked about stands now: still going (keep following), ready, or failed. */
  async function settle(version: string, u: UpdateState) {
    if (u.downloading) following = version;
    else if (u.ready) await offerRestart(u);
    else if (u.error) await ok({ type: 'warning', message: `Couldn’t download Wren ${u.version ?? version}`, detail: `${sentence(u.error)}${u.retryAt ? ` Wren will try again at ${at(u.retryAt)}.` : ''}` });
  }

  return {
    /** The update item was chosen. */
    async choose() {
      if (choosing) return; // its answer is still on screen
      choosing = true;
      try {
        const now = d.state();
        if (now.ready) return await restart(); // the item said Restart to Update
        if (now.downloading) return;
        const u = await d.check();
        if (u.ready) return await offerRestart(u);
        if (u.downloading) {
          await ok({ type: 'info', message: `Downloading Wren ${u.version}`, detail: 'Wren will ask you to restart once it’s ready.' });
          // It may have finished (or failed) while that was open: answered now rather than lost.
          return await settle(u.version!, d.state());
        }
        if (u.error) {
          const why = `${sentence(u.error)}${u.retryAt ? ` Wren will try again at ${at(u.retryAt)}.` : ''}`;
          return await ok({ type: 'warning', message: u.available ? `Couldn’t download Wren ${u.version}` : 'Couldn’t check for updates', detail: why });
        }
        await ok({ type: 'info', message: 'You’re up to date', detail: `Wren ${d.version} is the newest version.` });
      } finally {
        choosing = false;
      }
    },
    /** Every change of the update state. */
    changed(u: UpdateState) {
      if (!following || u.downloading) return;
      const v = following;
      following = null;
      void settle(v, u);
    },
  };
}
