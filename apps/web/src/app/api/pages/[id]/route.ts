import { requireUser } from '@/lib/auth';
import { readArtifactBytes } from '@/lib/blob';
import { db } from '@/lib/db';
import { notFound, route, uuid } from '@/lib/http';
import { framedByWren, pageDocument, pageHeaders } from '@/lib/pages';

type Ctx = { params: Promise<{ id: string }> };

// A page an agent made (task.show_page), for the sandboxed frame that shows it in a task or on its own page
// (/app/page/[id]). Owner-checked like any file, and only ever as a frame of Wren's own pages; the page
// itself runs under lib/pages.ts's policy. ?theme=dark gives it Wren's dark colours.
export const GET = route<Ctx>(async (req, ctx) => {
  if (!framedByWren(req.headers)) {
    return new Response('Open this page from its task in Wren.', { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  }
  const user = await requireUser(req);
  const id = uuid.parse((await ctx.params).id);
  const [a] = await db()`select blob_path from public.artifacts where id = ${id} and user_id = ${user.id} and kind = 'page'`;
  if (!a) notFound('Page not found.');
  const bytes = await readArtifactBytes(a.blob_path);
  if (!bytes) notFound('The page’s content is missing.');
  const theme = new URL(req.url).searchParams.get('theme') === 'dark' ? 'dark' : 'light';
  return new Response(pageDocument(bytes!.toString('utf8'), theme), { headers: pageHeaders() });
});
