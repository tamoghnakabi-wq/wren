import { describe, expect, it } from 'vitest';
import { compareVersions } from '../src/semver';

describe('compareVersions', () => {
  it('orders releases and prereleases like semver', () => {
    const sorted = ['0.1.4', '0.1.5-alpha', '0.1.5-alpha.1', '0.1.5-alpha.beta', '0.1.5-beta', '0.1.5-beta.2', '0.1.5-beta.11', '0.1.5-rc.1', '0.1.5', '0.1.10', '1.0.0'];
    for (let i = 0; i < sorted.length - 1; i++) expect(compareVersions(sorted[i + 1], sorted[i]), `${sorted[i + 1]} > ${sorted[i]}`).toBe(1);
  });
  it('never treats a prerelease of the installed version as an update', () => {
    expect(compareVersions('0.1.5-beta.1', '0.1.5')).toBe(-1);
    expect(compareVersions('0.1.5', '0.1.5-beta.1')).toBe(1);
  });
  it('ranks malformed versions lowest', () => {
    expect(compareVersions('nonsense', '0.0.1')).toBe(-1);
    expect(compareVersions('0.1.5', '0.1')).toBe(1);
    expect(compareVersions('v0.1.5', '0.1.5')).toBe(0);
  });
});
