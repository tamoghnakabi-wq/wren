import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
const data = realpathSync(mkdtempSync(join(tmpdir(), 'wren-open-data-')));
process.env.WREN_DATA_DIR = data;
const { planOpen, performOpen } = await import('../src/main/open');
const { startApprovalBridge } = await import('../src/engines/common');
const { assessCall } = await import('@wren/core');

const project = realpathSync(mkdtempSync(join(tmpdir(), 'wren-open-project-')));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'wren-open-outside-')));
for (const f of ['report.pdf', 'chart.png', 'notes.md', 'data.csv', 'clip.mov', 'page.html', 'icon.svg', 'run.command', 'run.sh', 'deck.docx', 'Makefile']) writeFileSync(join(project, f), 'x');
mkdirSync(join(project, 'Built.app', 'Contents'), { recursive: true });
mkdirSync(join(project, 'Report.pdf.app'), { recursive: true }); // a folder named like a document
writeFileSync(join(outside, 'secret.pdf'), 'x');
symlinkSync(join(outside, 'secret.pdf'), join(project, 'link.pdf'));
symlinkSync(data, join(project, 'wren-data'));
const plan = (t: string, reveal = false, platform: NodeJS.Platform = 'darwin') => planOpen(t, reveal, [project], data, platform);

// The fix review (0.1.50): commands can't `open` things in the sandbox (A-D2), so Wren shows them itself, in
// ways that can't run anything an agent wrote.
describe('computer.open', () => {
  it('opens documents only in a fixed system viewer on macOS, never whatever claims the type', () => {
    expect(plan(join(project, 'report.pdf'))).toEqual({ kind: 'view', path: join(project, 'report.pdf'), viewer: '/System/Applications/Preview.app' });
    expect(plan('chart.png')).toMatchObject({ kind: 'view', viewer: '/System/Applications/Preview.app' });
    expect(plan('notes.md')).toMatchObject({ kind: 'view', viewer: '/System/Applications/TextEdit.app' });
    expect(plan('data.csv')).toMatchObject({ kind: 'view', viewer: '/System/Applications/TextEdit.app' });
    expect(plan('clip.mov')).toMatchObject({ kind: 'view', viewer: '/System/Applications/QuickTime Player.app' });
    // Windows: the user's own app for an allowed type (there's no sandbox to keep it out of anyway).
    expect(plan('report.pdf', false, 'win32')).toEqual({ kind: 'view', path: join(project, 'report.pdf') });
  });

  it('only reveals what could run code or isn’t known: apps, scripts, HTML, SVG, Office files, folders', () => {
    for (const f of ['Built.app', 'Report.pdf.app', 'page.html', 'icon.svg', 'run.command', 'run.sh', 'deck.docx', 'Makefile', '.']) {
      expect(plan(f), f).toMatchObject({ kind: 'reveal' });
    }
    expect(plan('report.pdf', true)).toMatchObject({ kind: 'reveal' });
  });

  it('refuses what is outside the allowed folders, Wren itself and links that aren’t plain http(s)', () => {
    expect(plan('link.pdf')).toHaveProperty('error'); // a link out of the allowed folder
    expect(plan(join(outside, 'secret.pdf'))).toHaveProperty('error');
    expect(plan('wren-data')).toHaveProperty('error');
    expect(plan('missing.pdf')).toHaveProperty('error');
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'vscode://file/x', 'x-apple.systempreferences:', 'http://user:pass@localhost:3000/']) {
      expect(plan(u), u).toHaveProperty('error');
    }
    expect(plan('http://localhost:3000/')).toEqual({ kind: 'url', url: 'http://localhost:3000/' });
    expect(plan('https://example.com/a?b=1')).toEqual({ kind: 'url', url: 'https://example.com/a?b=1' });
    // A Windows drive path is a path, not a link.
    expect(plan('C:\\Users\\me\\report.pdf', false, 'win32')).toHaveProperty('error');
  });

  it('does what was planned through the opener, and nothing else', async () => {
    const calls: string[] = [];
    const opener = {
      openExternal: async (u: string) => void calls.push(`url ${u}`),
      showItemInFolder: (p: string) => void calls.push(`reveal ${p}`),
      openPath: async (p: string) => (calls.push(`path ${p}`), ''),
      openWith: async (v: string, p: string) => (calls.push(`with ${v} ${p}`), 0),
    };
    expect((await performOpen({ kind: 'url', url: 'https://example.com/' }, opener)).isError).toBeFalsy();
    expect((await performOpen({ kind: 'view', path: '/p/r.pdf', viewer: '/System/Applications/Preview.app' }, opener)).isError).toBeFalsy();
    expect((await performOpen({ kind: 'reveal', path: '/p/Built.app' }, opener)).output).toMatch(/Showed/);
    expect(calls).toEqual(['url https://example.com/', 'with /System/Applications/Preview.app /p/r.pdf', 'reveal /p/Built.app']);
  });

  it('rates a document medium and any link high, a local one too; other schemes are refused', () => {
    expect(assessCall('computer.open', { target: '/p/report.pdf' }, 'desktop').risk).toBe('medium');
    expect(assessCall('computer.open', { target: '/p/x', reveal: true }, 'desktop').risk).toBe('medium');
    for (const u of ['http://localhost:3000', 'https://example.com']) expect(assessCall('computer.open', { target: u }, 'desktop').risk, u).toBe('high');
    expect(assessCall('computer.open', { target: 'file:///etc/passwd' }, 'desktop').blocked).toBeTruthy();
    expect(assessCall('computer.open', { target: 'C:\\p\\report.pdf' }, 'desktop').risk).toBe('medium');
  });

  it('reaches Claude Code through the bridge as its own request', async () => {
    const opens: unknown[] = [];
    const b = await startApprovalBridge(async () => ({ allow: false }), undefined, undefined, undefined, async (r) => (opens.push({ target: r.target, reveal: r.reveal }), { text: 'Opened.' }));
    try {
      const res = await fetch(b.url, { method: 'POST', headers: { authorization: `Bearer ${b.token}` }, body: JSON.stringify({ open: { target: 'report.pdf', reveal: 'yes' } }) });
      expect(await res.json()).toEqual({ text: 'Opened.' });
      expect(opens).toEqual([{ target: 'report.pdf', reveal: false }]); // only `true` reveals
    } finally {
      b.close();
    }
    // A bridge without an open handler (Grok's) says so.
    const g = await startApprovalBridge(async () => ({ allow: false }));
    try {
      const res = await fetch(g.url, { method: 'POST', headers: { authorization: `Bearer ${g.token}` }, body: JSON.stringify({ open: { target: 'x' } }) });
      expect(await res.json()).toMatchObject({ isError: true });
    } finally {
      g.close();
    }
  });
});
