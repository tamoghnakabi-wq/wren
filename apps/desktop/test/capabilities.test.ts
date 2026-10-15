import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// A "claude" an agent could have written (in the temp folder, which agent commands may write).
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wren-caps-')));
const planted = join(dir, 'claude');
writeFileSync(planted, `#!/bin/sh\ntouch ${join(dir, 'ran')}\necho 9.9.9\n`);
chmodSync(planted, 0o755);
const ran: string[] = [];

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return { ...real, spawnSync: (cmd: string, ...rest: unknown[]) => (ran.push(cmd), (real.spawnSync as (...a: unknown[]) => unknown)(cmd, ...rest)) };
});
vi.mock('../src/engines/common', () => ({ findCli: () => planted, engineEnv: () => ({}) }));
vi.mock('../src/main/chatgpt', () => ({ status: () => ({ signedIn: false }) }));
process.env.WREN_DATA_DIR = join(dir, 'data');
const { detect } = await import('../src/main/capabilities');

describe("reporting this computer's engines (W-183)", () => {
  it("never runs an engine program agents could have changed, even just to ask its version", async () => {
    const caps = await detect({ folders: [join(dir, 'project')], localModelUrl: 'http://127.0.0.1:9/v1' } as never);
    expect(caps.claudeCode).toMatchObject({ installed: true });
    expect(caps.claudeCode.untrusted).toMatch(/may change/);
    expect(caps.claudeCode.version).toBeUndefined();
    expect(ran).not.toContain(planted);
  });
});
