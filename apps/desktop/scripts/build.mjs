// Bundles the Electron main process, preload and the MCP approval helper.
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';

rmSync('dist-electron', { recursive: true, force: true });
const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: 'linked', logLevel: 'info', legalComments: 'none' };
// `--selftest` checks the app runs on this Electron (package.json pins it exactly).
const electron = JSON.parse(readFileSync('package.json', 'utf8')).devDependencies.electron;
await build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist-electron/main.js', format: 'cjs', external: ['electron', 'playwright-core'], define: { __WREN_ELECTRON__: JSON.stringify(electron) } });
await build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist-electron/preload.js', format: 'cjs', external: ['electron'], sourcemap: false });
await build({ ...common, entryPoints: ['src/engines/mcp-approve.ts'], outfile: 'dist-electron/mcp-approve.mjs', format: 'esm', banner: { js: "import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" } });
await build({ ...common, entryPoints: ['src/engines/grok-hook.ts'], outfile: 'dist-electron/grok-hook.mjs', format: 'esm', sourcemap: false });
