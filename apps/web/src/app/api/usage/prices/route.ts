import { buildPriceTable, LITELLM_URL, type PriceTable } from '@/lib/model-prices';

// Model prices for the Usage page's local-usage estimates: LiteLLM's public price list, cut down to bare
// model names. Public (prices only, nothing about anyone), cached for a day here and at the edge so the
// 5 MB list is fetched rarely. 503 when it can't be fetched; the page then shows tokens without costs.

const MAX_BYTES = 32 * 1024 * 1024;
const KEEP_MS = 6 * 60 * 60 * 1000;
let held: { at: number; models: PriceTable } | null = null;

async function fetchTable(): Promise<PriceTable> {
  const res = await fetch(LITELLM_URL, { headers: { 'user-agent': 'wren-site' }, signal: AbortSignal.timeout(20_000), cache: 'no-store' });
  if (!res.ok || !res.body) throw new Error(`price list answered ${res.status}`);
  // Read with a cap: the list is about 5 MB.
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_BYTES) throw new Error('price list too large');
    chunks.push(chunk);
  }
  const models = buildPriceTable(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  if (Object.keys(models).length < 50) throw new Error('price list looks wrong');
  return models;
}

export async function GET() {
  try {
    if (!held || Date.now() - held.at > KEEP_MS) held = { at: Date.now(), models: await fetchTable() };
  } catch {
    if (!held) return Response.json({ error: 'Prices are unavailable right now.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
  }
  return Response.json(
    { source: 'LiteLLM', fetchedAt: new Date(held.at).toISOString(), models: held.models },
    { headers: { 'cache-control': 'public, s-maxage=86400, stale-while-revalidate=604800' } },
  );
}
