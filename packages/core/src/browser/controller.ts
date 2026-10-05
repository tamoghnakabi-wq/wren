// Browser controller shared by the cloud sandbox daemon and the desktop app.
//
// Self-contained on purpose (no relative imports, erasable TypeScript only):
// the cloud runner writes this file into the agent's sandbox and runs it with
// Node's built-in type stripping, while the desktop app bundles it normally.

import type { BrowserContext, ElementHandle, Page } from 'playwright-core';

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
  /** The element this action was assessed/approved against; refused if it changed. */
  expect?: { label?: string; role?: string; inputType?: string; elementId?: string; url?: string; href?: string; form?: string };
  /** The task this action belongs to: each task gets its own tab, so tasks can't move each other's page. */
  tab?: string;
}

/** Field kinds an agent may never type into, enforced here as well as in the policy. */
const SECRET_FIELD = /password|cc-|card|cvc|cvv|security code|one-time|otp|2fa|passcode|ssn|social security|iban|routing/i;

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
  target?: { label: string; role: string; inputType?: string; autocomplete?: string; href?: string; form?: string; elementId?: string; url?: string };
}

type Target = NonNullable<BrowserResponse['target']>;
/** What has to be unchanged between assessing (or approving) an action and taking it. */
const TARGET_KEYS = ['label', 'role', 'inputType', 'elementId', 'url', 'href', 'form'] as const;
/** Element handles kept per tab; older ones are let go (an approval on them is then refused). */
const MAX_HELD = 200;

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
  const SECRET = /password|passwd|passcode|(^|[^a-z])(pin|otp|totp|mfa|2fa|ssn|cvc|cvv|csc|iban)([^a-z]|$)|cc-|card.?(number|num|no)|security.?code|one-time|social.?security|routing|account.?number|secret|access.?token|api.?key/i;
  const sensitive = (el) => {
    const t = (el.getAttribute('type') || '').toLowerCase();
    if (t === 'password') return true;
    const hints = [el.getAttribute('autocomplete'), el.getAttribute('name'), el.id, el.getAttribute('aria-label'), el.getAttribute('placeholder')].join(' ');
    return SECRET.test(hints);
  };
  const name = (el) => {
    const a = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt') || '';
    if (a) return a.trim();
    const lb = el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
    if (lb) return lb.innerText.trim();
    const pl = el.getAttribute('placeholder'); if (pl) return pl.trim();
    const t = (el.innerText || (sensitive(el) ? '' : el.value) || '').trim();
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
      if (r === 'textbox') { const t = el.getAttribute('type'); if (t && t !== 'text') line += ' type=' + t; if (el.value) line += sensitive(el) ? ' value=(hidden, filled in)' : ' value="' + String(el.value).slice(0, 80) + '"'; }
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

// The node an action would reach: a snapshot ref, or (for a key press) whatever has focus,
// with the document itself standing for "the page" when nothing does.
const FIND_FN = `(ref) => ref === '@focused'
  ? (document.activeElement && document.activeElement !== document.body ? document.activeElement : document)
  : document.querySelector('[data-wren-ref="' + ref + '"]')`;

// What an element is and where using it leads. Runs in the page with the element passed in.
const DESCRIBE_FN = `(el) => {
  if (el === document) return { label: '', role: 'page', url: location.href };
  const t = (el.getAttribute('type') || '').toLowerCase();
  const hidden = t === 'password' || /password|passcode|cc-|card.?(number|num|no)|(^|[^a-z])(cvc|cvv|otp|pin)([^a-z]|$)|one-time|secret|token/i.test([el.getAttribute('autocomplete'), el.getAttribute('name'), el.id].join(' '));
  const label = (el.getAttribute('aria-label') || el.innerText || (hidden ? '' : el.value) || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
  const form = el.closest('form');
  const submitText = form ? Array.from(form.querySelectorAll('button,[type=submit]')).map(b => (b.innerText || b.value || '').trim()).join(' / ').slice(0, 120) : '';
  // Where submitting goes: a submit button's own formaction/formmethod win over the form's.
  const owner = el.form || form;
  const attr = (n) => (owner && owner.getAttribute(n)) || '';
  const action = owner ? new URL((el.getAttribute('formaction') || attr('action') || location.href), location.href).href : '';
  const method = owner ? (el.getAttribute('formmethod') || attr('method') || 'get').toUpperCase() : '';
  const link = el.closest('a[href],area[href]');
  const href = link ? new URL(link.getAttribute('href'), location.href).href : el.getAttribute('href') || undefined;
  return { label: label + (submitText && el.tagName !== 'BUTTON' ? ' (form: ' + submitText + ')' : ''), role: el.getAttribute('role') || el.tagName.toLowerCase(), inputType: el.getAttribute('type') || undefined, autocomplete: el.getAttribute('autocomplete') || undefined, href, form: owner ? method + ' ' + action : undefined, url: location.href };
}`;

export class BrowserController {
  private page: Page | null = null;
  /** One tab per task (see BrowserAction.tab). */
  private readonly tabs = new Map<string, Page>();
  private readonly context: BrowserContext;
  /**
   * Elements that were described, by a random id the page never sees. The id is what an
   * approval names, and the action is then dispatched to that very node through its handle:
   * a page can't forge it, and a look-alike put in the node's place doesn't match.
   */
  private readonly held = new Map<string, { handle: ElementHandle<Node>; page: Page }>();

  constructor(context: BrowserContext) {
    this.context = context;
    context.on('page', (p) => {
      // A popup opened from a task's tab becomes that task's tab.
      void p.opener().then((op) => {
        for (const [tab, page] of this.tabs) if (op && page === op) return void this.tabs.set(tab, p);
        if (![...this.tabs.values()].includes(p)) this.page = p;
      });
    });
  }

  private async current(tab?: string): Promise<Page> {
    if (tab) {
      const own = this.tabs.get(tab);
      if (own && !own.isClosed()) return own;
      // The first tab of a fresh browser is reused rather than left blank beside a new one.
      const blank = this.context.pages().find((p) => !p.isClosed() && p.url() === 'about:blank' && ![...this.tabs.values()].includes(p));
      const page = blank ?? (await this.context.newPage());
      this.tabs.set(tab, page);
      return page;
    }
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

  /** The element to act on when no exact node was named (see target()). */
  private async locator(page: Page, ref?: string) {
    if (!ref || !/^e\d+$/.test(ref)) throw new Error('Unknown element ref. Take a snapshot and use a ref like e12.');
    const loc = page.locator(`[data-wren-ref="${ref}"]`).first();
    if ((await loc.count()) === 0) throw new Error(`Element ${ref} is not on the page any more. Take a new snapshot and use a current ref.`);
    return loc;
  }

  /** The id for this node: the one it was given before, or a new one. Takes ownership of `handle`. */
  private async remember(page: Page, handle: ElementHandle<Node>): Promise<string> {
    let mine = [...this.held].filter(([, h]) => h.page === page);
    const find = () => page.evaluate(([el, ...known]) => known.indexOf(el), [handle, ...mine.map(([, h]) => h.handle)]);
    let i = mine.length ? await find().catch(() => null) : -1;
    if (i === null) {
      // Some kept handles belong to a document that is gone: let them go and look again.
      const alive = await Promise.all(mine.map(([, h]) => h.handle.evaluate(() => true).catch(() => false)));
      mine.forEach(([id, h], k) => {
        if (!alive[k]) this.forget(id, h.handle);
      });
      mine = mine.filter((_, k) => alive[k]);
      i = mine.length ? await find() : -1;
    }
    if (i >= 0) {
      const [id, h] = mine[i];
      void handle.dispose().catch(() => {});
      this.held.delete(id);
      this.held.set(id, h); // most recently used last
      return id;
    }
    const id = `el-${globalThis.crypto.randomUUID()}`;
    this.held.set(id, { handle, page });
    if (mine.length + 1 > MAX_HELD) {
      const [oldId, old] = mine[0];
      this.forget(oldId, old.handle);
    }
    return id;
  }

  private forget(id: string, handle: ElementHandle<Node>) {
    this.held.delete(id);
    void handle.dispose().catch(() => {});
  }

  private forgetPage(page: Page) {
    for (const [id, h] of this.held) if (h.page === page) this.forget(id, h.handle);
  }

  /** Describe the element behind a ref (or the focused one for '@focused') and give it an id. */
  private async describe(page: Page, ref: string): Promise<Target | null> {
    if (ref !== '@focused' && !/^e\d+$/.test(ref)) return null;
    const found = await page.evaluateHandle(`(${FIND_FN})(${JSON.stringify(ref)})`);
    const handle = found.asElement() as ElementHandle<Node> | null;
    if (!handle) {
      await found.dispose().catch(() => {});
      return null;
    }
    const target = await describeElement(page, handle);
    return { ...target, elementId: await this.remember(page, handle) };
  }

  /** A described element, by its id, if it is still in this tab's page; else null. */
  private async heldElement(page: Page, id: string): Promise<ElementHandle<Node> | null> {
    const h = this.held.get(id);
    if (!h || h.page !== page) return null;
    const connected = await h.handle.evaluate((n) => n === document || n.isConnected).catch(() => false);
    return connected ? h.handle : null;
  }

  /**
   * The element an action reaches. When the action was assessed (or approved) against an exact
   * element, that node is used and must still be in the page and look the same; otherwise the ref.
   */
  private async target(page: Page, a: BrowserAction): Promise<{ handle?: ElementHandle<Node>; target: Target | null; refused?: string }> {
    const changed = 'The page changed since this action was checked, so it was not taken. Take a new snapshot and try again.';
    const e = a.expect;
    if (e?.elementId) {
      if (a.action === 'press') {
        // A key goes to whatever has focus: that has to be the element (or page) that was checked.
        const now = await this.describe(page, '@focused');
        if (!now || now.elementId !== e.elementId || !same(now, e)) return { target: now, refused: changed };
        return { target: now };
      }
      const handle = await this.heldElement(page, e.elementId);
      if (!handle) return { target: null, refused: 'That element is not on the page any more. Take a new snapshot and try again.' };
      const now = { ...(await describeElement(page, handle)), elementId: e.elementId };
      if (!same(now, e)) return { target: now, refused: changed };
      return { handle, target: now };
    }
    const now = await this.describe(page, a.action === 'press' ? '@focused' : a.ref ?? '');
    if (e && (!now || !same(now, { ...e, elementId: now.elementId, url: e.url ?? now.url }))) return { target: now, refused: changed };
    return { target: now };
  }

  async act(a: BrowserAction): Promise<BrowserResponse> {
    try {
      if (a.action === 'close' && a.tab) {
        const own = this.tabs.get(a.tab);
        this.tabs.delete(a.tab);
        if (own) this.forgetPage(own);
        if (own && !own.isClosed()) await own.close().catch(() => {});
        return { ok: true };
      }
      const page = await this.current(a.tab);
      let exact: ElementHandle<Node> | undefined;
      if (a.action === 'click' || a.action === 'type' || a.action === 'press') {
        const t = await this.target(page, a);
        let refused = t.refused;
        if (!refused && a.action === 'type' && t.target && SECRET_FIELD.test(`${t.target.inputType ?? ''} ${t.target.autocomplete ?? ''} ${t.target.label ?? ''}`)) {
          refused = 'Agents never type passwords, card numbers or other credentials. Ask the user to do this step.';
        }
        if (refused) return { ...(await this.state(page)), ok: false, error: refused };
        exact = t.handle;
      }
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
          // Through the handle, the click can only land on that node (Playwright checks what is
          // under the pointer), however the page rearranges itself meanwhile.
          const loc = exact ?? (await this.locator(page, a.ref));
          await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await loc.click({ timeout: 8000 });
          await this.settle(page);
          return this.state(await this.current(a.tab));
        }
        case 'type': {
          const loc = exact ?? (await this.locator(page, a.ref));
          const isEditable = (el: Node) => (el as HTMLElement).isContentEditable;
          const editable = await (exact ? exact.evaluate(isEditable) : (loc as Exclude<typeof loc, ElementHandle<Node>>).evaluate(isEditable)).catch(() => false);
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
          return this.state(await this.current(a.tab));
        }
        case 'press':
          await page.keyboard.press(a.key || 'Enter');
          await this.settle(page);
          return this.state(await this.current(a.tab));
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
          const target = await this.describe(page, a.ref ?? '');
          return { ok: true, target: target ?? undefined };
        }
        case 'close':
          for (const [id, h] of this.held) this.forget(id, h.handle);
          await this.context.close();
          return { ok: true };
      }
      return { ok: false, error: `Unknown action ${(a as { action: string }).action}` };
    } catch (e) {
      const msg = (e as Error).message.split('\n')[0];
      let extra: BrowserResponse = { ok: false };
      try {
        extra = await this.state(await this.current(a.tab));
      } catch {
        /* ignore */
      }
      return { ...extra, ok: false, error: msg };
    }
  }
}

/** Same element as checked: every field the check saw is unchanged (fields it didn't have are skipped only for elementId/url). */
function same(now: Target, e: NonNullable<BrowserAction['expect']>): boolean {
  return TARGET_KEYS.every((k) => ((k === 'elementId' || k === 'url') && !e[k] ? true : (now[k] ?? '') === (e[k] ?? '')));
}

/** Runs DESCRIBE_FN on one element (a string function can't take a handle directly, so it is fetched first). */
async function describeElement(page: Page, el: ElementHandle<Node>): Promise<Target> {
  const fn = await page.evaluateHandle(`(${DESCRIBE_FN})`);
  try {
    return (await fn.evaluate((f, node) => (f as unknown as (n: Node) => Target)(node), el)) as Target;
  } finally {
    void fn.dispose().catch(() => {});
  }
}
