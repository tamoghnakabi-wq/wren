import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import type { ToolResult } from '@wren/core';
import { refuseToShow } from './confined';
import { confinePath } from './paths';

// `computer.open`: showing the user a file or a web page, which the sandbox no longer lets commands do with
// `open` (LaunchServices starts its target outside any profile, A-D2). Wren does it from its own process, after
// the approval flow (rated in core policy.ts), and only in ways that can't run anything an agent wrote:
// documents open in a fixed system viewer chosen by Wren (never "whatever is registered for .pdf", which an app
// the agent built could claim), everything else is only revealed in Finder or Explorer, and links open only if
// they are plain http(s) (0.1.50 review).

/** What an open does, decided before anything is shown. */
export type OpenPlan = { kind: 'url'; url: string } | { kind: 'view'; path: string; viewer?: string } | { kind: 'reveal'; path: string };

/** macOS: the system apps (on the sealed system volume) Wren opens each kind of document with. */
const MAC_VIEWERS = {
  preview: '/System/Applications/Preview.app',
  text: '/System/Applications/TextEdit.app',
  media: '/System/Applications/QuickTime Player.app',
} as const;
/**
 * The documents Wren opens: ones these viewers show without running anything. HTML, SVG, scripts, apps, Office
 * files (macros), disk images and anything unknown are revealed instead, for the user to open themselves.
 */
const DOCUMENTS: Record<string, keyof typeof MAC_VIEWERS> = {
  ...Object.fromEntries(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'webp'].map((e) => [e, 'preview'])),
  ...Object.fromEntries(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yaml', 'yml', 'toml', 'ini'].map((e) => [e, 'text'])),
  ...Object.fromEntries(['mp3', 'm4a', 'wav', 'aac', 'aif', 'aiff', 'mp4', 'mov', 'm4v'].map((e) => [e, 'media'])),
};

/** A target that names a URL scheme (not a Windows drive such as C:\). */
const URL_LIKE = /^[a-z][a-z0-9+.-]+:/i;

/**
 * Decide what opening `target` does: an http(s) link opens in the user's browser; a file inside the allowed
 * folders (links followed; never Wren itself or a credential store) opens in its viewer if it's a document Wren
 * knows, else is revealed; a folder is revealed.
 */
export function planOpen(target: string, reveal: boolean, roots: string[], dataDir: string, platform = process.platform): OpenPlan | { error: string } {
  const t = target.trim();
  if (!t) return { error: 'Say which file or link to open.' };
  if (URL_LIKE.test(t) && !/^[a-z]:[\\/]/i.test(t)) {
    let url: URL;
    try {
      url = new URL(t);
    } catch {
      return { error: `${t} isn't a valid link.` };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return { error: 'Only http(s) links can be opened.' };
    if (url.username || url.password) return { error: 'Links with a user name or password in them aren’t opened.' };
    return { kind: 'url', url: url.href };
  }
  let path: string;
  try {
    path = realpathSync(confinePath(t, roots));
    refuseToShow(path, roots, dataDir);
  } catch (e) {
    return { error: (e as Error).message };
  }
  if (!existsSync(path)) return { error: `File not found: ${path}` };
  if (reveal || statSync(path).isDirectory()) return { kind: 'reveal', path };
  const kind = DOCUMENTS[extname(path).slice(1).toLowerCase()];
  if (!kind) return { kind: 'reveal', path };
  if (platform === 'darwin') return existsSync(MAC_VIEWERS[kind]) ? { kind: 'view', path, viewer: MAC_VIEWERS[kind] } : { kind: 'reveal', path };
  return { kind: 'view', path };
}

export interface Opener {
  openExternal(url: string): Promise<void>;
  showItemInFolder(path: string): void;
  /** Windows/Linux: the system's own app for that type (an error message, or '' when it opened). */
  openPath(path: string): Promise<string>;
  /** macOS: `open -a <viewer> <file>`; resolves its exit code. */
  openWith(viewer: string, path: string): Promise<number>;
}

async function electronOpener(): Promise<Opener> {
  const { shell } = await import('electron');
  return {
    openExternal: (url) => shell.openExternal(url),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    openPath: (path) => shell.openPath(path),
    openWith: (viewer, path) =>
      new Promise((resolve) => {
        const c = spawn('/usr/bin/open', ['-a', viewer, path], { stdio: 'ignore' });
        c.on('error', () => resolve(-1));
        c.on('exit', (code) => resolve(code ?? -1));
      }),
  };
}

/** Do what `planOpen` decided. */
export async function performOpen(plan: OpenPlan, opener?: Opener): Promise<ToolResult> {
  const o = opener ?? (await electronOpener());
  try {
    if (plan.kind === 'url') {
      await o.openExternal(plan.url);
      return { output: `Opened ${plan.url} in the user's browser.` };
    }
    if (plan.kind === 'reveal') {
      o.showItemInFolder(plan.path);
      return { output: `Showed ${plan.path} in ${process.platform === 'win32' ? 'File Explorer' : 'Finder'}. Wren opens only PDFs, images, plain text and media itself; the user can open this one from there.` };
    }
    if (plan.viewer) {
      const code = await o.openWith(plan.viewer, plan.path);
      if (code !== 0) return { output: `${plan.path} couldn't be opened (exit code ${code}).`, isError: true };
    } else {
      const err = await o.openPath(plan.path);
      if (err) return { output: `${plan.path} couldn't be opened: ${err}`, isError: true };
    }
    return { output: `Opened ${plan.path} on the user's screen.` };
  } catch (e) {
    return { output: `Couldn't open it: ${(e as Error).message}`, isError: true };
  }
}
