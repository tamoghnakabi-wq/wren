import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {}, desktopCapturer: {}, screen: {} }));
process.env.WREN_DATA_DIR = mkdtempSync(join(tmpdir(), 'wren-browser-close-'));
const { adoptBrowser, closeBrowser } = await import('../src/main/host');

// W-136: a browser whose close fails isn't forgotten (a retried update would otherwise find "no browser"
// and go ahead); its processes, found by Wren's own profile folder, are stopped instead.
describe.skipIf(process.platform === 'win32')('closing the agent browser', () => {
  it('stops a browser that won\'t close, and only reports success once its processes are gone', async () => {
    const profile = join(process.env.WREN_DATA_DIR!, 'agent-browser');
    const stand = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)', '--', `--user-data-dir=${profile}`], { stdio: 'ignore' });
    await new Promise((r) => stand.once('spawn', r));
    const exited = new Promise((r) => stand.once('exit', r));
    let closes = 0;
    adoptBrowser({ controller: {} as never, close: async () => (closes++, Promise.reject(new Error('browser not responding'))) });
    const [a, b] = await Promise.all([closeBrowser(), closeBrowser()]); // at the same time: one attempt
    expect([a, b]).toEqual([true, true]);
    expect(closes).toBe(1);
    await exited; // ignored SIGTERM, so it took SIGKILL
    expect(await closeBrowser()).toBe(true); // nothing left to close
  }, 20_000);

});
