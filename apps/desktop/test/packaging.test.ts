import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every release up to 0.1.40 shipped Electron 44.5.1: electron-builder.json pinned it from the first
// desktop build, and electron-builder packages the config's version, whatever package.json says. The
// Electron security updates in package.json (44.9.3 in 0.1.37) never reached users.

const root = join(__dirname, '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const pkg = JSON.parse(read('package.json'));

describe('the packaged Electron is the one package.json pins', () => {
  it('package.json pins one exact version', () => {
    expect(pkg.devDependencies.electron).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('electron-builder.json pins no version of its own', () => {
    expect(JSON.parse(read('electron-builder.json'))).not.toHaveProperty('electronVersion');
  });

  it('the packaging script passes the installed version, checked against package.json', () => {
    const script = read('scripts/package.mjs');
    expect(script).toContain("('electron/package.json').version");
    expect(script).toContain('pkg.devDependencies.electron');
    expect(script).toContain('-c.electronVersion=${electron}');
  });

  it('the self-test fails on any other Electron', () => {
    expect(read('scripts/build.mjs')).toContain('__WREN_ELECTRON__: JSON.stringify(electron)');
    expect(read('src/main/index.ts')).toContain('app.exit(result.electron === result.electronExpected &&');
  });
});
