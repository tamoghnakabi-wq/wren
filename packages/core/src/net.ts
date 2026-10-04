import { lookup as dnsLookup } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { htmlToText } from './text';
import { clipMiddle } from './transcript';

// web.fetch with an SSRF guard. The cloud control plane runs this on our own
// servers, so it must never reach private networks or metadata endpoints.
// The address check runs again at connect time (see guardedFetch), so a DNS
// answer that changes between the check and the connection can't get through.

function isPrivateV4(bytes: number[]): boolean {
  const [a, b, c] = bytes;
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) || (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224
  );
}

/** Parse an IPv6 address (optionally with an embedded IPv4 tail) into 16 bytes. */
function parseV6(ip: string): number[] | null {
  let v = ip.toLowerCase().replace(/%.*$/, '');
  let tail: number[] = [];
  const v4 = v.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    if (isIP(v4[1]) !== 4) return null;
    tail = v4[1].split('.').map(Number);
    v = v.slice(0, -v4[1].length) + '0:0';
  }
  const halves = v.split('::');
  if (halves.length > 2) return null;
  const words = (h: string) => (h ? h.split(':') : []);
  const head = words(halves[0]);
  const rest = halves.length === 2 ? words(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (fill < 0 || (halves.length === 1 && fill !== 0)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...rest];
  const bytes: number[] = [];
  for (const w of all) {
    if (!/^[0-9a-f]{1,4}$/.test(w)) return null;
    const n = parseInt(w, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes.length === 16 ? bytes : null;
}

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateV4(ip.split('.').map(Number));
  const b = parseV6(ip);
  if (!b) return true; // unparseable: refuse
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zero(0, 16)) return true; // ::
  if (zero(0, 15) && b[15] === 1) return true; // ::1
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateV4(b.slice(12)); // ::ffff:a.b.c.d
  if (zero(0, 12)) return true; // ::a.b.c.d (deprecated IPv4-compatible)
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return isPrivateV4(b.slice(12)) || zero(4, 12) === false; // 64:ff9b::/96 NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return isPrivateV4(b.slice(2, 6)); // 2002::/16 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // 2001::/32 Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  if (b[0] === 0x01 && b[1] === 0x00 && zero(2, 8)) return true; // 100::/64 discard
  if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10 link local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) return true; // fec0::/10 site local
  if (b[0] === 0xff) return true; // multicast
  return false;
}

/** DNS lookup used at connect time: refuses names that resolve to private addresses. */
export const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true, verbatim: true }, (err, addresses) => {
    if (err) return (callback as (e: Error | null) => void)(err);
    const list = addresses as { address: string; family: number }[];
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      const e = new Error(`${hostname} resolves to a private network address and is blocked.`) as NodeJS.ErrnoException;
      e.code = 'EPRIVATE';
      return (callback as (e: Error | null) => void)(e);
    }
    if ((options as { all?: boolean }).all) return (callback as (e: null, a: typeof list) => void)(null, list);
    (callback as (e: null, a: string, f: number) => void)(null, list[0].address, list[0].family);
  });
};

let publicAgent: Agent | undefined;

/** fetch that can only connect to public addresses (checked when the socket opens). */
export const guardedFetch = ((input: string | URL, init?: RequestInit) => {
  publicAgent ??= new Agent({ connect: { lookup: publicOnlyLookup } });
  return undiciFetch(input as string, { ...(init as object), dispatcher: publicAgent } as Parameters<typeof undiciFetch>[1]);
}) as unknown as typeof fetch;

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
      res = await (o.guard ? guardedFetch : fetch)(current, {
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
