// Pages agents show (task.show_page): what one may be, checked the same way wherever an agent runs.
import { PAGE_MAX_BYTES, PAGE_TITLE_MAX } from './types';

/** A page to show: a title and an HTML document within the limits, or what is wrong with it. */
export function checkPage(args: Record<string, unknown>): { title: string; html: string } | { error: string } {
  const html = typeof args.html === 'string' ? args.html : '';
  const title = (typeof args.title === 'string' ? args.title : '').replace(/\s+/g, ' ').trim().slice(0, PAGE_TITLE_MAX) || 'Page';
  if (!html.trim()) return { error: 'The page is empty. Pass the whole HTML document as html.' };
  const bytes = utf8Bytes(html);
  if (bytes > PAGE_MAX_BYTES) return { error: `The page is ${Math.ceil(bytes / 1024)} KB; pages can be at most ${PAGE_MAX_BYTES / 1024} KB. Leave out bulky data or inline images, or share a file instead.` };
  return { title, html };
}

export const utf8Bytes = (s: string) => new TextEncoder().encode(s).byteLength;

/** The file name a page is kept under (Files lists it; it downloads as this). */
export function pageFileName(title: string): string {
  return `${title.replace(/[^\p{L}\p{N} ()._-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'page'}.html`;
}
