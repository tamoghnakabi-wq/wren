import { compareVersions } from '@wren/core';
import { env } from './env';

// Desktop releases live on GitHub Releases of the public source repo. Each
// release carries installers plus `wren-update.json`, a manifest whose entries
// are signed with the updater's ed25519 key (verified by the desktop app).

export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

export interface UpdateEntry {
  url: string;
  sha256: string;
  size: number;
  signature: string;
}

export interface Release {
  version: string;
  name: string;
  notes: string;
  publishedAt: string;
  prerelease: boolean;
  htmlUrl: string;
  downloads: { macArm64?: ReleaseAsset; macX64?: ReleaseAsset; windows?: ReleaseAsset };
  manifestUrl?: string;
}

const UA = { 'user-agent': 'wren-site', accept: 'application/vnd.github+json' };

export async function latestRelease(): Promise<Release | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${env.releasesRepo}/releases?per_page=10`, { headers: UA, next: { revalidate: 300 } });
    if (!res.ok) return null;
    const list = (await res.json()) as {
      tag_name: string;
      name: string;
      body: string;
      published_at: string;
      prerelease: boolean;
      draft: boolean;
      html_url: string;
      assets: { name: string; browser_download_url: string; size: number }[];
    }[];
    // Stable channel only: GitHub prereleases (and tags that aren't plain x.y.z) are never offered,
    // and the highest version wins rather than the most recently published.
    const r = list
      .filter((x) => !x.draft && !x.prerelease && /^v?\d+\.\d+\.\d+$/.test(x.tag_name) && x.assets.some((a) => a.name === 'wren-update.json'))
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
    if (!r) return null;
    const find = (re: RegExp) => {
      const a = r.assets.find((x) => re.test(x.name));
      return a ? { name: a.name, url: a.browser_download_url, size: a.size } : undefined;
    };
    return {
      version: r.tag_name.replace(/^v/, ''),
      name: r.name || r.tag_name,
      notes: r.body ?? '',
      publishedAt: r.published_at,
      prerelease: r.prerelease,
      htmlUrl: r.html_url,
      downloads: { macArm64: find(/mac-arm64\.dmg$/), macX64: find(/mac-x64\.dmg$/), windows: find(/win-x64-setup\.exe$/) },
      manifestUrl: r.assets.find((a) => a.name === 'wren-update.json')?.browser_download_url,
    };
  } catch {
    return null;
  }
}

export async function updateManifest(r: Release): Promise<{ version: string; notes: string; platforms: Record<string, UpdateEntry> } | null> {
  if (!r.manifestUrl) return null;
  const res = await fetch(r.manifestUrl, { headers: { 'user-agent': 'wren-site' }, next: { revalidate: 300 } });
  if (!res.ok) return null;
  return res.json();
}

export { compareVersions } from '@wren/core';
