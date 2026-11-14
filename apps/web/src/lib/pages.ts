// Pages agents make (task.show_page): HTML documents kept as artifacts of kind 'page', shown only inside a
// sandboxed frame in Wren (GET /api/pages/[id]). A page is the agent's output, so it is treated like anything
// else from the web: it runs in an opaque origin (no cookies, no storage, nothing of Wren's), may not reach the
// network except for pinned script and font CDNs, and may not submit forms, open windows or move the page
// around it. Plain module: what goes around the page is tested on its own.

export type PageTheme = 'light' | 'dark';

/** Where a page's scripts and fonts may come from. Nothing else on the network is reachable from a page. */
const SCRIPT_HOSTS = 'https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com';

/**
 * The policy a page runs under. `sandbox allow-scripts` holds even if the page is opened outside the frame:
 * an opaque origin, no forms, popups, top navigation or downloads. connect-src 'none' and the image and media
 * rules mean what the page holds can't be sent anywhere by a fetch, a beacon or an image request.
 */
export const PAGE_CSP = [
  'sandbox allow-scripts',
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${SCRIPT_HOSTS}`,
  `style-src 'unsafe-inline' ${SCRIPT_HOSTS} https://fonts.googleapis.com`,
  `font-src data: ${SCRIPT_HOSTS} https://fonts.gstatic.com`,
  'img-src data: blob:',
  'media-src data: blob:',
  "connect-src 'none'",
  "worker-src blob:",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "frame-ancestors 'self'",
].join('; ');

/** The headers a page is served with. */
export function pageHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': PAGE_CSP,
    'x-content-type-options': 'nosniff',
    // Framed by Wren's own pages only (the site sends DENY everywhere else).
    'x-frame-options': 'SAMEORIGIN',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()',
    'cross-origin-resource-policy': 'same-origin',
    // Never kept by the browser, as for files (W-176).
    'cache-control': 'private, no-store',
  };
}

/** Wren's colours for pages, so a page can match the app (the frame sits on a card's surface). */
export const PAGE_TOKENS: Record<PageTheme, Record<string, string>> = {
  light: { bg: '#ffffff', surface: '#f9f9f8', text: '#141414', muted: '#52524f', border: '#e2e2df', accent: '#141414', success: '#0d7341', warning: '#8f5300', danger: '#c0262d' },
  dark: { bg: '#0c0c0c', surface: '#131313', text: '#f2f2f0', muted: '#a9a9a5', border: '#1f1f1f', accent: '#f2f2f0', success: '#5be39a', warning: '#ffc266', danger: '#ff8a8a' },
};

/**
 * The script a page gets first: it tells the frame around it how tall the page is, so the frame fits it.
 * Only a number goes out, to whoever framed it (Wren checks the message came from its own frame). The page's
 * own box, not the document's scrollHeight, which is never less than the frame and so could only grow.
 */
const HEIGHT_SCRIPT = `(function(){var last=0;function send(){var d=document.documentElement,b=document.body;var h=Math.ceil(Math.max(d.getBoundingClientRect().height,b?b.scrollHeight:0));if(h!==last){last=h;parent.postMessage({wrenPage:'height',height:h},'*')}}try{var ro=new ResizeObserver(send);ro.observe(document.documentElement);document.addEventListener('DOMContentLoaded',function(){if(document.body)ro.observe(document.body);send()})}catch(e){}addEventListener('load',send);send()})();`;

/** What goes at the top of a page's head: its theme, Wren's colours as variables, and the height script. */
export function pageHead(theme: PageTheme): string {
  const t = PAGE_TOKENS[theme];
  const vars = Object.entries(t)
    .map(([k, v]) => `--wren-${k}:${v}`)
    .join(';');
  return (
    `<meta charset="utf-8"><meta name="color-scheme" content="${theme}"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    // First in the head, so the page's own styles override these.
    `<style>:root{${vars};color-scheme:${theme}}body{margin:0;background:var(--wren-bg);color:var(--wren-text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}</style>` +
    `<script>${HEIGHT_SCRIPT}</script>`
  );
}

/** The page as served: what Wren adds goes first in its head, wherever the document starts one. */
export function pageDocument(html: string, theme: PageTheme): string {
  const head = pageHead(theme);
  const at = (re: RegExp) => {
    const m = re.exec(html);
    return m ? m.index + m[0].length : -1;
  };
  const inHead = at(/<head\b[^>]*>/i);
  if (inHead >= 0) return html.slice(0, inHead) + head + html.slice(inHead);
  const inHtml = at(/<html\b[^>]*>/i);
  if (inHtml >= 0) return `${html.slice(0, inHtml)}<head>${head}</head>${html.slice(inHtml)}`;
  const afterDoctype = at(/^\s*<!doctype[^>]*>/i);
  if (afterDoctype >= 0) return `${html.slice(0, afterDoctype)}<head>${head}</head>${html.slice(afterDoctype)}`;
  return `<!doctype html><head>${head}</head>${html}`;
}

/**
 * Whether a request for a page is Wren framing it: a frame (not a tab, where a page made to look like Wren
 * would sit on Wren's own address) asked for by a page of this same site. Browsers too old to say are refused.
 */
export function framedByWren(headers: Headers): boolean {
  return headers.get('sec-fetch-dest') === 'iframe' && headers.get('sec-fetch-site') === 'same-origin';
}
