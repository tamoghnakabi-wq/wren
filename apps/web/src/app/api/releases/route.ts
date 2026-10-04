import { json } from '@/lib/http';
import { latestRelease } from '@/lib/releases';

export async function GET() {
  const r = await latestRelease();
  return json(r ? { available: true, ...r } : { available: false }, { headers: { 'cache-control': 'public, s-maxage=300, stale-while-revalidate=600' } });
}
