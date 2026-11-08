// Stages a self-contained app directory (so npm workspaces don't confuse
// electron-builder), installs the one runtime dependency, and runs
// electron-builder for the requested platform.
//   node scripts/package.mjs mac|win [--arch arm64|x64]
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const target = process.argv[2] ?? (process.platform === 'win32' ? 'win' : 'mac');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
// Package the Electron the app is built and tested with, which package.json pins exactly. Left to
// itself electron-builder takes the version from its config, and electron-builder.json held 44.5.1
// from the first desktop build until 0.1.40: every release shipped that, whatever package.json said.
const electron = createRequire(import.meta.url)('electron/package.json').version;
if (electron !== pkg.devDependencies.electron) throw new Error(`Electron ${electron} is installed but package.json asks for ${pkg.devDependencies.electron}: run npm install`);
execSync('node scripts/build.mjs', { stdio: 'inherit' });
rmSync('app', { recursive: true, force: true });
mkdirSync('app/build', { recursive: true });
cpSync('dist-electron', 'app/dist-electron', { recursive: true });
for (const f of ['tray.png', 'trayTemplate.png', 'trayTemplate@2x.png']) cpSync(`build/${f}`, `app/build/${f}`);
writeFileSync(
  'app/package.json',
  JSON.stringify({ name: 'wren', productName: 'Wren', version: pkg.version, description: pkg.description, author: pkg.author, license: pkg.license, main: 'dist-electron/main.js', dependencies: pkg.dependencies }, null, 2),
);
execSync('npm install --omit=dev --no-audit --no-fund --no-package-lock', { cwd: 'app', stdio: 'inherit' });
const extra = process.argv.slice(3).join(' ');
execSync(`npx electron-builder --${target} --publish never --config electron-builder.json -c.electronVersion=${electron} ${extra}`, { stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
