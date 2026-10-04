// HTML -> readable text, good enough for an agent to read articles and docs.

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string, baseUrl?: string): { title: string; text: string } {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').trim()).replace(/\s+/g, ' ');
  let s = html;
  const main = s.match(/<(main|article)[^>]*>([\s\S]*?)<\/\1>/i);
  if (main && main[2].length > 500) s = main[2];
  s = s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const label = inner.replace(/<[^>]+>/g, '').trim();
    if (!label) return '';
    let url = href;
    try {
      if (baseUrl) url = new URL(href, baseUrl).toString();
    } catch {
      /* keep */
    }
    return /^javascript:/i.test(url) ? label : `[${label}](${url})`;
  });
  s = s
    .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => '\n\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|tr|table|ul|ol|blockquote|pre|header)>/gi, '\n\n')
    .replace(/<(td|th)[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, '');
  s = decodeEntities(s)
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text: s };
}
