import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { htmlToText } from './text';
import { clipMiddle } from './transcript';

// web.fetch with an SSRF guard. The cloud control plane runs this on our own
// servers, so it must never reach private networks or metadata endpoints.

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('Invalid URL.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed.');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|metadata\.google\.internal)$/i.test(host) || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('That host is not reachable from the cloud agent.');
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('That host resolves to a private network address and is blocked.');
  return u;
}

export interface FetchOptions {
  maxChars?: number;
  guard?: boolean; // apply the SSRF guard (cloud)
  userAgent?: string;
  timeoutMs?: number;
}

export async function fetchReadable(url: string, o: FetchOptions = {}): Promise<{ output: string; status: number; finalUrl: string; title?: string }> {
  const maxChars = Math.min(Math.max(o.maxChars ?? 40_000, 1000), 120_000);
  let current = url;
  let res: Response | undefined;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs ?? 25_000);
  try {
    for (let hop = 0; hop < 6; hop++) {
      if (o.guard) await assertPublicUrl(current);
      res = await fetch(current, {
        redirect: 'manual',
        signal: ctl.signal,
        headers: {
          'user-agent': o.userAgent ?? 'Mozilla/5.0 (compatible; WrenAgent/0.1; +https://github.com/tamoghnakabi-wq/wren)',
          accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
        },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location')!, current).toString();
        continue;
      }
      break;
    }
    if (!res) throw new Error('No response.');
    const type = res.headers.get('content-type') ?? '';
    const buf = await readLimited(res, 3_000_000);
    const body = new TextDecoder().decode(buf);
    let output: string;
    let title: string | undefined;
    if (/html|xml/.test(type) || /^\s*<(!doctype|html)/i.test(body)) {
      const r = htmlToText(body, current);
      title = r.title;
      output = (r.title ? `# ${r.title}\n\n` : '') + r.text;
    } else if (/json/.test(type)) {
      try {
        output = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        output = body;
      }
    } else if (/^text\//.test(type) || !type) {
      output = body;
    } else {
      output = `[${type} content, ${buf.byteLength} bytes — not text. Use the computer to download and process it.]`;
    }
    return { output: `URL: ${current}\nStatus: ${res.status}\n\n${clipMiddle(output, maxChars)}`, status: res.status, finalUrl: current, title };
  } finally {
    clearTimeout(timer);
  }
}

async function readLimited(res: Response, limit: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= limit) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const out = new Uint8Array(Math.min(total, limit));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, out.byteLength - off);
    out.set(c.subarray(0, take), off);
    off += take;
    if (off >= out.byteLength) break;
  }
  return out;
}
