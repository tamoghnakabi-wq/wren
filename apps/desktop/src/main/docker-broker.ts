import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { makeFolderConfined } from './confined';
import { reachesAny } from './paths';
import { agentCanWrite, appDirs, autorunPaths, credentialStores } from './sandbox';

// Docker for agents on macOS (0.1.50 review). The Docker socket is a door out of Wren's sandbox: a container can
// mount any folder of this Mac (`-v ~/.ssh:/x`), run privileged, or join the VM's processes, so commands can't
// reach it (sandbox.ts). Instead each run gets this broker: a socket in the run's temp folder (DOCKER_HOST) that
// passes on only the Docker API requests that can't reach past the allowed folders, and changes one thing on the
// way: every mount of a folder of this Mac becomes a sub-path of a volume backed by an allowed folder itself.
// Docker resolves a plain bind's source again at every start, through folders agents may write, so a symlink
// swapped in later would lead anywhere (tested: a relative link out of a bound folder was followed); a volume
// sub-path is resolved inside the volume and an escape is refused (moby's safepath, tested with relative and
// absolute links and `..`). The folder itself can't be swapped when no agent can write its parent.

const MAX_BODY = 4 * 1024 * 1024;
const MAX_HEAD = 64 * 1024;
/** Capabilities a container may add: debugging and its own network. Anything else can reach the VM (SYS_ADMIN, DAC_READ_SEARCH…). */
const CAPS = new Set(['SYS_PTRACE', 'NET_ADMIN', 'SYS_NICE', 'IPC_LOCK']);
const SECURITY_OPT = /^no-new-privileges([:=]true)?$/i;
const BIND_OPTIONS = new Set(['ro', 'rw', 'z', 'Z', 'nocopy', 'delegated', 'cached', 'consistent', 'private', 'rprivate']);
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const FOLDER_VOLUME = 'wren-folder-';
/** Where the docker CLI's plugins (compose, buildx) live when ~/.docker, which agents can't read, has only links to them. */
const PLUGIN_DIRS = ['/Applications/Docker.app/Contents/Resources/cli-plugins', '/usr/local/lib/docker/cli-plugins', '/opt/homebrew/lib/docker/cli-plugins', '/usr/local/libexec/docker/cli-plugins'];

// ------------------------------------------------------------------ strict JSON

/**
 * Docker's Go decoder matches a body's keys to fields ignoring case (and folds the Kelvin sign and long s), and
 * merges a field given twice: `{"HostConfig":{…},"hostconfig":{"Privileged":true}}`. JSON.parse would keep one.
 * So keys are compared folded, any key given twice is refused, and checks look fields up folded too (`field`).
 * Big integers keep their text, so a re-written body says what the original did.
 */
export const fold = (k: string) => k.normalize('NFKC').toLowerCase();
const rawJSON = (JSON as unknown as { rawJSON?: (s: string) => unknown }).rawJSON;

export function parseStrictJson(text: string): unknown {
  let i = 0;
  const STRING = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const fail = (m = 'it isn’t valid JSON'): never => {
    throw new Error(m);
  };
  const ws = () => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  };
  const str = (): string => {
    STRING.lastIndex = i;
    const m = STRING.exec(text);
    if (!m) fail();
    i = STRING.lastIndex;
    return JSON.parse(m![0]) as string;
  };
  const value = (depth: number): unknown => {
    if (depth > 64) fail('it is nested too deeply');
    ws();
    const c = text[i];
    if (c === '{') {
      i++;
      const o: Record<string, unknown> = {};
      const seen = new Set<string>();
      ws();
      if (text[i] === '}') return i++, o;
      for (;;) {
        ws();
        if (text[i] !== '"') fail();
        const k = str();
        if (seen.has(fold(k))) fail(`the key "${k}" appears twice`);
        seen.add(fold(k));
        ws();
        if (text[i++] !== ':') fail();
        Object.defineProperty(o, k, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
        ws();
        const d = text[i++];
        if (d === '}') return o;
        if (d !== ',') fail();
      }
    }
    if (c === '[') {
      i++;
      const a: unknown[] = [];
      ws();
      if (text[i] === ']') return i++, a;
      for (;;) {
        a.push(value(depth + 1));
        ws();
        const d = text[i++];
        if (d === ']') return a;
        if (d !== ',') fail();
      }
    }
    if (c === '"') return str();
    for (const [word, v] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(word, i)) return (i += word.length), v;
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m) fail();
    i = NUMBER.lastIndex;
    const n = Number(m![0]);
    return Number.isInteger(n) && !Number.isSafeInteger(n) && /^-?\d+$/.test(m![0]) && rawJSON ? rawJSON(m![0]) : n;
  };
  const v = value(0);
  ws();
  if (i !== text.length) fail('there is more after the JSON');
  return v;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
/** A field as Docker's decoder finds it: by name, ignoring case. */
export function field(o: unknown, name: string): { key: string; value: unknown } | undefined {
  if (!isObj(o)) return undefined;
  const f = fold(name);
  for (const k of Object.keys(o)) if (fold(k) === f) return { key: k, value: o[k] };
  return undefined;
}
const val = (o: unknown, name: string) => field(o, name)?.value;
const unset = (v: unknown) => v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0);

// ------------------------------------------------------------------ requests

/** The request's path (version prefix dropped) and query; null for anything spelled unusually (encoded, dot segments). */
export function parseTarget(raw: string): { version: string; path: string; query: string } | null {
  if (!raw.startsWith('/') || raw.length > 8192 || /[^\x21-\x7e]/.test(raw) || raw.includes('#')) return null;
  const q = raw.indexOf('?');
  const full = q < 0 ? raw : raw.slice(0, q);
  if (/[%\\]|\/\/|\/\.\.?(\/|$)/.test(full)) return null;
  const v = /^\/v\d+(\.\d+)?(?=\/)/.exec(full);
  return { version: v ? v[0] : '', path: v ? full.slice(v[0].length) : full, query: q < 0 ? '' : raw.slice(q) };
}

type Kind = 'read' | 'write' | 'create' | 'update' | 'start' | 'use' | 'attach' | 'exec-create' | 'exec' | 'exec-start' | 'volume-create' | 'build' | 'buildkit';
export interface Route {
  kind: Kind;
  container?: string;
  exec?: string;
}

const C = '([A-Za-z0-9][A-Za-z0-9_.-]{0,127})';
const IMG = '([A-Za-z0-9][A-Za-z0-9._:/@+-]{0,511})';
const N = '([A-Za-z0-9][A-Za-z0-9_.-]{0,254})';
const ROUTES: [string, RegExp, Kind, 'container' | 'exec' | undefined][] = (
  [
    ['GET HEAD', '/_ping', 'read'],
    ['GET', '/(version|info|events|system/df)', 'read'],
    ['GET', '/containers/json', 'read'],
    ['POST', '/containers/create', 'create'],
    ['POST', '/containers/prune', 'write'],
    ['GET', `/containers/${C}/(json|top|logs|changes|stats|export)`, 'read', 'container'],
    ['GET HEAD PUT', `/containers/${C}/archive`, 'use', 'container'],
    ['POST', `/containers/${C}/(start|restart)`, 'start', 'container'],
    ['POST', `/containers/${C}/(stop|kill|wait|pause|unpause|rename|resize)`, 'write', 'container'],
    ['POST', `/containers/${C}/update`, 'update', 'container'],
    ['DELETE', `/containers/${C}`, 'write', 'container'],
    ['POST', `/containers/${C}/attach`, 'attach', 'container'],
    ['POST', `/containers/${C}/exec`, 'exec-create', 'container'],
    ['POST', `/exec/${C}/start`, 'exec-start', 'exec'],
    ['POST', `/exec/${C}/resize`, 'exec', 'exec'],
    ['GET', `/exec/${C}/json`, 'exec', 'exec'],
    ['GET', '/images/(json|search|get)', 'read'],
    ['GET', `/images/${IMG}/(json|history|get)`, 'read'],
    ['POST', '/images/(create|load|prune)', 'write'],
    ['POST', `/images/${IMG}/(tag|push)`, 'write'],
    ['DELETE', `/images/${IMG}`, 'write'],
    ['POST', '/build', 'build'],
    ['POST', '/build/(prune|cancel)', 'write'],
    ['POST', '/commit', 'write'],
    ['GET', '/networks', 'read'],
    ['GET', `/networks/${N}`, 'read'],
    ['POST', '/networks/(create|prune)', 'write'],
    ['POST', `/networks/${N}/(connect|disconnect)`, 'write'],
    ['DELETE', `/networks/${N}`, 'write'],
    ['GET', '/volumes', 'read'],
    ['GET', `/volumes/${N}`, 'read'],
    ['POST', '/volumes/create', 'volume-create'],
    ['POST', '/volumes/prune', 'write'],
    ['DELETE', `/volumes/${N}`, 'write'],
    ['GET', `/distribution/${IMG}/json`, 'read'],
    ['GET', '/plugins', 'read'],
    ['POST', '/(session|grpc)', 'buildkit'],
  ] as [string, string, Kind, ('container' | 'exec')?][]
).flatMap(([methods, p, kind, id]) => methods.split(' ').map((m) => [m, new RegExp(`^${p}$`), kind, id] as [string, RegExp, Kind, 'container' | 'exec' | undefined]));

/** What a request is, or null when agents may not make it (swarm, plugins, secrets, logins, anything new). */
export function routeOf(method: string, path: string): Route | null {
  for (const [m, re, kind, id] of ROUTES) {
    if (m !== method) continue;
    const hit = re.exec(path);
    if (!hit) continue;
    return { kind, ...(id ? { [id]: hit[1] } : {}) };
  }
  return null;
}

// ------------------------------------------------------------------ what a container may be

/**
 * Settings that let a container reach past its own namespaces into the VM, and from there every folder Docker
 * shares (all of /Users): privileged, extra capabilities, devices, the VM's or another container's processes,
 * relaxed security profiles, another container's volumes. `existing`: a container already made (its inspect
 * output lists defaults these checks accept).
 */
export function hostConfigProblem(hc: unknown, existing = false): string | null {
  if (hc === undefined || hc === null) return null;
  if (!isObj(hc)) return 'its HostConfig isn’t an object';
  if (val(hc, 'Privileged') === true) return 'privileged containers can reach this Mac outside Wren’s sandbox';
  const caps = val(hc, 'CapAdd');
  if (!unset(caps)) {
    if (!Array.isArray(caps)) return 'CapAdd isn’t a list';
    for (const c of caps) if (!CAPS.has(String(c).toUpperCase().replace(/^CAP_/, ''))) return `the capability ${String(c)} isn’t allowed (only ${[...CAPS].join(', ')})`;
  }
  for (const k of ['Devices', 'DeviceRequests', 'DeviceCgroupRules', 'VolumesFrom', 'Annotations', 'PidMode', 'UsernsMode', 'UTSMode', 'CgroupParent', 'Cgroup', 'Isolation']) {
    if (!unset(val(hc, k))) return `${k} isn’t allowed for agents’ containers`;
  }
  const ipc = val(hc, 'IpcMode');
  if (!unset(ipc) && !['private', 'shareable', 'none'].includes(String(ipc))) return `IpcMode ${String(ipc)} isn’t allowed`;
  const cgroupns = val(hc, 'CgroupnsMode');
  if (!unset(cgroupns) && cgroupns !== 'private') return `CgroupnsMode ${String(cgroupns)} isn’t allowed`;
  const runtime = val(hc, 'Runtime');
  if (!unset(runtime) && runtime !== 'runc') return `the runtime ${String(runtime)} isn’t allowed`;
  const driver = val(hc, 'VolumeDriver');
  if (!unset(driver) && driver !== 'local') return `the volume driver ${String(driver)} isn’t allowed`;
  const opts = val(hc, 'SecurityOpt');
  if (!unset(opts)) {
    if (!Array.isArray(opts)) return 'SecurityOpt isn’t a list';
    for (const o of opts) if (!SECURITY_OPT.test(String(o))) return `the security option ${String(o)} isn’t allowed`;
  }
  // Empty lists unmask /proc's sensitive files (`--security-opt systempaths=unconfined`).
  for (const k of ['MaskedPaths', 'ReadonlyPaths']) {
    const v = val(hc, k);
    if (existing ? Array.isArray(v) && v.length === 0 : Array.isArray(v)) return `${k} isn’t allowed`;
  }
  return null;
}

/** Query options of a build that reach past a normal build container. */
export function buildProblem(query: string): string | null {
  const q = new URLSearchParams(query.replace(/^\?/, ''));
  const so = q.get('securityopt');
  if (so && so !== '[]' && so !== 'null') return 'security options aren’t allowed in builds';
  if (q.get('cgroupparent')) return 'cgroupparent isn’t allowed in builds';
  if ((q.get('networkmode') ?? '').startsWith('container:')) return 'a build can’t join another container’s network';
  const iso = q.get('isolation');
  if (iso && iso !== 'default') return 'isolation isn’t allowed in builds';
  return null;
}

// ------------------------------------------------------------------ the broker

export interface BrokerOptions {
  /** Where to listen (in the run's temp folder, so the run's commands may connect). */
  socketPath: string;
  /** The real Docker socket now (Docker may start after the run did), or null. */
  upstream: () => string | null;
  /** The allowed folders now (real paths). */
  roots: () => string[];
  dataDir: string;
  runId: string;
  home?: string;
  /** A line per request and what became of it (Wren's log). */
  log?: (line: string) => void;
}

interface Reply {
  status: number;
  body: Buffer;
  json: unknown;
}

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'proxy-authorization', 'expect']);
function forwardHeaders(h: IncomingHttpHeaders, bodyLength?: number): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = { host: 'docker' };
  for (const [k, v] of Object.entries(h)) if (v !== undefined && !HOP.has(k) && !(bodyLength !== undefined && k === 'content-length')) out[k] = v;
  if (bodyLength !== undefined) out['content-length'] = String(bodyLength);
  return out;
}

export async function startDockerBroker(o: BrokerOptions): Promise<{ path: string; close: () => void }> {
  const home = o.home ?? homedir();
  /** Exec instances this broker made, and the container each runs in: only these can be started or read. */
  const execs = new Map<string, string>();

  const upstreamPath = () => {
    const p = o.upstream();
    if (!p) throw Object.assign(new Error('Docker isn’t running on this Mac (start Docker Desktop, Colima or OrbStack).'), { status: 503 });
    return p;
  };

  /** A request of Wren's own to Docker (to look something up or make a folder's volume). */
  const ask = (method: string, path: string, body?: unknown): Promise<Reply> =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const r = request({ socketPath: upstreamPath(), method, path, agent: false, headers: { host: 'docker', ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) } }, (res) => {
        const chunks: Buffer[] = [];
        let n = 0;
        res.on('data', (c: Buffer) => {
          n += c.length;
          if (n > MAX_BODY) r.destroy(new Error('Docker’s answer was too large'));
          else chunks.push(c);
        });
        res.on('end', () => {
          const b = Buffer.concat(chunks);
          let json: unknown = null;
          try {
            json = b.length ? JSON.parse(b.toString('utf8')) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 502, body: b, json });
        });
        res.on('error', reject);
      });
      r.setTimeout(30_000, () => r.destroy(new Error('Docker didn’t answer')));
      r.on('error', reject);
      r.end(data);
    });

  // ---- folders

  const privatePaths = () => {
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    return [...new Set([o.dataDir, ...appDirs(), ...credentialStores(home), ...autorunPaths(home, o.roots())].flatMap((p) => [p, real(p)]))];
  };
  const within = (p: string, root: string) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');
  const containsPrivate = (dir: string) => privatePaths().find((p) => within(p, dir));

  /**
   * An allowed folder a container may mount: itself a real folder that no agent can move or replace (its parent
   * isn't writable to them), holding nothing agents never get (Wren, credential stores, startup files).
   */
  const folderProblem = (root: string): string | null => {
    if (!o.roots().includes(root)) return `${root} isn’t one of the folders allowed on this computer`;
    try {
      if (realpathSync(root) !== root || !statSync(root).isDirectory()) return `${root} isn’t a plain folder`;
    } catch {
      return `${root} doesn’t exist`;
    }
    if (agentCanWrite(dirname(root), o.roots(), o.dataDir, home)) return `${root} is inside a folder agents may change, so a container can’t mount it safely (allow narrower folders than the one holding it)`;
    const inside = containsPrivate(root);
    if (inside) return `${root} holds ${inside}, which agents never use, so containers can’t mount it`;
    return null;
  };

  /** The volume backed by an allowed folder (made the first time), named after the folder. */
  const folderVolume = async (root: string): Promise<string> => {
    const name = FOLDER_VOLUME + createHash('sha256').update(root).digest('hex').slice(0, 16);
    const want = { type: 'none', o: 'bind', device: root };
    const now = await ask('GET', `/volumes/${name}`);
    if (now.status === 404) {
      const made = await ask('POST', '/volumes/create', { Name: name, Driver: 'local', DriverOpts: want, Labels: { 'dev.wren.folder': root } });
      if (made.status >= 300) throw new Error(`Docker couldn’t make the volume for ${root}: ${(made.json as { message?: string })?.message ?? made.status}`);
      return name;
    }
    const v = now.json as { Driver?: string; Options?: Record<string, string> } | null;
    const opts = v?.Options ?? {};
    const same = Object.keys(opts).length === 3 && Object.entries(want).every(([k, x]) => opts[k] === x);
    if (now.status !== 200 || v?.Driver !== 'local' || !same) throw new Error(`a volume named ${name} exists with other settings; remove it (docker volume rm ${name})`);
    return name;
  };

  /** A volume as a container would mount it: plain, a tmpfs, or an allowed folder's (strict: one that is safe to mount now). */
  const volumeProblem = async (name: string, strict: boolean): Promise<string | null> => {
    if (!VOLUME_NAME.test(name)) return `can’t read the volume name ${name}`;
    const r = await ask('GET', `/volumes/${encodeURIComponent(name)}`);
    if (r.status === 404) return null; // Docker makes a plain local one
    if (r.status !== 200) return `Docker couldn’t look up the volume ${name}`;
    const v = r.json as { Driver?: string; Options?: Record<string, string> | null } | null;
    if (v?.Driver !== 'local') return `the volume ${name} uses the driver ${v?.Driver}, which isn’t allowed`;
    const opts = v.Options ?? {};
    const keys = Object.keys(opts).sort().join(',');
    if (!keys) return null;
    if (opts.type === 'tmpfs' && /^(device,)?(o,)?type$/.test(keys) && (opts.device ?? 'tmpfs') === 'tmpfs') return null;
    if (keys === 'device,o,type' && opts.type === 'none' && /^r?bind$/.test(opts.o ?? '')) {
      const dev = opts.device ?? '';
      if (strict) return folderProblem(dev) && `the volume ${name} is backed by ${dev}: ${folderProblem(dev)}`;
      return inFolders(dev) ? null : `the volume ${name} is backed by ${dev}, outside the allowed folders`;
    }
    return `the volume ${name} has driver options agents can’t use`;
  };

  /** A path that is inside an allowed folder and leads nowhere agents never go. */
  const inFolders = (p: string) => o.roots().some((r) => within(p, r)) && !containsPrivate(p) && !reachesAny(p, o.roots()[0] ?? home, privatePaths());

  /**
   * A folder of this Mac to mount at `target`: an allowed folder or something inside one, as a sub-path of that
   * folder's volume. The outermost allowed folder holding it is the one mounted (its parent is outside them).
   */
  const folderMount = async (source: string, target: unknown, readOnly: boolean): Promise<Obj | string> => {
    if (typeof source !== 'string' || !source.startsWith('/') || /\/\.\.?(\/|$)|\/\//.test(source)) return `can’t mount ${String(source)}: give a full path without . or ..`;
    if (typeof target !== 'string' || !target) return 'a mount needs a target inside the container';
    const path = source.replace(/\/+$/, '') || '/';
    const root = o.roots().filter((r) => within(path, r)).sort((a, b) => a.length - b.length)[0];
    if (!root) return `${path} is outside the folders allowed on this computer, so containers can’t mount it`;
    const why = folderProblem(root);
    if (why) return why;
    const sub = path === root ? '' : path.slice(root.length + 1);
    if (sub && !existsSync(path)) {
      // Docker makes a missing bind folder; a sub-path must exist. Made inside the file helper's sandbox.
      try {
        await makeFolderConfined(path, o.roots(), o.dataDir);
      } catch (e) {
        return `${path} doesn’t exist and couldn’t be made: ${(e as Error).message}`;
      }
    }
    const volume = await folderVolume(root);
    return { Type: 'volume', Source: volume, Target: target, ReadOnly: readOnly, VolumeOptions: { NoCopy: true, ...(sub ? { Subpath: sub } : {}) } };
  };

  /** Check a new container's settings and turn its folder mounts into volume sub-paths (in place). */
  const prepareCreate = async (body: unknown): Promise<string | null> => {
    if (!isObj(body)) return 'the request isn’t a JSON object';
    const hcf = field(body, 'HostConfig');
    const problem = hostConfigProblem(hcf?.value);
    if (problem) return problem;
    if (!hcf || !isObj(hcf.value)) return null;
    const hc = hcf.value;
    const binds = field(hc, 'Binds');
    const mounts = field(hc, 'Mounts');
    if (binds && binds.value !== null && !Array.isArray(binds.value)) return 'Binds isn’t a list';
    if (mounts && mounts.value !== null && !Array.isArray(mounts.value)) return 'Mounts isn’t a list';
    const keepBinds: unknown[] = [];
    const out: unknown[] = [];
    for (const b of (binds?.value as unknown[] | null) ?? []) {
      if (typeof b !== 'string') return 'a Binds entry isn’t text';
      const parts = b.split(':');
      if (parts.length < 2 || parts.length > 3) return `can’t read the mount ${b}`;
      const [src, dst, mode = ''] = parts;
      const opts = mode ? mode.split(',') : [];
      const bad = opts.find((x) => !BIND_OPTIONS.has(x));
      if (bad) return `the mount option ${bad} isn’t allowed`;
      if (src.startsWith('/')) {
        const m = await folderMount(src, dst, opts.includes('ro'));
        if (typeof m === 'string') return m;
        out.push(m);
      } else {
        const p = await volumeProblem(src, true);
        if (p) return p;
        keepBinds.push(b);
      }
    }
    for (const m of (mounts?.value as unknown[] | null) ?? []) {
      if (!isObj(m)) return 'a Mounts entry isn’t an object';
      const type = String(val(m, 'Type') ?? '');
      if (type === 'bind') {
        const prop = val(val(m, 'BindOptions'), 'Propagation');
        if (!unset(prop) && !['private', 'rprivate'].includes(String(prop))) return `mount propagation ${String(prop)} isn’t allowed`;
        const fm = await folderMount(val(m, 'Source') as string, val(m, 'Target'), val(m, 'ReadOnly') === true);
        if (typeof fm === 'string') return fm;
        out.push(fm);
      } else if (type === 'volume') {
        const dc = val(val(m, 'VolumeOptions'), 'DriverConfig');
        if (!unset(dc) && (!unset(val(dc, 'Options')) || !['', 'local', undefined, null].includes(val(dc, 'Name') as string))) return 'volumes with driver options aren’t allowed';
        const src = val(m, 'Source');
        if (typeof src === 'string' && src) {
          const p = await volumeProblem(src, true);
          if (p) return p;
        }
        out.push(m);
      } else if (type === 'tmpfs' || type === 'image') out.push(m);
      else return `mounts of type ${type || '(none)'} aren’t allowed`;
    }
    if (binds) hc[binds.key] = keepBinds;
    hc[mounts?.key ?? 'Mounts'] = out;
    // Which task made it (shown by `docker inspect`; nothing depends on it).
    const labels = field(body, 'Labels');
    if (labels && isObj(labels.value)) labels.value['dev.wren.task'] = o.runId;
    else if (!labels || labels.value === null) body[labels?.key ?? 'Labels'] = { 'dev.wren.task': o.runId };
    return null;
  };

  /**
   * An existing container: its settings must be ones Wren would make, and its mounts (strict, for starting it,
   * when Docker resolves them again) only volumes, never a folder of this Mac directly; else (exec, attach,
   * copying files) folders already mounted must be inside the allowed folders. Answers its fixed id, so a rename
   * between this check and the request can't swap it.
   */
  const checkContainer = async (ref: string, strict: boolean): Promise<{ id: string } | { status: number; problem: string }> => {
    const r = await ask('GET', `/containers/${ref}/json`);
    if (r.status === 404) return { status: 404, problem: `No such container: ${ref}` };
    if (r.status !== 200 || !isObj(r.json)) return { status: 502, problem: 'Docker couldn’t say what the container is' };
    const info = r.json;
    const id = String(info.Id ?? '');
    if (!/^[0-9a-f]{64}$/.test(id)) return { status: 502, problem: 'Docker gave no container id' };
    const hp = hostConfigProblem(info.HostConfig, true);
    if (hp) return { status: 403, problem: `the container ${ref}: ${hp}` };
    for (const m of (Array.isArray(info.Mounts) ? info.Mounts : []) as Obj[]) {
      const type = String(m.Type ?? '');
      if (type === 'bind') {
        const src = String(m.Source ?? '');
        if (strict) return { status: 403, problem: `the container ${ref} has ${src} mounted directly, which Docker would look up again when it starts; only containers whose folders were mounted through Wren can be started by agents` };
        if (!inFolders(src)) return { status: 403, problem: `the container ${ref} has ${src} mounted, outside the allowed folders` };
      } else if (type === 'volume') {
        const p = await volumeProblem(String(m.Name ?? ''), strict);
        if (p) return { status: 403, problem: `the container ${ref}: ${p}` };
      } else if (type !== 'tmpfs' && type !== 'image') return { status: 403, problem: `the container ${ref} has a mount of type ${type}` };
    }
    return { id };
  };

  // ---- serving

  const refuse = (res: ServerResponse, status: number, message: string) => {
    o.log?.(`docker: refused ${status}: ${message}`);
    if (res.headersSent) return res.destroy();
    const body = JSON.stringify({ message: `Wren: ${message}` });
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let n = 0;
      req.on('data', (c: Buffer) => {
        n += c.length;
        if (n > MAX_BODY) {
          reject(Object.assign(new Error('the request is too large'), { status: 413 }));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  /** Pass a request on to Docker on a connection of its own, and its answer back (streamed). */
  const forward = (req: IncomingMessage, res: ServerResponse, path: string, body?: Buffer, onReply?: (r: Reply) => void) => {
    const up = request({ socketPath: upstreamPath(), method: req.method, path, agent: false, headers: forwardHeaders(req.headers, body?.length) }, (ur) => {
      const headers: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(ur.headers)) if (v !== undefined && !HOP.has(k)) headers[k] = v;
      if (onReply) {
        const chunks: Buffer[] = [];
        ur.on('data', (c: Buffer) => chunks.push(c));
        ur.on('end', () => {
          const b = Buffer.concat(chunks);
          try {
            onReply({ status: ur.statusCode ?? 502, body: b, json: JSON.parse(b.toString('utf8') || 'null') });
          } catch {
            // not JSON: nothing to note
          }
          res.writeHead(ur.statusCode ?? 502, { ...headers, 'content-length': String(b.length) });
          res.end(b);
        });
        return;
      }
      res.writeHead(ur.statusCode ?? 502, headers);
      // Docker answers some requests with headers first and the body later (wait: once the container exits;
      // the CLI starts the container only after those headers): they go on at once, not with the first byte.
      res.flushHeaders();
      ur.pipe(res);
    });
    up.on('error', (e) => refuse(res, 502, `couldn’t reach Docker: ${e.message}`));
    res.on('close', () => up.destroy());
    if (body) up.end(body);
    else req.pipe(up);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    o.log?.(`docker: ${req.method} ${req.url}`);
    const t = parseTarget(req.url ?? '');
    if (!t) return refuse(res, 400, 'that request path isn’t allowed');
    const route = routeOf(req.method ?? '', t.path);
    if (!route || route.kind === 'attach' || route.kind === 'exec-start' || route.kind === 'buildkit') {
      return refuse(res, 403, `${req.method} ${t.path} isn’t available to agents${route ? ' without a stream (Upgrade)' : ''}`);
    }
    const to = (path: string) => `${t.version}${path}${t.query}`;
    switch (route.kind) {
      case 'read':
      case 'write':
        return forward(req, res, to(t.path));
      case 'build': {
        const p = buildProblem(t.query);
        return p ? refuse(res, 403, p) : forward(req, res, to(t.path));
      }
      case 'create': {
        const body = parseStrictJson((await readBody(req)).toString('utf8'));
        const p = await prepareCreate(body);
        return p ? refuse(res, 403, p) : forward(req, res, to(t.path), Buffer.from(JSON.stringify(body)));
      }
      case 'update': {
        // Resources and the restart policy, which share names with what create checks (Devices, CgroupParent…).
        const body = parseStrictJson((await readBody(req)).toString('utf8'));
        const p = hostConfigProblem(body);
        return p ? refuse(res, 403, p) : forward(req, res, to(t.path), Buffer.from(JSON.stringify(body)));
      }
      case 'volume-create': {
        const body = parseStrictJson((await readBody(req)).toString('utf8'));
        const name = String(val(body, 'Name') ?? '');
        const driver = val(body, 'Driver');
        if (name.startsWith(FOLDER_VOLUME)) return refuse(res, 403, `volume names starting with ${FOLDER_VOLUME} are Wren’s`);
        if (!unset(driver) && driver !== 'local') return refuse(res, 403, `the volume driver ${String(driver)} isn’t allowed`);
        if (!unset(val(body, 'DriverOpts'))) return refuse(res, 403, 'volume driver options (a folder of this Mac, a device, a network share) aren’t allowed; mount a folder in a container instead');
        return forward(req, res, to(t.path), Buffer.from(JSON.stringify(body)));
      }
      case 'start':
      case 'use': {
        const start = route.kind === 'start';
        if (start) {
          const b = (await readBody(req)).toString('utf8').trim();
          if (b && b !== '{}' && b !== 'null') return refuse(res, 403, 'settings can’t be given when starting a container');
        }
        const c = await checkContainer(route.container!, start);
        if ('problem' in c) return refuse(res, c.status, c.problem);
        return forward(req, res, to(t.path.replace(`/containers/${route.container}/`, `/containers/${c.id}/`)), start ? Buffer.alloc(0) : undefined);
      }
      case 'exec-create': {
        const body = parseStrictJson((await readBody(req)).toString('utf8'));
        if (!isObj(body)) return refuse(res, 400, 'the request isn’t a JSON object');
        if (val(body, 'Privileged') === true) return refuse(res, 403, 'privileged exec isn’t allowed');
        const c = await checkContainer(route.container!, false);
        if ('problem' in c) return refuse(res, c.status, c.problem);
        return forward(req, res, to(`/containers/${c.id}/exec`), Buffer.from(JSON.stringify(body)), (r) => {
          const id = (r.json as { Id?: string } | null)?.Id;
          if (r.status < 300 && typeof id === 'string') execs.set(id, c.id);
        });
      }
      case 'exec':
        if (!execs.has(route.exec!)) return refuse(res, 403, 'that exec wasn’t made through Wren for this task');
        return forward(req, res, to(t.path));
    }
  };

  /**
   * attach, exec start and BuildKit's session and gRPC: the connection becomes a raw stream once Docker agrees.
   * Docker gets the request and its body only, and nothing more is passed on until it answers 101 (or 200, a
   * hijack): if it refuses, a second request hidden in the stream must not reach it.
   */
  const upgrade = async (req: IncomingMessage, socket: Socket, head: Buffer) => {
    o.log?.(`docker: stream ${req.method} ${req.url}`);
    const deny = (status: number, message: string) => {
      o.log?.(`docker: refused stream ${status}: ${message}`);
      const body = JSON.stringify({ message: `Wren: ${message}` });
      socket.end(`HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : 'Forbidden'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    };
    const t = parseTarget(req.url ?? '');
    const route = t && routeOf(req.method ?? '', t.path);
    if (!t || !route || !['attach', 'exec-start', 'buildkit'].includes(route.kind)) return deny(403, `${req.method} ${t?.path ?? req.url} can’t be a stream`);
    let path = t.path;
    if (route.kind === 'attach') {
      const c = await checkContainer(route.container!, false);
      if ('problem' in c) return deny(c.status, c.problem);
      path = path.replace(`/containers/${route.container}/`, `/containers/${c.id}/`);
    } else if (route.kind === 'exec-start') {
      if (!execs.has(route.exec!)) return deny(403, 'that exec wasn’t made through Wren for this task');
    } else {
      const p = buildkitProblem(home);
      if (p) return deny(403, p);
    }
    const length = Number(req.headers['content-length'] ?? 0);
    if (req.headers['transfer-encoding'] || !Number.isInteger(length) || length < 0 || length > MAX_HEAD) return deny(400, 'a stream request must have a short, fixed-length body');
    // The request's own body. Node (checked on 26) hands it to the request object and only what follows it to
    // `head`; older versions put it in `head`. Either way the order is body, then the rest; anything still
    // missing comes from the connection.
    const fromReq = length
      ? await new Promise<Buffer>((resolve) => {
          const chunks: Buffer[] = [];
          let n = 0;
          const finish = () => (clearTimeout(timer), resolve(Buffer.concat(chunks)));
          const timer = setTimeout(finish, 5000);
          req.on('data', (c: Buffer) => {
            chunks.push(c);
            n += c.length;
            if (n >= length) finish();
          });
          req.once('end', finish);
        })
      : Buffer.alloc(0);
    let got = Buffer.concat([fromReq, head]);
    socket.pause();
    while (got.length < length) {
      const more = await new Promise<Buffer | null>((resolve) => {
        const onData = (c: Buffer) => (cleanup(), resolve(c));
        const onEnd = () => (cleanup(), resolve(null));
        const cleanup = () => {
          socket.off('data', onData);
          socket.off('end', onEnd);
          socket.off('close', onEnd);
          socket.pause();
        };
        socket.on('data', onData);
        socket.once('end', onEnd);
        socket.once('close', onEnd);
        socket.resume();
      });
      if (!more) return socket.destroy();
      got = Buffer.concat([got, more]);
    }
    const body = got.subarray(0, length);
    const rest = got.subarray(length);
    let up: Socket;
    try {
      up = connect(upstreamPath());
    } catch (e) {
      return deny(503, (e as Error).message);
    }
    const lines = [`${req.method} ${t.version}${path}${t.query} HTTP/1.1`, 'Host: docker'];
    for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
      const k = req.rawHeaders[i];
      if (/^(host|transfer-encoding|proxy-.*)$/i.test(k) || /[\r\n]/.test(req.rawHeaders[i + 1])) continue;
      lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
    }
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (body.length) up.write(body);
    // Docker's answer head, before anything else of the client's goes on.
    let answer = Buffer.alloc(0);
    const ok = await new Promise<boolean>((resolve) => {
      const onData = (c: Buffer) => {
        answer = Buffer.concat([answer, c]);
        const end = answer.indexOf('\r\n\r\n');
        if (end < 0) {
          if (answer.length > MAX_HEAD) done(false);
          return;
        }
        const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(answer.toString('latin1'))?.[1]);
        done(status === 101 || status === 200);
      };
      const done = (v: boolean) => {
        up.off('data', onData);
        up.off('close', onClose);
        up.pause();
        resolve(v);
      };
      const onClose = () => done(false);
      up.on('data', onData);
      up.once('close', onClose);
    });
    socket.write(answer);
    if (!ok) {
      // Docker's error, to its end (its length, or 2 s), and nothing of the client's after the request.
      const end = answer.indexOf('\r\n\r\n');
      const want = Number(/\r\ncontent-length:\s*(\d+)/i.exec(answer.subarray(0, end).toString('latin1'))?.[1] ?? 0) - (answer.length - end - 4);
      if (want > 0 && want <= MAX_HEAD) {
        let left = want;
        const stop = setTimeout(() => (up.destroy(), socket.end()), 2000);
        up.on('data', (c: Buffer) => {
          socket.write(c.subarray(0, left));
          left -= c.length;
          if (left <= 0) (clearTimeout(stop), up.destroy(), socket.end());
        });
        up.resume();
        return;
      }
      socket.end();
      up.destroy();
      return;
    }
    if (rest.length) up.write(rest);
    // Half-closing passes on (stdin's end while output goes on); a connection gone on either side ends both.
    socket.once('close', () => up.destroy());
    up.once('close', () => socket.destroy());
    socket.pipe(up);
    up.pipe(socket);
    socket.resume();
    up.resume();
  };

  const server = createServer({ requestTimeout: 0, headersTimeout: 30_000 }, (req, res) => {
    handle(req, res).catch((e) => refuse(res, (e as { status?: number }).status ?? 400, (e as Error).message));
  });
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    upgrade(req, socket, head).catch(() => socket.destroy());
  });
  try {
    unlinkSync(o.socketPath);
  } catch {
    // nothing there
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.socketPath, () => resolve());
  });
  return {
    path: o.socketPath,
    close: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

/**
 * BuildKit's own settings decide whether a build step may run privileged (`--allow security.insecure`); Docker
 * Desktop refuses that unless its Docker Engine settings turn it on (tested), which the API doesn't report. Read
 * those settings (never the CLI's config, which holds logins): if they grant anything beyond the host network,
 * BuildKit isn't passed on.
 */
export function buildkitProblem(home = homedir()): string | null {
  let cfg: unknown;
  try {
    cfg = JSON.parse(readFileSync(join(home, '.docker', 'daemon.json'), 'utf8'));
  } catch {
    return null;
  }
  const e = val(val(cfg, 'builder'), 'entitlements');
  if (isObj(e) && Object.entries(e).some(([k, v]) => v === true && k !== 'network-host')) {
    return 'BuildKit isn’t available to agents because Docker’s settings let builds run privileged steps; set DOCKER_BUILDKIT=0 to use the classic builder';
  }
  return null;
}

// ------------------------------------------------------------------ per run

/** The Docker sockets of the engines Wren knows on macOS, in order: the first that exists is used. */
export function dockerSocket(home = homedir()): string | null {
  const own = process.env.DOCKER_HOST?.startsWith('unix://') ? [process.env.DOCKER_HOST.slice(7)] : [];
  for (const p of [...own, join(home, '.docker/run/docker.sock'), '/var/run/docker.sock', join(home, '.colima/default/docker.sock'), join(home, '.orbstack/run/docker.sock'), join(home, '.rd/docker.sock')]) {
    if (existsSync(p)) return p;
  }
  return null;
}

const brokers = new Map<string, Promise<{ path: string; close: () => void }>>();

/**
 * A run's Docker: its broker (started once, in its temp folder) and what its commands need to use it. The CLI's
 * own config (~/.docker) is a credential store agents can't read, so they get a config of their own that finds
 * the CLI's plugins (compose, buildx); testcontainers' reaper, which mounts the Docker socket, is turned off.
 */
export async function dockerEnv(runId: string, temp: string, roots: () => string[], dataDir: string): Promise<Record<string, string>> {
  let b = brokers.get(runId);
  if (!b) {
    b = startDockerBroker({ socketPath: join(temp, 'd.sock'), upstream: () => dockerSocket(), roots, dataDir, runId, log: process.env.WREN_DOCKER_LOG ? (l) => console.error(l) : undefined });
    brokers.set(runId, b);
    b.catch(() => brokers.delete(runId));
  }
  const { path } = await b;
  const config = join(temp, 'docker');
  mkdirSync(config, { recursive: true, mode: 0o700 });
  writeFileSync(join(config, 'config.json'), JSON.stringify({ cliPluginsExtraDirs: PLUGIN_DIRS }), { mode: 0o600 });
  return { DOCKER_HOST: `unix://${path}`, DOCKER_CONFIG: config, TESTCONTAINERS_RYUK_DISABLED: 'true' };
}

/** A run ended: its broker stops (containers it made keep running, like any the user starts). */
export function stopRunDocker(runId: string): void {
  const b = brokers.get(runId);
  brokers.delete(runId);
  void b?.then((x) => x.close()).catch(() => {});
}
