import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { programTrust } from '../src/main/trust';

// W-74: bare program names and the PATH folders agents can write.

let base: string;
let sys: string; // a PATH folder agents can't write
let proj: string; // an allowed folder (agents can write)
const exe = (dir: string, name: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), '#!/bin/sh\n');
  chmodSync(join(dir, name), 0o755);
};

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'wren-trust-'));
  sys = join(base, 'sys', 'bin');
  proj = join(base, 'proj');
  exe(sys, 'ls');
  exe(sys, 'git');
  exe(join(proj, 'bin'), 'ls');
  exe(join(proj, 'bin'), 'rg');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('programTrust', () => {
  it('trusts a program found before any writable PATH folder', () => {
    const t = programTrust([sys, join(proj, 'bin')].join(':'), [proj]);
    expect(t('ls')).toBe(true);
    expect(t('git')).toBe(true);
    expect(t('rg')).toBe(false); // only in the writable folder
    expect(t('nope')).toBe(false);
  });
  it('trusts nothing found after a writable folder, even if it is not there yet', () => {
    expect(programTrust([join(proj, 'bin'), sys].join(':'), [proj])('ls')).toBe(false);
    expect(programTrust([join(proj, 'bin'), sys].join(':'), [proj])('git')).toBe(false); // an agent could add bin/git first
    expect(programTrust([join(proj, 'not-yet'), sys].join(':'), [proj])('git')).toBe(false);
  });
  it('follows links: a trusted folder entry pointing into a writable folder is not trusted', () => {
    symlinkSync(join(proj, 'bin', 'rg'), join(sys, 'rg'));
    expect(programTrust(sys, [proj])('rg')).toBe(false);
    // and a PATH folder that is a link to a writable one counts as writable
    symlinkSync(join(proj, 'bin'), join(base, 'linked-bin'));
    expect(programTrust([join(base, 'linked-bin'), sys].join(':'), [proj])('git')).toBe(false);
  });
  it('skips files that are not executable, like bash does', () => {
    writeFileSync(join(sys, 'cat'), 'x');
    const other = join(base, 'sys2');
    exe(other, 'cat');
    expect(programTrust([sys, other].join(':'), [proj])('cat')).toBe(true);
  });
  it('vouches for bash builtins and never for paths or empty names', () => {
    const t = programTrust(join(proj, 'bin'), [proj]);
    expect(t('echo')).toBe(true);
    expect(t('pwd')).toBe(true);
    expect(t('./ls')).toBe(false);
    expect(t('')).toBe(false);
  });
});
