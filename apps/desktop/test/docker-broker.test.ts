import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => '0.0.0' }, safeStorage: {} }));
const { startDockerBroker, parseStrictJson, routeOf, parseTarget, hostConfigProblem, stopContainersOutside, writeDockerConfig } = await import('../src/main/docker-broker');
const { makeRunTemp, runTempDir } = await import('../src/main/sandbox');

// The fix review (0.1.50): Docker for agents through a broker that passes on only what can't reach past the
// allowed folders. A fake Docker daemon records exactly what reaches it.

const ID = (c: string) => c.repeat(64);
const base = realpathSync(mkdtempSync(join(__dirname, '.tmp-docker-'))); // not a temp folder: agents can't write its parent
const proj = join(base, 'proj');
const holder = join(base, 'holder'); // an allowed folder that holds Wren's data folder
const data = join(holder, 'data');
const loose = realpathSync(mkdtempSync(join(tmpdir(), 'wren-loose-'))); // an allowed folder agents could replace (its parent is temp)
const sockDir = mkdtempSync('/tmp/wdb-');
mkdirSync(join(proj, 'sub'), { recursive: true });
mkdirSync(data, { recursive: true });

interface Seen {
  method: string;
  url: string;
  body: string;
}
let seen: Seen[] = [];
let smuggled = '';
let refuseExec = false;
const volumes = new Map<string, unknown>();
const containers = new Map<string, unknown>();
let upstream: Server;
let broker: { path: string; close: () => void };

const inspect = (id: string, mounts: unknown[], hc: Record<string, unknown> = {}) => ({
  Id: id,
  HostConfig: { Privileged: false, IpcMode: 'private', CgroupnsMode: 'private', Runtime: 'runc', MaskedPaths: ['/proc/kcore'], ReadonlyPaths: ['/proc/bus'], CapAdd: null, Devices: [], ...hc },
  Mounts: mounts,
});

beforeAll(async () => {
  upstream = createServer((req: IncomingMessage, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, body });
      const path = req.url!.replace(/^\/v[\d.]+/, '').split('?')[0];
      const json = (status: number, v: unknown) => (res.writeHead(status, { 'content-type': 'application/json' }), res.end(JSON.stringify(v)));
      let m: RegExpExecArray | null;
      if ((m = /^\/volumes\/([^/]+)$/.exec(path)) && req.method === 'GET') return volumes.has(m[1]) ? json(200, volumes.get(m[1])) : json(404, { message: 'no such volume' });
      if (path === '/volumes' && req.method === 'GET') return json(200, { Volumes: [...volumes.values()] });
      if (path === '/containers/json') {
        const vol = JSON.parse(new URL(req.url!, 'http://d').searchParams.get('filters') ?? '{}').volume?.[0];
        const all = [...containers.values()] as { Id: string; Mounts: { Name?: string }[] }[];
        return json(200, all.filter((c) => !vol || c.Mounts.some((x) => x.Name === vol)).map((c) => ({ Id: c.Id })));
      }
      if (path === '/volumes/create') {
        const v = JSON.parse(body);
        volumes.set(v.Name, { Name: v.Name, Driver: v.Driver ?? 'local', Options: v.DriverOpts ?? null });
        return json(201, {});
      }
      if ((m = /^\/containers\/([^/]+)\/json$/.exec(path))) return containers.has(m[1]) ? json(200, containers.get(m[1])) : json(404, { message: 'no such container' });
      if (path === '/containers/create') return json(201, { Id: ID('c') });
      if (/^\/containers\/[0-9a-f]{64}\/exec$/.test(path)) return json(201, { Id: ID('e') });
      json(200, {});
    });
  });
  upstream.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    seen.push({ method: req.method!, url: req.url!, body: '' });
    if (req.url!.includes(`/exec/${ID('e')}/start`) && !refuseExec) {
      socket.write('HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
      socket.on('data', (c) => socket.write(`echo:${c}`));
      socket.on('end', () => socket.end()); // like an exec that ends with its input
      return;
    }
    // Refused, and the connection kept: anything more on it would be read as another request.
    socket.write('HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 22\r\n\r\n{"message":"no such."}');
    socket.on('data', (c) => (smuggled += c));
  });
  await new Promise<void>((r) => upstream.listen(join(sockDir, 'u.sock'), () => r()));
  broker = await startDockerBroker({ socketPath: join(sockDir, 'b.sock'), upstream: () => join(sockDir, 'u.sock'), roots: () => [proj, holder, loose], dataDir: data, runId: 'run-1', home: base });
});

afterAll(() => {
  broker?.close();
  upstream?.close();
  for (const d of [base, loose, sockDir]) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  seen = [];
  smuggled = '';
});

function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: { message?: string } & Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const r = request({ socketPath: broker.path, method, path, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode!, json: b ? JSON.parse(b) : {} }));
    });
    r.on('error', reject);
    r.end(data);
  });
}
const sent = (path: string) => seen.find((s) => s.url.replace(/^\/v[\d.]+/, '').split('?')[0] === path);

describe.skipIf(process.platform === 'win32')('Docker through Wren’s broker', () => {
  it('passes on only the API routes agents may use, spelled plainly', async () => {
    for (const [m, p] of [['POST', '/v1.56/swarm/init'], ['POST', '/v1.56/plugins/pull'], ['POST', '/v1.56/auth'], ['POST', '/v1.56/services/create'], ['GET', '/v1.56/secrets'], ['GET', '/v1.56/containers/x/attach/ws']]) {
      expect((await call(m, p)).status, p).toBe(403);
    }
    for (const p of ['/v1.56/containers/../x/json', '/v1.56/containers/x%2Fy/json', '/v1.56//containers/json', '/v1.56/containers/./json']) expect((await call('GET', p)).status, p).toBe(400);
    expect(seen).toEqual([]);
    expect((await call('GET', '/v1.56/containers/json?all=1&filters=%7B%7D')).status).toBe(200);
    expect(seen[0].url).toBe('/v1.56/containers/json?all=1&filters=%7B%7D');
    expect(routeOf('POST', '/containers/abc/start')).toEqual({ kind: 'start', container: 'abc' });
    expect(parseTarget('/v1.56/images/ghcr.io/a/b:1/json')).toEqual({ version: '/v1.56', path: '/images/ghcr.io/a/b:1/json', query: '' });
  });

  it('mounts allowed folders only as sub-paths of a volume backed by the folder itself, and makes a missing one inside the sandbox', async () => {
    // The sandboxed helper that makes a missing folder is macOS's (the broker runs only there).
    if (process.platform !== 'darwin') mkdirSync(join(proj, 'new', 'deep'), { recursive: true });
    const r = await call('POST', '/v1.56/containers/create?name=web', {
      Image: 'redis:7-alpine',
      HostConfig: {
        Binds: [`${proj}/sub:/app`, `${proj}:/w:ro`, 'named:/data'],
        Mounts: [{ Type: 'bind', Source: `${proj}/new/deep`, Target: '/n' }, { Type: 'tmpfs', Target: '/t' }],
      },
    });
    expect(r.status).toBe(201);
    const made = JSON.parse(sent('/volumes/create')!.body);
    expect(made.DriverOpts).toEqual({ type: 'none', o: 'bind', device: proj });
    const body = JSON.parse(sent('/containers/create')!.body);
    expect(body.HostConfig.Binds).toEqual(['named:/data']);
    const vol = made.Name;
    expect(vol).toMatch(/^wren-folder-[0-9a-f]{16}$/);
    expect(body.HostConfig.Mounts).toEqual([
      { Type: 'volume', Source: vol, Target: '/app', ReadOnly: false, VolumeOptions: { NoCopy: true, Subpath: 'sub' } },
      { Type: 'volume', Source: vol, Target: '/w', ReadOnly: true, VolumeOptions: { NoCopy: true } },
      { Type: 'volume', Source: vol, Target: '/n', ReadOnly: false, VolumeOptions: { NoCopy: true, Subpath: 'new/deep' } },
      { Type: 'tmpfs', Target: '/t' },
    ]);
    expect(body.Labels).toEqual({ 'dev.wren.task': 'run-1' });
    if (process.platform === 'darwin') expect(existsSync(join(proj, 'new', 'deep'))).toBe(true);
  });

  it('refuses containers that could reach past the allowed folders or their own namespaces', async () => {
    volumes.set('evil', { Name: 'evil', Driver: 'local', Options: { type: 'none', o: 'bind', device: '/Users' } });
    const refused: [string, unknown][] = [
      ['a folder outside', { HostConfig: { Binds: ['/etc:/x'] } }],
      ['the Docker socket', { HostConfig: { Binds: ['/var/run/docker.sock:/var/run/docker.sock'] } }],
      ['dot segments', { HostConfig: { Binds: [`${proj}/../data:/x`] } }],
      ['a folder agents could swap', { HostConfig: { Binds: [`${loose}:/x`] } }],
      ['a folder holding Wren’s data', { HostConfig: { Mounts: [{ Type: 'bind', Source: holder, Target: '/x' }] } }],
      ['privileged', { HostConfig: { Privileged: true } }],
      ['SYS_ADMIN', { HostConfig: { CapAdd: ['SYS_ADMIN'] } }],
      ['ALL caps', { HostConfig: { CapAdd: ['ALL'] } }],
      ['the VM’s processes', { HostConfig: { PidMode: 'host' } }],
      ['another container’s processes', { HostConfig: { PidMode: 'container:db' } }],
      ['no seccomp', { HostConfig: { SecurityOpt: ['seccomp=unconfined'] } }],
      ['unmasked /proc', { HostConfig: { MaskedPaths: [] } }],
      ['a device', { HostConfig: { Devices: [{ PathOnHost: '/dev/vda', PathInContainer: '/dev/x' }] } }],
      ['volumes from another', { HostConfig: { VolumesFrom: ['db'] } }],
      ['a bind-backed named volume', { HostConfig: { Binds: ['evil:/x'] } }],
      ['volume driver options', { HostConfig: { Mounts: [{ Type: 'volume', Target: '/x', VolumeOptions: { DriverConfig: { Name: 'local', Options: { device: '/Users', o: 'bind', type: 'none' } } } }] } }],
      ['propagation', { HostConfig: { Mounts: [{ Type: 'bind', Source: proj, Target: '/x', BindOptions: { Propagation: 'rshared' } }] } }],
      ['a named pipe', { HostConfig: { Mounts: [{ Type: 'npipe', Source: 'x', Target: '/x' }] } }],
    ];
    for (const [why, body] of refused) expect((await call('POST', '/v1.56/containers/create', body)).status, why).toBe(403);
    // Docker's decoder ignores case and merges a key given twice: neither can hide a setting from the check.
    expect((await call('POST', '/v1.56/containers/create', '{"Image":"x","HostConfig":{},"hostconfig":{"Privileged":true}}')).status).toBe(400);
    expect((await call('POST', '/v1.56/containers/create', '{"Image":"x","HostConfig":{"Privileged":false},"HostConfig":{"Privileged":true}}')).status).toBe(400);
    expect((await call('POST', '/v1.56/containers/create', '{"Image":"x","HOSTCONFIG":{"privileged":true}}')).status).toBe(403);
    expect((await call('POST', '/v1.56/containers/create', '{"Image":"x","HostConfig":{"Binds":["/etc:/x"]}} {"x":1}')).status).toBe(400);
    expect(sent('/containers/create')).toBeUndefined();
  });

  it('checks updates like creates', async () => {
    expect((await call('POST', '/v1.56/containers/mine/update', { Devices: [{ PathOnHost: '/dev/vda', PathInContainer: '/x', CgroupPermissions: 'rwm' }] })).status).toBe(403);
    expect((await call('POST', '/v1.56/containers/mine/update', { CgroupParent: '/' })).status).toBe(403);
    expect((await call('POST', '/v1.56/containers/mine/update', { Memory: 268435456, RestartPolicy: { Name: 'unless-stopped' } })).status).toBe(200);
  });

  it('gives each run its own socket, a CLI config that finds compose and buildx, and no testcontainers reaper', async () => {
    const { dockerEnv, stopRunDocker } = await import('../src/main/docker-broker');
    const temp = mkdtempSync('/tmp/wde-');
    try {
      const env = await dockerEnv('run-env', temp, () => [proj], data);
      expect(env.DOCKER_HOST).toBe(`unix://${join(temp, 'd.sock')}`);
      expect(env.TESTCONTAINERS_RYUK_DISABLED).toBe('true');
      const cfg = JSON.parse((await import('node:fs')).readFileSync(join(env.DOCKER_CONFIG, 'config.json'), 'utf8'));
      expect(cfg).toEqual({ cliPluginsExtraDirs: expect.arrayContaining(['/Applications/Docker.app/Contents/Resources/cli-plugins']) });
      expect(Object.keys(cfg)).toEqual(['cliPluginsExtraDirs']); // no logins, no credential helpers
      expect((await dockerEnv('run-env', temp, () => [proj], data)).DOCKER_HOST).toBe(env.DOCKER_HOST); // started once
      stopRunDocker('run-env');
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  it('keeps volumes plain', async () => {
    expect((await call('POST', '/v1.56/volumes/create', { Name: 'v', DriverOpts: { type: 'none', o: 'bind', device: '/Users' } })).status).toBe(403);
    expect((await call('POST', '/v1.56/volumes/create', { Name: 'wren-folder-0000000000000000' })).status).toBe(403);
    expect((await call('POST', '/v1.56/volumes/create', { Name: 'v', Driver: 'sshfs' })).status).toBe(403);
    expect((await call('POST', '/v1.56/volumes/create', { Name: 'v', Labels: { a: 'b' }, DriverOpts: {} })).status).toBe(201);
  });

  it("starts only containers whose folders were mounted through Wren, by their fixed id; others' only to look at", async () => {
    volumes.set('wren-folder-x', { Name: 'wren-folder-x', Driver: 'local', Options: { type: 'none', o: 'bind', device: proj } });
    containers.set('mine', inspect(ID('a'), [{ Type: 'volume', Name: 'wren-folder-x', Driver: 'local' }, { Type: 'tmpfs' }]));
    containers.set('users', inspect(ID('b'), [{ Type: 'bind', Source: `${proj}/sub` }]));
    containers.set('socket', inspect(ID('d'), [{ Type: 'bind', Source: '/var/run/docker.sock' }]));
    containers.set('priv', inspect(ID('f'), [], { Privileged: true }));
    expect((await call('POST', '/v1.56/containers/mine/start')).status).toBe(200);
    expect(sent(`/containers/${ID('a')}/start`)).toBeTruthy();
    for (const c of ['users', 'socket', 'priv']) expect((await call('POST', `/v1.56/containers/${c}/start`)).status, c).toBe(403);
    expect((await call('POST', '/v1.56/containers/mine/start', { HostConfig: { Privileged: true } })).status).toBe(403);
    // A folder already mounted inside the allowed folders can be used (exec, copy files); the Docker socket or a privileged container can't.
    expect((await call('GET', '/v1.56/containers/users/archive?path=/x')).status).toBe(200);
    expect((await call('POST', '/v1.56/containers/socket/exec', { Cmd: ['sh'] })).status).toBe(403);
    expect((await call('POST', '/v1.56/containers/priv/exec', { Cmd: ['sh'] })).status).toBe(403);
    expect((await call('POST', '/v1.56/containers/mine/exec', { Cmd: ['sh'], Privileged: true })).status).toBe(403);
  });

  it('streams an exec it made, and nothing else; a refused upgrade carries nothing more to Docker', async () => {
    const ex = await call('POST', '/v1.56/containers/mine/exec', { Cmd: ['sh'] });
    expect(ex.json.Id).toBe(ID('e'));
    const stream = (path: string, extra = '') =>
      new Promise<string>((resolve) => {
        const s = connect(broker.path);
        let got = '';
        s.on('data', (c) => (got += c));
        s.on('close', () => resolve(got));
        const body = '{"Detach":false,"Tty":true}';
        s.write(`POST ${path} HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}${extra}`);
        setTimeout(() => (s.write('ping'), setTimeout(() => s.end(), 200)), 200);
      });
    expect(await stream(`/v1.56/exec/${ID('9')}/start`)).toMatch(/^HTTP\/1\.1 403/);
    const ok = await stream(`/v1.56/exec/${ID('e')}/start`);
    expect(ok).toMatch(/^HTTP\/1\.1 101/);
    expect(ok).toContain('echo:ping');
    // An exec Docker refuses: a request hidden after the first, and what follows, must not reach it.
    const hidden = 'POST /v1.56/containers/create HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}';
    refuseExec = true;
    try {
      const answer = await stream(`/v1.56/exec/${ID('e')}/start`, hidden);
      expect(answer).toMatch(/^HTTP\/1\.1 404[\s\S]*no such/);
      expect(smuggled).toBe('');
    } finally {
      refuseExec = false;
    }
  });

  it('refuses build options that reach past an ordinary build', async () => {
    expect((await call('POST', '/v1.56/build?t=x&securityopt=%5B%22seccomp%3Dunconfined%22%5D')).status).toBe(403);
    expect((await call('POST', '/v1.56/build?networkmode=container:db')).status).toBe(403);
    expect((await call('POST', '/v1.56/build?t=x&networkmode=host')).status).toBe(200);
  });

  // 2026-11-26 audit: Go folds a key's non-ASCII letters to the smallest of their case orbit, so `Prıvileged`
  // (dotless ı) is Docker's Privileged; the broker's NFKC-and-lowercase fold didn't see it.
  it('reads keys the way Docker’s decoder folds them, dotless i and long s included', async () => {
    for (const body of [
      '{"Image":"x","HostConfig":{"Prıvileged":true}}',
      '{"Image":"x","HostConfig":{"Bınds":["/etc:/x"]}}',
      '{"Image":"x","HostConfig":{"Mountſ":[{"Type":"bind","Source":"/etc","Target":"/x"}]}}',
      '{"Image":"x","HostConfıg":{"Privileged":true}}',
      '{"Image":"x","HostConfig":{"CapAdd":["SYS_ADMIN"],"Devıces":[{"PathOnHost":"/dev/vda","PathInContainer":"/x"}]}}',
    ]) {
      expect((await call('POST', '/v1.56/containers/create', body)).status, body).toBe(403);
    }
    expect((await call('POST', '/v1.56/containers/mine/exec', '{"Cmd":["sh"],"Prıvileged":true}')).status).toBe(403);
    expect(sent('/containers/create')).toBeUndefined();
  });

  it('reads every copy of a build option', async () => {
    expect((await call('POST', '/v1.56/build?securityopt=%5B%5D&securityopt=%5B%22seccomp%3Dunconfined%22%5D')).status).toBe(403);
    expect((await call('POST', '/v1.56/build?networkmode=host&networkmode=container:db')).status).toBe(403);
  });

  it('stops containers that use a folder no longer allowed, and only those', async () => {
    volumes.set('wren-folder-old', { Name: 'wren-folder-old', Driver: 'local', Options: { type: 'none', o: 'bind', device: '/Users/someone/removed' } });
    volumes.set('wren-folder-now', { Name: 'wren-folder-now', Driver: 'local', Options: { type: 'none', o: 'bind', device: proj } });
    containers.set('old', inspect(ID('7'), [{ Type: 'volume', Name: 'wren-folder-old', Driver: 'local' }]));
    containers.set('now', inspect(ID('8'), [{ Type: 'volume', Name: 'wren-folder-now', Driver: 'local' }]));
    expect(await stopContainersOutside([proj, holder, loose], join(sockDir, 'u.sock'))).toBe(1);
    expect(sent(`/containers/${ID('7')}/stop`)).toBeTruthy();
    expect(sent(`/containers/${ID('8')}/stop`)).toBeUndefined();
    expect(await stopContainersOutside([proj], null)).toBe(0); // Docker not running
  });

  it('never writes the CLI config, or a run’s folder, through a link an agent left', () => {
    const decoy = realpathSync(mkdtempSync(join(tmpdir(), 'wren-decoy-')));
    const dir = join(base, 'cli-config');
    symlinkSync(decoy, dir);
    expect(writeDockerConfig(dir)).toBe(dir);
    expect(lstatSync(dir).isDirectory()).toBe(true);
    expect(existsSync(join(decoy, 'config.json'))).toBe(false);
    const run = `link-${process.pid}`;
    mkdirSync(join(runTempDir(run), '..'), { recursive: true });
    symlinkSync(decoy, runTempDir(run));
    expect(lstatSync(makeRunTemp(run)).isDirectory()).toBe(true);
    rmSync(runTempDir(run), { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  });

  it('reads JSON the way Docker does, keeping big numbers as written', () => {
    expect(JSON.stringify(parseStrictJson('{"Memory":9007199254740993,"a":[1,2,{"b":null}]}'))).toBe('{"Memory":9007199254740993,"a":[1,2,{"b":null}]}');
    for (const bad of ['{"a":1,"A":2}', '{"Key":1,"key":2}', '{"a":1}x', '{"a":}', '{"a" 1}']) expect(() => parseStrictJson(bad), bad).toThrow();
    expect(hostConfigProblem({ CapAdd: ['cap_sys_ptrace', 'NET_ADMIN'] })).toBeNull();
    expect(hostConfigProblem({ IpcMode: 'host' })).toMatch(/IpcMode/);
    expect(hostConfigProblem({ MaskedPaths: ['/proc/kcore'] }, true)).toBeNull();
  });
});

writeFileSync(join(data, 'marker'), 'x'); // the data folder exists and holds something
