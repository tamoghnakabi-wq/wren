import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
process.env.WREN_DATA_DIR = mkdtempSync(join(tmpdir(), 'wren-policy-'));
const { changedPolicy, loadPolicy, savePolicy } = await import('../src/main/config');

// W-142: the page (and anything running in it) can turn this computer's permissions off, but only the user,
// in a native prompt, can turn them on.
describe("changing this computer's permissions from the page", () => {
  const start = { folders: ['/work'], shell: false, browser: true, screen: false, remoteApprovals: false, localModelUrl: 'http://127.0.0.1:1234/v1', launchAtLogin: false };
  beforeEach(() => writeFileSync(join(process.env.WREN_DATA_DIR!, 'policy.json'), JSON.stringify(start)));

  it('turns a permission on only when the user says yes here', async () => {
    const asked: string[][] = [];
    const no = async (what: string[]) => (asked.push(what), false);
    let { next } = await changedPolicy({ shell: true, screen: true, remoteApprovals: true }, no);
    expect(next).toMatchObject({ shell: false, screen: false, remoteApprovals: false });
    expect(asked[0]).toHaveLength(3);
    ({ next } = await changedPolicy({ screen: true }, async () => true));
    expect(next.screen).toBe(true);
  });

  it('turns permissions off without asking', async () => {
    const { before, next } = await changedPolicy({ browser: false }, async () => {
      throw new Error('asked');
    });
    expect([before.browser, next.browser]).toEqual([true, false]);
  });

  it("asks once about what is actually turned on, and doesn't count a switch that was already on", async () => {
    const asked: string[][] = [];
    const { next } = await changedPolicy({ browser: true, shell: true }, async (what) => (asked.push(what), true));
    expect(asked).toEqual([['Run terminal commands in the folders you allowed']]);
    expect(next).toMatchObject({ browser: true, shell: true });
  });

  it('adds no folder, takes no remote model server and keeps switches strictly true or false', async () => {
    const { next } = await changedPolicy({ folders: ['/work', '/'], localModelUrl: 'https://example.com/v1', shell: 'yes' as never, launchAtLogin: 1 as never }, async () => true);
    expect(next).toMatchObject({ folders: ['/work'], localModelUrl: 'http://127.0.0.1:1234/v1', shell: false, launchAtLogin: false });
    savePolicy(next);
    expect(loadPolicy().folders).toEqual(['/work']);
  });

  it('uses the permissions as they are after the prompt (another change made meanwhile is kept)', async () => {
    const { next } = await changedPolicy({ screen: true }, async () => {
      savePolicy({ ...loadPolicy(), browser: false }); // turned off while the prompt was open
      return true;
    });
    expect(next).toMatchObject({ screen: true, browser: false });
  });
});
