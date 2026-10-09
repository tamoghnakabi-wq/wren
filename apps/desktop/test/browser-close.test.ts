import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {}, desktopCapturer: {}, screen: {} }));
process.env.WREN_DATA_DIR = mkdtempSync(join(tmpdir(), 'wren-browser-close-'));
const { adoptBrowser, browserProcess, closeBrowser } = await import('../src/main/host');
const { external } = await import('../src/main/proctree');

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const cleanup: number[] = [];
afterEach(() => {
  for (const pid of cleanup.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
});

/** Node that ignores SIGTERM and runs until killed; `extra` ends up in its arguments. */
const STUBBORN = 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)';

/**
 * A stand-in browser as Playwright starts one: detached (leading its own process group), ignoring
 * SIGTERM, with a helper in its group that ignores SIGTERM too and has none of the browser's arguments.
 */
async function standInBrowser() {
  const start = Date.now();
  const leader = spawn(process.execPath, ['-e', `const c=require("child_process").spawn(process.execPath,["-e",${JSON.stringify(STUBBORN)}],{stdio:"ignore"}); console.log(c.pid); ${STUBBORN}`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const helper = await new Promise<number>((r) => leader.stdout!.once('data', (d) => r(Number(String(d).trim()))));
  cleanup.push(leader.pid!, helper);
  return { leader, helper, proc: external(leader.pid!, start) };
}

describe.skipIf(process.platform === 'win32')('closing the agent browser', () => {
  // W-136: a browser whose close fails isn't forgotten (a retried update would otherwise find "no browser"
  // and go ahead). W-138/W-139: what is stopped is the browser's own process group, helpers without its
  // arguments included, and nothing else.
  it('stops the whole group of a browser that won\'t close, and nothing else', async () => {
    const { leader, helper, proc } = await standInBrowser();
    const profile = join(process.env.WREN_DATA_DIR!, 'agent-browser');
    // Another program that merely mentions the profile (or a folder starting the same way) isn't the browser.
    const decoy = spawn(process.execPath, ['-e', STUBBORN, '--', `--user-data-dir=${profile}`, `--user-data-dir=${profile}-backup`], { stdio: 'ignore' });
    await new Promise((r) => decoy.once('spawn', r));
    cleanup.push(decoy.pid!);
    let closes = 0;
    adoptBrowser({ controller: {} as never, close: async () => (closes++, Promise.reject(new Error('browser not responding'))), proc });
    const [a, b] = await Promise.all([closeBrowser(), closeBrowser()]); // at the same time: one attempt
    expect([a, b]).toEqual([true, true]);
    expect(closes).toBe(1);
    expect(leader.exitCode !== null || leader.signalCode !== null || (await new Promise((r) => leader.once('exit', r)))).toBeTruthy();
    expect(alive(helper)).toBe(false); // ignored SIGTERM, had no flag: stopped as part of the group
    expect(alive(decoy.pid!)).toBe(true);
    expect(await closeBrowser()).toBe(true); // nothing left to close
  }, 20_000);

  it('doesn\'t stop a program the browser\'s old process id now belongs to', async () => {
    // A process that isn't Wren's child stands for an id handed to another program after the browser went.
    const sh = spawn('/bin/sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const other = await new Promise<number>((r) => sh.stdout!.once('data', (d) => r(Number(String(d).trim()))));
    cleanup.push(other);
    await new Promise((r) => sh.once('exit', r));
    adoptBrowser({ controller: {} as never, close: async () => Promise.reject(new Error('gone')), proc: external(other, 0) });
    expect(await closeBrowser()).toBe(true); // its own browser is gone
    expect(alive(other)).toBe(true);
  }, 20_000);

  it('stays unconfirmed (and known) when the browser\'s process is unknown and it won\'t close in time', async () => {
    let close: () => Promise<void> = () => new Promise(() => {}); // hangs
    adoptBrowser({ controller: {} as never, close: () => close(), proc: null });
    expect(await closeBrowser(200)).toBe(false);
    close = async () => {};
    expect(await closeBrowser(200)).toBe(true); // tried again, not forgotten
    expect(await closeBrowser(200)).toBe(true);
  });

  it('never rejects', async () => {
    adoptBrowser({
      controller: {} as never,
      close: () => {
        throw new Error('synchronous failure');
      },
      proc: null,
    });
    expect(await closeBrowser(200)).toBe(false);
    adoptBrowser({ controller: {} as never, close: async () => {}, proc: null });
  });
});

// The real browser reports its own process, which leads the group its helpers are in (opt-in: needs Chrome).
describe.skipIf(!process.env.WREN_BROWSER_TEST || process.platform === 'win32')('a real agent browser', () => {
  it('is found by its own report and stopped with every helper', async () => {
    const { chromium } = await import('playwright-core');
    const start = Date.now();
    const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'wren-browser-real-')), { channel: 'chrome', headless: true });
    await context.newPage();
    const proc = await browserProcess(context, start);
    expect(proc?.pid).toBeGreaterThan(0);
    adoptBrowser({ controller: {} as never, close: () => new Promise(() => {}), proc }); // Playwright hangs
    expect(await closeBrowser(200)).toBe(true);
    expect(() => process.kill(-proc!.pid!, 0)).toThrow(); // no process of its group is left
  }, 60_000);
});
