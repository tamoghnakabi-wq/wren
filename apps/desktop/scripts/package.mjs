// Stages a self-contained app directory (so npm workspaces don't confuse
// electron-builder), installs the one runtime dependency, and runs
// electron-builder for the requested platform.
//   node scripts/package.mjs mac|win [--arch arm64|x64]
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const target = process.argv[2] ?? (process.platform === 'win32' ? 'win' : 'mac');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
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
execSync(`npx electron-builder --${target} --publish never --config electron-builder.json ${extra}`, { stdio: 'inherit', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
