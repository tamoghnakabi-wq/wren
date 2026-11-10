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
  return {
    ...real,
    spawnSync: (cmd: string, ...rest: unknown[]) => (ran.push(cmd), (real.spawnSync as (...a: unknown[]) => unknown)(cmd, ...rest)),
    spawn: (cmd: string, ...rest: unknown[]) => (ran.push(cmd), (real.spawn as (...a: unknown[]) => unknown)(cmd, ...rest)),
  };
});
vi.mock('../src/engines/common', () => ({ findClis: () => [planted], engineEnv: () => ({}), claudeSupportsRestricted: () => true, cliHasFlag: () => true }));
vi.mock('../src/main/shellenv', async (orig) => ({ ...(await orig<typeof import('../src/main/shellenv')>()), toolEnv: async () => ({}) }));
vi.mock('../src/main/chatgpt', () => ({ status: () => ({ signedIn: false }) }));
process.env.WREN_DATA_DIR = join(dir, 'data');
const { detect, parseClaudeModels, parseGrokModels } = await import('../src/main/capabilities');

describe("reporting this computer's engines (W-183)", () => {
  it("never runs an engine program agents could have changed, even just to ask its version", async () => {
    const caps = await detect({ folders: [join(dir, 'project')], localModelUrl: 'http://127.0.0.1:9/v1' } as never);
    expect(caps.claudeCode).toMatchObject({ installed: true });
    expect(caps.claudeCode.untrusted).toMatch(/isn't where Claude Code's own installer puts it/);
    expect(caps.claudeCode.version).toBeUndefined();
    expect(caps.claudeCode.models).toBeUndefined(); // nor to list its models
    expect(ran).not.toContain(planted);
  });
});

describe("the engines' model lists", () => {
  it("reads Claude Code's models from its initialize answer, and nothing else from it", () => {
    const answer = {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: 'wren-models',
        response: {
          account: { email: 'someone@example.com' },
          models: [
            { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
            { value: 'opus', displayName: 'Opus 5.5', description: 'Best for everyday, complex tasks' },
            { value: 'claude-fable-5-2', displayName: 'Fable 5.2' },
            { value: 'claude-opus-4-6[1m]', displayName: 'Opus 4.6 (1M context)' },
            { value: 'opus', displayName: 'Opus again' },
            { value: '--dangerously-skip-permissions', displayName: 'Not a model' },
            { value: 42 },
          ],
        },
      },
    };
    const out = `{"type":"system","subtype":"hook"}\n${JSON.stringify(answer)}\n`;
    expect(parseClaudeModels(out)).toEqual([
      { id: 'default', name: 'Default (recommended)', description: 'Opus 5.5 · Best for everyday, complex tasks' },
      { id: 'opus', name: 'Opus 5.5', description: 'Best for everyday, complex tasks' },
      { id: 'claude-fable-5-2', name: 'Fable 5.2' },
      { id: 'claude-opus-4-6[1m]', name: 'Opus 4.6 (1M context)' },
    ]);
    expect(JSON.stringify(parseClaudeModels(out))).not.toContain('example.com');
    expect(parseClaudeModels('not json\n')).toEqual([]);
  });

  it('reads Grok Build\'s models from `grok models`', () => {
    const out = 'You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n    grok-code-fast-2\n\nTip: use -m\n';
    expect(parseGrokModels(out)).toEqual([
      { id: 'grok-4.7', name: 'grok-4.7', description: 'Grok Build’s default' },
      { id: 'grok-code-fast-2', name: 'grok-code-fast-2' },
    ]);
    expect(parseGrokModels('Not logged in. Run grok login.\n')).toEqual([]);
  });
});
