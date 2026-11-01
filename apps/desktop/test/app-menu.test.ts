import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { menuTemplate, updateMenuItem, updatePrompts, type Prompt, type UpdatePromptDeps } from '../src/main/appmenu';
import type { UpdateState } from '../src/main/updater';

// The menu bar has Check for Updates… and Settings… where Mac and Windows apps keep them, and choosing
// the update item always gets an answer (up to date, couldn't check, downloading, ready to restart).

const noop = () => {};
const items = (m: MenuItemConstructorOptions) => (m.submenu as MenuItemConstructorOptions[]).map((i) => i.label ?? i.role ?? i.type);

describe('the menu bar', () => {
  it('macOS: Check for Updates… under About and Settings… (⌘,) in the Wren menu, the standard menus after it', () => {
    const onUpdate = vi.fn();
    const onSettings = vi.fn();
    const menu = menuTemplate({ platform: 'darwin', appName: 'Wren', update: { available: false }, onUpdate, onSettings });
    expect(menu[0].label).toBe('Wren');
    expect(items(menu[0])).toEqual(['about', 'Check for Updates…', 'separator', 'Settings…', 'separator', 'services', 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'quit']);
    expect(menu.slice(1).map((m) => m.role)).toEqual(['fileMenu', 'editMenu', 'viewMenu', 'windowMenu']); // as before
    const sub = menu[0].submenu as MenuItemConstructorOptions[];
    const settings = sub.find((i) => i.label === 'Settings…')!;
    expect(settings.accelerator).toBe('CmdOrCtrl+,');
    (sub.find((i) => i.id === 'update')!.click as () => void)();
    (settings.click as () => void)();
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onSettings).toHaveBeenCalledOnce();
  });

  it('Windows: Settings… in File and Check for Updates… in Help', () => {
    const menu = menuTemplate({ platform: 'win32', appName: 'Wren', update: { available: false }, onUpdate: noop, onSettings: noop });
    expect(menu.map((m) => m.label ?? m.role)).toEqual(['File', 'editMenu', 'viewMenu', 'windowMenu', 'Help']);
    expect(items(menu[0])).toEqual(['Settings…', 'separator', 'quit']);
    expect(items(menu[4])).toEqual(['Check for Updates…', 'separator', 'about']);
  });

  it('no update item where Wren doesn\'t update itself', () => {
    const menu = menuTemplate({ platform: 'linux', appName: 'Wren', update: { available: false }, onUpdate: noop, onSettings: noop });
    expect(items(menu[4])).toEqual(['about']);
  });

  it('the update item follows the update: check, downloading (can\'t be chosen), restart to update', () => {
    expect(updateMenuItem({ available: false })).toEqual({ label: 'Check for Updates…', enabled: true });
    expect(updateMenuItem({ available: false, error: 'Update check failed (503)' })).toEqual({ label: 'Check for Updates…', enabled: true });
    expect(updateMenuItem({ available: true, version: '0.1.39', downloading: true, received: 10, total: 100 })).toEqual({ label: 'Downloading Update 0.1.39…', enabled: false });
    expect(updateMenuItem({ available: true, version: '0.1.39', ready: true })).toEqual({ label: 'Restart to Update to 0.1.39', enabled: true });
    const menu = menuTemplate({ platform: 'darwin', appName: 'Wren', update: { available: true, version: '0.1.39', downloading: true }, onUpdate: noop, onSettings: noop });
    expect((menu[0].submenu as MenuItemConstructorOptions[]).find((i) => i.id === 'update')).toMatchObject({ label: 'Downloading Update 0.1.39…', enabled: false });
  });
});

/** Prompts with a scripted updater and dialogs; `answers` are the buttons chosen, in order (default: the first). */
function harness(o: { check?: () => Promise<UpdateState>; state?: UpdateState; install?: 'started' | 'failed' | 'busy'; running?: number; answers?: number[] } = {}) {
  let state: UpdateState = o.state ?? { available: false };
  const shown: Prompt[] = [];
  const open: (() => void)[] = [];
  const answers = [...(o.answers ?? [])];
  let hold = false;
  const installs = vi.fn(async () => {
    if (o.install === 'failed') state = { ...state, error: 'Some agent processes could not be confirmed stopped, so the update was not installed. Try again in a moment.' };
    return o.install ?? 'started';
  });
  const deps: UpdatePromptDeps = {
    version: '0.1.38',
    // Like the updater, a check's answer is its state from then on.
    check: async () => (state = await (o.check ?? (async () => state))()),
    state: () => state,
    install: installs,
    running: () => o.running ?? 0,
    show: (p) => {
      shown.push(p);
      const answer = answers.shift() ?? 0;
      // `hold`: the dialog stays open until the test closes it.
      return hold ? new Promise((r) => open.push(() => r(answer))) : Promise.resolve(answer);
    },
  };
  const prompts = updatePrompts(deps);
  return {
    prompts,
    shown,
    installs,
    set: (s: UpdateState) => {
      state = s;
      prompts.changed(s);
    },
    holdDialogs: () => (hold = true),
    close: () => open.shift()!(),
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('choosing Check for Updates…', () => {
  it('says so when Wren is up to date', async () => {
    const h = harness();
    await h.prompts.choose();
    expect(h.shown).toEqual([{ type: 'info', message: 'You’re up to date', detail: 'Wren 0.1.38 is the newest version.', buttons: ['OK'] }]);
  });

  it('says why it couldn\'t check, and when Wren tries again', async () => {
    const retryAt = new Date(2026, 10, 2, 9, 30).getTime();
    const h = harness({ check: async () => ({ available: false, error: 'Update check failed (503)', retryAt }) });
    await h.prompts.choose();
    expect(h.shown[0]).toMatchObject({ type: 'warning', message: 'Couldn’t check for updates' });
    expect(h.shown[0].detail).toMatch(/^Update check failed \(503\)\. Wren will try again at .*9.*30/);
  });

  it('a download it starts is followed: the user is asked to restart once it\'s ready, and Restart Now installs it', async () => {
    const found: UpdateState = { available: true, version: '0.1.39', downloading: true, received: 0, total: 100 };
    const h = harness({ check: async () => found });
    await h.prompts.choose();
    expect(h.shown).toEqual([{ type: 'info', message: 'Downloading Wren 0.1.39', detail: 'Wren will ask you to restart once it’s ready.', buttons: ['OK'] }]);
    h.set({ ...found, received: 50 });
    expect(h.shown).toHaveLength(1); // nothing new while it downloads
    h.set({ available: true, version: '0.1.39', ready: true });
    await settle();
    expect(h.shown[1]).toEqual({ type: 'info', message: 'Wren 0.1.39 is ready to install', detail: 'Wren restarts to finish updating.', buttons: ['Restart Now', 'Later'] });
    expect(h.installs).toHaveBeenCalledOnce();
    h.set({ available: true, version: '0.1.39', ready: true });
    await settle();
    expect(h.shown).toHaveLength(2); // asked once
  });

  it('Later leaves it for the Restart to Update item, and says which tasks a restart stops', async () => {
    const h = harness({ check: async () => ({ available: true, version: '0.1.39', downloading: true }), running: 2, answers: [0, 1] });
    await h.prompts.choose();
    h.set({ available: true, version: '0.1.39', ready: true });
    await settle();
    expect(h.shown[1].detail).toBe('Wren restarts to finish updating. The 2 tasks running on this computer will be stopped.');
    expect(h.installs).not.toHaveBeenCalled();
  });

  it('a download that finished while "Downloading" was still on screen is offered when it closes, not lost', async () => {
    const h = harness({ check: async () => ({ available: true, version: '0.1.39', downloading: true }), answers: [0, 1] });
    h.holdDialogs();
    const choosing = h.prompts.choose();
    await settle();
    h.set({ available: true, version: '0.1.39', ready: true }); // finished meanwhile
    await settle();
    expect(h.shown).toHaveLength(1); // no second dialog on top of the first
    h.close();
    await settle();
    expect(h.shown[1].message).toBe('Wren 0.1.39 is ready to install');
    h.close();
    await choosing;
  });

  it('a download that fails is reported once, with when Wren tries again', async () => {
    const h = harness({ check: async () => ({ available: true, version: '0.1.39', downloading: true }) });
    await h.prompts.choose();
    h.set({ available: true, version: '0.1.39', downloading: false, error: 'The download stopped receiving data for 2 minutes.', retryAt: Date.now() + 5 * 60_000 });
    await settle();
    expect(h.shown[1]).toMatchObject({ type: 'warning', message: 'Couldn’t download Wren 0.1.39' });
    expect(h.shown[1].detail).toMatch(/^The download stopped receiving data for 2 minutes\. Wren will try again at /);
    h.set({ available: true, version: '0.1.39', ready: true }); // the later retry, which nobody asked about
    await settle();
    expect(h.shown).toHaveLength(2);
  });

  it('an update Wren found on its own stays quiet', async () => {
    const h = harness();
    h.set({ available: true, version: '0.1.39', downloading: true });
    h.set({ available: true, version: '0.1.39', ready: true });
    await settle();
    expect(h.shown).toEqual([]);
  });

  it('an update already downloaded: the check offers the restart', async () => {
    const h = harness({ check: async () => ({ available: true, version: '0.1.39', ready: true }), answers: [1] });
    await h.prompts.choose();
    expect(h.shown.map((p) => p.message)).toEqual(['Wren 0.1.39 is ready to install']);
  });

  it('Restart to Update installs straight away, and says why when it couldn\'t', async () => {
    const ok = harness({ state: { available: true, version: '0.1.39', ready: true } });
    await ok.prompts.choose();
    expect(ok.installs).toHaveBeenCalledOnce();
    expect(ok.shown).toEqual([]);
    const failed = harness({ state: { available: true, version: '0.1.39', ready: true }, install: 'failed' });
    await failed.prompts.choose();
    expect(failed.shown).toEqual([{ type: 'warning', message: 'Wren couldn’t update', detail: 'Some agent processes could not be confirmed stopped, so the update was not installed. Try again in a moment.', buttons: ['OK'] }]);
    const busy = harness({ state: { available: true, version: '0.1.39', ready: true }, install: 'busy' });
    await busy.prompts.choose();
    expect(busy.shown).toEqual([]); // already installing: nothing to say
  });

  it('chosen again while its answer is still on screen, it doesn\'t ask twice', async () => {
    const check = vi.fn(async (): Promise<UpdateState> => ({ available: false }));
    const h = harness({ check });
    h.holdDialogs();
    const first = h.prompts.choose();
    await settle();
    await h.prompts.choose();
    expect(check).toHaveBeenCalledOnce();
    expect(h.shown).toHaveLength(1);
    h.close();
    await first;
  });
});
