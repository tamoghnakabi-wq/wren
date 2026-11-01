import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const home = vi.hoisted(() => ({ dir: '' }));
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
// The first-install folder (~/Wren) is made in a temporary home, never the real one.
vi.mock('node:os', async (orig) => ({ ...(await orig<typeof import('node:os')>()), homedir: () => home.dir }));
process.env.WREN_DATA_DIR = mkdtempSync(join(tmpdir(), 'wren-policy-read-'));
home.dir = mkdtempSync(join(tmpdir(), 'wren-home-'));
const { changedPolicy, loadPolicy, readPolicy, savePolicy } = await import('../src/main/config');

const policyFile = join(process.env.WREN_DATA_DIR, 'policy.json');
const workspace = join(home.dir, 'Wren');
const restrictive = { folders: [], shell: false, browser: false, screen: false, remoteApprovals: false, localModelUrl: 'http://127.0.0.1:1234/v1', launchAtLogin: false };
// A file can't be made unreadable to root, and Windows doesn't take read permission away with chmod.
const noChmod = process.platform === 'win32' || process.getuid?.() === 0;

beforeEach(() => {
  rmSync(policyFile, { force: true });
  rmSync(workspace, { recursive: true, force: true });
});
afterEach(() => {
  if (existsSync(policyFile)) chmodSync(policyFile, 0o600);
});

// W-201: only a missing policy file is a first start. A saved policy that can't be read, or isn't one, must not
// turn into the permissive first-install policy, and turning a permission on over it must still ask natively.
describe("reading this computer's permissions", () => {
  it('starts a new install with the first-install defaults and ~/Wren', () => {
    expect(loadPolicy()).toEqual({ folders: [workspace], shell: true, browser: true, screen: false, remoteApprovals: true, localModelUrl: 'http://127.0.0.1:1234/v1', launchAtLogin: false });
    expect(existsSync(workspace)).toBe(true);
    expect(readPolicy().state).toBe('new');
  });

  it('fills in keys an older file lacks, and ignores keys it doesn’t know', () => {
    writeFileSync(policyFile, JSON.stringify({ folders: ['/work'], shell: false, theme: 'dark' }));
    expect(loadPolicy()).toMatchObject({ folders: ['/work'], shell: false, browser: true, screen: false, remoteApprovals: true, localModelUrl: 'http://127.0.0.1:1234/v1', launchAtLogin: false });
    expect(readPolicy().state).toBe('saved');
    writeFileSync(policyFile, JSON.stringify({ shell: false })); // never listed folders: ~/Wren, as before
    expect(loadPolicy()).toMatchObject({ folders: [workspace], shell: false });
  });

  it('keeps a saved restrictive policy as it is', () => {
    const saved = { ...restrictive, folders: ['/work', '/data'], localModelUrl: 'http://localhost:11434/v1' };
    writeFileSync(policyFile, JSON.stringify(saved));
    expect(readPolicy()).toEqual({ policy: saved, state: 'saved' });
    expect(existsSync(workspace)).toBe(false);
  });

  it.each([
    ['invalid JSON', '{"folders": ["/work"], "shell": tru'],
    ['an empty file', ''],
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"policy"'],
    ['a switch that isn’t true or false', '{"folders": ["/work"], "shell": "yes"}'],
    ['a model server that isn’t text', '{"folders": [], "localModelUrl": 1}'],
    ['folders that aren’t a list', '{"folders": "/work"}'],
    ['a folder that isn’t text', '{"folders": ["/work", 3]}'],
    ['a relative folder path', '{"folders": ["work"]}'],
  ])('allows nothing when the saved file is %s', (_what, text) => {
    writeFileSync(policyFile, text);
    expect(loadPolicy()).toEqual(restrictive);
    expect(existsSync(workspace)).toBe(false);
    expect(readPolicy()).toEqual({ policy: restrictive, state: 'unreadable' });
  });

  it.skipIf(noChmod)('allows nothing when the saved file can’t be read, until a change is saved over it', () => {
    writeFileSync(policyFile, JSON.stringify({ ...restrictive, folders: ['/work'], shell: true }));
    chmodSync(policyFile, 0o000);
    expect(loadPolicy()).toEqual(restrictive);
    expect(readPolicy().state).toBe('unreadable');
    expect(existsSync(workspace)).toBe(false);
    savePolicy({ ...restrictive, browser: true }); // what Settings does with any change
    expect(readPolicy()).toEqual({ policy: { ...restrictive, browser: true }, state: 'saved' });
  });
});

describe('turning a permission on over a policy file that can’t be used', () => {
  const asksBeforeShell = async () => {
    const asked: string[][] = [];
    let { next } = await changedPolicy({ shell: true }, async (what) => (asked.push(what), false));
    expect(asked).toEqual([['Run terminal commands in the folders you allowed']]);
    expect(next).toEqual(restrictive);
    ({ next } = await changedPolicy({ shell: true }, async (what) => (asked.push(what), true)));
    expect(asked).toHaveLength(2);
    expect(next).toEqual({ ...restrictive, shell: true });
  };

  it.each([
    ['invalid JSON', '{"shell": false, "folders": ["/work"]'],
    ['a wrong-typed key', '{"shell": "no", "folders": ["/work"]}'],
  ])('asks natively when the saved file is %s', async (_what, text) => {
    writeFileSync(policyFile, text);
    await asksBeforeShell();
  });

  it.skipIf(noChmod)('asks natively when the saved file can’t be read', async () => {
    writeFileSync(policyFile, JSON.stringify({ ...restrictive, folders: ['/work'] }));
    chmodSync(policyFile, 0o000);
    await asksBeforeShell();
  });
});
