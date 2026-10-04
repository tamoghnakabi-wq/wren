import { z } from 'zod';
import { compareVersions, latestRelease, updateManifest } from '@/lib/releases';

// Desktop update check:
//   GET /api/updates?platform=darwin|win32&arch=arm64|x64&version=0.1.0
// 200 {version, notes, url, sha256, size, signature} when newer, 204 otherwise,
// 503 when GitHub is unreachable (the app retries later).
const Q = z.object({ platform: z.enum(['darwin', 'win32']), arch: z.enum(['arm64', 'x64']), version: z.string().regex(/^\d+\.\d+\.\d+([.-][\w.]+)?$/) });

export async function GET(req: Request) {
  const p = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!p.success) return Response.json({ error: 'Bad query' }, { status: 400 });
  const r = await latestRelease();
  if (!r) return new Response(null, { status: 503 });
  if (compareVersions(r.version, p.data.version) <= 0) return new Response(null, { status: 204 });
  const m = await updateManifest(r);
  const entry = m?.platforms?.[`${p.data.platform}-${p.data.arch}`];
  if (!m || !entry) return new Response(null, { status: 204 });
  if (!entry.url.startsWith(`https://github.com/`)) return new Response(null, { status: 204 });
  return Response.json({ version: m.version, notes: m.notes ?? r.notes, ...entry }, { headers: { 'cache-control': 'public, s-maxage=120' } });
}
