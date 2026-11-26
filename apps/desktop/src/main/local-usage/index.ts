// Usage of the other AI apps on this computer, for the Usage page (window.wren.localUsage). The numbers
// stay on this computer: the page prices them itself and sends nothing to Wren's server.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { LocalUsageReport, ScanInput } from './scan';

/** A report this recent is answered again instead of reading the logs again. */
const FRESH_MS = 60_000;
/** A read that takes longer than this is given up (the cache keeps what it had). */
const TIMEOUT_MS = 5 * 60_000;

let last: LocalUsageReport | null = null;
let running: Promise<LocalUsageReport> | null = null;

/** The worker sits next to main.js; packaged, outside app.asar (electron-builder's asarUnpack). */
export const workerPath = (distDir: string) => join(distDir.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1').replace(/app\.asar$/, 'app.asar.unpacked'), 'local-usage-worker.js');

export function localUsage(distDir: string, dataDir: string, opts: { refresh?: boolean } = {}): Promise<LocalUsageReport> {
  if (running) return running;
  if (last && !opts.refresh && Date.now() - last.generatedAt < FRESH_MS) return Promise.resolve(last);
  const input: ScanInput = {
    home: homedir(),
    dataDir,
    env: { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME, GROK_HOME: process.env.GROK_HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME },
    now: Date.now(),
  };
  running = new Promise<LocalUsageReport>((resolve, reject) => {
    const w = new Worker(workerPath(distDir), { workerData: input });
    const timer = setTimeout(() => {
      void w.terminate();
      reject(new Error('Reading usage took too long.'));
    }, TIMEOUT_MS);
    w.once('message', (m: { report?: LocalUsageReport; error?: string }) => {
      clearTimeout(timer);
      void w.terminate();
      if (m.report) resolve((last = m.report));
      else reject(new Error(m.error || 'Reading usage failed.'));
    });
    w.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    w.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Reading usage stopped (${code}).`));
    });
  }).finally(() => {
    running = null;
  });
  return running;
}
