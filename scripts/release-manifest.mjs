// Builds wren-update.json for a release: sha256, size and an ed25519 signature
// per platform over `wren-update:v1:<version>:<platform>:<sha256>:<size>`.
// The desktop app verifies these with the public key compiled into it.
//   WREN_UPDATER_KEY=<pkcs8 pem> node scripts/release-manifest.mjs <version> <dir> <repo> <tag>
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [version, dir, repo, tag] = process.argv.slice(2);
const pem = process.env.WREN_UPDATER_KEY;
if (!version || !dir || !repo || !tag || !pem) throw new Error('usage: WREN_UPDATER_KEY=... release-manifest.mjs <version> <dir> <repo> <tag>');
const key = createPrivateKey(pem);
const files = readdirSync(dir);
const pick = (re) => files.find((f) => re.test(f));
const targets = {
  'darwin-arm64': pick(new RegExp(`^Wren-${version}-mac-arm64\\.zip$`)),
  'darwin-x64': pick(new RegExp(`^Wren-${version}-mac-x64\\.zip$`)),
  'win32-x64': pick(new RegExp(`^Wren-${version}-win-x64-setup\\.exe$`)),
};
const platforms = {};
for (const [platform, file] of Object.entries(targets)) {
  if (!file) continue;
  const buf = readFileSync(join(dir, file));
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const size = statSync(join(dir, file)).size;
  const signature = sign(null, Buffer.from(`wren-update:v1:${version}:${platform}:${sha256}:${size}`), key).toString('base64');
  platforms[platform] = { url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(file)}`, sha256, size, signature };
}
if (!Object.keys(platforms).length) throw new Error(`No release artifacts for ${version} in ${dir}`);
let notes = '';
try {
  notes = readFileSync(`releases/v${version}.md`, 'utf8');
} catch {}
writeFileSync(join(dir, 'wren-update.json'), JSON.stringify({ version, notes, platforms }, null, 2));
console.log('signed', Object.keys(platforms).join(', '));
