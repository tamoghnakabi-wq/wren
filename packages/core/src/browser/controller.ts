// Browser controller shared by the cloud sandbox daemon and the desktop app.
//
// Self-contained on purpose (no relative imports, erasable TypeScript only):
// the cloud runner writes this file into the agent's sandbox and runs it with
// Node's built-in type stripping, while the desktop app bundles it normally.

import type { BrowserContext, Page } from 'playwright-core';

export interface BrowserAction {
  action: 'navigate' | 'snapshot' | 'click' | 'type' | 'press' | 'scroll' | 'screenshot' | 'back' | 'describe' | 'close';
  url?: string;
  ref?: string;
  text?: string;
  submit?: boolean;
  key?: string;
  direction?: 'up' | 'down';
  amount?: number;
  full_page?: boolean;
}

export interface BrowserResponse {
  ok: boolean;
  error?: string;
  title?: string;
  url?: string;
  snapshot?: string;
  /** JPEG base64 the model asked to look at (screenshot action). */
  image?: string;
  /** Small JPEG base64 for the live view. */
  preview?: string;
  target?: { label: string; role: string; inputType?: string; autocomplete?: string; href?: string };
}

// Runs inside the page. Walks the DOM in order, tags interactive elements with
// data-wren-ref and returns a compact text rendering.
const SNAPSHOT_FN = `(() => {
  const MAX = 24000, MAX_REFS = 450;
  let n = 0, out = [], len = 0, seenText = new Set();
  const push = (s) => { if (len > MAX) return; out.push(s); len += s.length + 1; };
  document.querySelectorAll('[data-wren-ref]').forEach(e => e.removeAttribute('data-wren-ref'));
  const visible = (el) => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    if (el.getAttribute('aria-hidden') === 'true') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const name = (el) => {
    const a = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '';
    if (a) return a.trim();
    const lb = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (lb) return lb.innerText.trim();
    const pl = el.getAttribute('placeholder'); if (pl) return pl.trim();
    const t = (el.innerText || el.value || '').trim();
    return t.replace(/\\s+/g, ' ').slice(0, 100);
  };
  const role = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'select';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (['button','submit','reset','image'].includes(t)) return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      return 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'clickable';
  };
  const interactive = (el) => {
    const tag = el.tagName.toLowerCase();
    if (['a','button','select','textarea','summary'].includes(tag)) return tag !== 'a' || el.hasAttribute('href');
    if (tag === 'input') return (el.getAttribute('type') || '').toLowerCase() !== 'hidden';
    const r = el.getAttribute('role');
    if (r && ['button','link','checkbox','radio','tab','menuitem','option','switch','textbox','combobox','searchbox'].includes(r)) return true;
    if (el.isContentEditable && el.getAttribute('contenteditable') !== 'false') return true;
    return el.hasAttribute('onclick');
  };
  const BLOCK = /^(P|LI|TD|TH|DT|DD|BLOCKQUOTE|PRE|FIGCAPTION|LABEL|SPAN|DIV|SECTION|ARTICLE)$/;
  const walk = (el, depth) => {
    if (len > MAX || depth > 60) return;
    if (!(el instanceof HTMLElement)) return;
    const tag = el.tagName;
    if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','SVG','HEAD'].includes(tag)) return;
    if (!visible(el)) return;
    if (/^H[1-6]$/.test(tag)) { const t = el.innerText.trim().replace(/\\s+/g,' '); if (t) push('#'.repeat(Number(tag[1])) + ' ' + t.slice(0, 200)); }
    if (interactive(el) && n < MAX_REFS) {
      const ref = 'e' + (++n);
      el.setAttribute('data-wren-ref', ref);
      const r = role(el);
      let line = '[' + ref + '] ' + r + ' "' + name(el) + '"';
      if (el.tagName === 'A') { const h = el.getAttribute('href') || ''; if (h && !h.startsWith('javascript')) line += ' -> ' + h.slice(0, 120); }
      if (r === 'textbox') { const t = el.getAttribute('type'); if (t && t !== 'text') line += ' type=' + t; if (el.value) line += ' value="' + String(el.value).slice(0, 80) + '"'; }
      if (r === 'checkbox' || r === 'radio') line += el.checked ? ' (checked)' : ' (unchecked)';
      if (r === 'select') line += ' value="' + (el.value || '') + '" options: ' + Array.from(el.options).slice(0, 15).map(o => o.text.trim()).join(' | ');
      if (el.disabled) line += ' (disabled)';
      push(line);
      if (['A','BUTTON','SELECT','TEXTAREA','INPUT'].includes(tag)) return;
    }
    if (BLOCK.test(tag) || tag === 'TR') {
      const direct = Array.from(el.childNodes).filter(c => c.nodeType === 3).map(c => c.textContent).join(' ').replace(/\\s+/g, ' ').trim();
      if (direct.length > 1 && !seenText.has(direct)) { seenText.add(direct); push(direct.slice(0, 600)); }
    }
    for (const c of el.children) walk(c, depth + 1);
  };
  walk(document.body, 0);
  if (len > MAX) out.push('[snapshot truncated - scroll or use a screenshot]');
  return out.join('\\n');
})()`;

const DESCRIBE_FN = `(ref) => {
  const el = document.querySelector('[data-wren-ref="' + ref + '"]');
  if (!el) return null;
  const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
  const form = el.closest('form');
  const submitText = form ? Array.from(form.querySelectorAll('button,[type=submit]')).map(b => (b.innerText || b.value || '').trim()).join(' / ').slice(0, 120) : '';
  return { label: label + (submitText && el.tagName !== 'BUTTON' ? ' (form: ' + submitText + ')' : ''), role: el.getAttribute('role') || el.tagName.toLowerCase(), inputType: el.getAttribute('type') || undefined, autocomplete: el.getAttribute('autocomplete') || undefined, href: el.getAttribute('href') || undefined };
}`;

export class BrowserController {
  private page: Page | null = null;
  private readonly context: BrowserContext;

  constructor(context: BrowserContext) {
    this.context = context;
    context.on('page', (p) => {
      this.page = p;
    });
  }

  private async current(): Promise<Page> {
    const pages = this.context.pages().filter((p) => !p.isClosed());
    if (this.page && !this.page.isClosed()) return this.page;
    this.page = pages[pages.length - 1] ?? (await this.context.newPage());
    return this.page;
  }

  private async settle(page: Page, ms = 1500) {
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
  }

  private async state(page: Page, withSnapshot = true): Promise<BrowserResponse> {
    const [title, snapshot, preview] = await Promise.all([
      page.title().catch(() => ''),
      withSnapshot ? (page.evaluate(SNAPSHOT_FN) as Promise<string>).catch((e: Error) => `[could not read the page: ${e.message}]`) : Promise.resolve(undefined),
      page.screenshot({ type: 'jpeg', quality: 45, scale: 'css' }).then((b) => b.toString('base64')).catch(() => undefined),
    ]);
    return { ok: true, title, url: page.url(), snapshot: snapshot ? `Title: ${title}\nURL: ${page.url()}\n\n${snapshot}` : undefined, preview };
  }

  private async locator(page: Page, ref?: string) {
    if (!ref || !/^e\d+$/.test(ref)) throw new Error('Unknown element ref. Take a snapshot and use a ref like e12.');
    const loc = page.locator(`[data-wren-ref="${ref}"]`).first();
    if ((await loc.count()) === 0) throw new Error(`Element ${ref} is not on the page any more. Take a new snapshot and use a current ref.`);
    return loc;
  }

  async act(a: BrowserAction): Promise<BrowserResponse> {
    try {
      const page = await this.current();
      switch (a.action) {
        case 'navigate': {
          if (!a.url || !/^https?:\/\//i.test(a.url)) throw new Error('A full http(s) URL is required.');
          await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await this.settle(page, 3000);
          return this.state(page);
        }
        case 'snapshot':
          return this.state(page);
        case 'click': {
          const loc = await this.locator(page, a.ref);
          await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await loc.click({ timeout: 8000 });
          await this.settle(page);
          return this.state(await this.current());
        }
        case 'type': {
          const loc = await this.locator(page, a.ref);
          const editable = await loc.evaluate((el) => (el as HTMLElement).isContentEditable).catch(() => false);
          if (editable) {
            await loc.click({ timeout: 5000 });
            await page.keyboard.type(a.text ?? '', { delay: 10 });
          } else {
            await loc.fill(a.text ?? '', { timeout: 8000 });
          }
          if (a.submit) {
            await loc.press('Enter');
            await this.settle(page, 3000);
          }
          return this.state(await this.current());
        }
        case 'press':
          await page.keyboard.press(a.key || 'Enter');
          await this.settle(page);
          return this.state(await this.current());
        case 'scroll': {
          const amount = Math.max(1, Math.min(10, a.amount ?? 1));
          await page.evaluate(([dir, amt]) => window.scrollBy(0, (dir === 'up' ? -1 : 1) * window.innerHeight * 0.85 * (amt as number)), [a.direction ?? 'down', amount] as const);
          await page.waitForTimeout(400);
          return this.state(page);
        }
        case 'screenshot': {
          const buf = await page.screenshot({ type: 'jpeg', quality: 70, fullPage: !!a.full_page, scale: 'css' });
          const s = await this.state(page, false);
          return { ...s, image: buf.toString('base64') };
        }
        case 'back':
          await page.goBack({ timeout: 15000 }).catch(() => {});
          await this.settle(page);
          return this.state(page);
        case 'describe': {
          const target = (await page.evaluate(`(${DESCRIBE_FN})(${JSON.stringify(a.ref ?? '')})`)) as BrowserResponse['target'] | null;
          return { ok: true, target: target ?? undefined };
        }
        case 'close':
          await this.context.close();
          return { ok: true };
      }
      return { ok: false, error: `Unknown action ${(a as { action: string }).action}` };
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0];
      let extra: BrowserResponse = { ok: false };
      try {
        extra = await this.state(await this.current());
      } catch {
        /* ignore */
      }
      return { ...extra, ok: false, error: msg };
    }
  }
}
