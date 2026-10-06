// Local development only. The Supabase CLI (2.119) has no config.toml key for MFA recovery codes
// yet, although the Auth server it runs (v2.197) supports them. This recreates the local Auth
// container with them turned on: same image, environment, labels and network, plus the two
// switches. `supabase stop` removes it as usual. Run it after `npx supabase start`.
//   node scripts/local-auth-recovery-codes.mjs
import { execFileSync } from 'node:child_process';

const name = 'supabase_auth_wren';
const [c] = JSON.parse(execFileSync('docker', ['inspect', name], { encoding: 'utf8' }));
const env = c.Config.Env.filter((e) => !e.startsWith('GOTRUE_MFA_RECOVERY_CODES_'));
env.push('GOTRUE_MFA_RECOVERY_CODES_ENROLL_ENABLED=true', 'GOTRUE_MFA_RECOVERY_CODES_VERIFY_ENABLED=true');
const args = ['run', '-d', '--name', name, '--restart', c.HostConfig.RestartPolicy?.Name || 'no'];
for (const [net, cfg] of Object.entries(c.NetworkSettings.Networks)) {
  args.push('--network', net);
  for (const a of cfg.Aliases ?? []) args.push('--network-alias', a);
}
for (const [k, v] of Object.entries(c.Config.Labels ?? {})) args.push('--label', `${k}=${v}`);
for (const e of env) args.push('-e', e);
const hc = c.Config.Healthcheck;
if (hc?.Test?.[0] === 'CMD-SHELL') args.push('--health-cmd', hc.Test[1], '--health-interval', `${hc.Interval / 1e9}s`, '--health-timeout', `${hc.Timeout / 1e9}s`, '--health-retries', String(hc.Retries));
args.push(c.Config.Image, ...(c.Config.Cmd ?? []));
execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
execFileSync('docker', args, { stdio: 'ignore' });
for (let i = 0; i < 60; i++) {
  const s = execFileSync('docker', ['inspect', name, '--format', '{{.State.Health.Status}}'], { encoding: 'utf8' }).trim();
  if (s === 'healthy') break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log('Local Auth restarted with MFA recovery codes enabled.');
