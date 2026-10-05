// Browser controller shared by the cloud sandbox daemon and the desktop app.
//
// Self-contained on purpose (no relative imports, erasable TypeScript only):
// the cloud runner writes this file into the agent's sandbox and runs it with
// Node's built-in type stripping, while the desktop app bundles it normally.

import type { BrowserContext, Locator, Page, Selectors } from 'playwright-core';

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
/** The selector engine below is registered under this name (see registerSelectors). */
const ENGINE_NAME = 'wren';

// Walks the DOM in order, tags interactive elements with data-wren-ref and returns a compact text
// rendering. Runs as part of ENGINE, in the isolated world, so a page's scripts can't fake it.
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

// What an element is and where using it leads (a method of ENGINE, so it runs in the isolated world).
const DESCRIBE_FN = `(el) => {
  if (el === document.documentElement) return { label: '', role: 'page', url: location.href };
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

/**
 * Everything that decides *which node* an action reaches runs here, in Playwright's isolated world
 * (a selector engine registered with contentScript: true). The page's scripts share the DOM but
 * not this JavaScript: they can't see these ids, replace the methods used to compare nodes, or
 * fake what an element says the way they can inside page.evaluate (whose helpers, even eval, a page
 * may replace). Each request is a selector `op args…`; answers come back as a detached element
 * carrying JSON in data-wren, which the page never sees either.
 *
 * - `snapshot`: the page as text, tagging interactive elements with refs (data-wren-ref).
 * - `describe <ref|@focused> <newId>`: describe the node and give it an id (the same id every time).
 * - `id <id>`: the node itself, for Playwright to click (it hit-tests in this world too).
 * - `about <id>`: that node's description now, whether it is connected and whether it has focus.
 * - `type <id> <nonce> <text>`: focus it, make sure focus stayed, replace its text. Text goes to that
 *   node through the editing command, even if a handler moves focus while it is inserted.
 * - `arm <id>` / `disarm`: hold focus on the node until a key press reaches it, and stop key events
 *   aimed anywhere else in the page.
 */
const ENGINE = `({
  ids: new Map(), of: new WeakMap(), done: new Map(), guard: null,
  describe: ${DESCRIBE_FN},
  snapshot() { return ${SNAPSHOT_FN}; },
  // The focused element, through shadow roots; the root element stands for "the page" when nothing has focus.
  focused() {
    let a = document.activeElement;
    while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement;
    return a && a !== document.body ? a : document.documentElement;
  },
  node(id) { const n = this.ids.get(id); return n && n.isConnected ? n : null; },
  name(el, fresh) {
    let id = this.of.get(el);
    if (id && this.ids.get(id) !== el) id = undefined;
    if (!id) { id = fresh; this.of.set(el, id); }
    this.ids.delete(id); this.ids.set(id, el);
    if (this.ids.size > 500) this.ids.delete(this.ids.keys().next().value);
    return id;
  },
  out(v) { const d = document.createElement('wren-data'); d.setAttribute('data-wren', JSON.stringify(v)); return d; },
  type(el, text) {
    if (!el) return { error: 'gone' };
    const input = el.tagName === 'INPUT', area = el.tagName === 'TEXTAREA', kind = input ? el.type : '';
    const SET = ['color', 'date', 'time', 'datetime-local', 'month', 'range', 'week'];
    if (kind === 'password') return { error: 'secret' };
    if (!(input && (SET.includes(kind) || ['text', 'email', 'number', 'search', 'tel', 'url'].includes(kind)) || area || el.isContentEditable)) return { error: 'field' };
    if (el.disabled || el.readOnly) return { error: 'disabled' };
    el.focus();
    if (this.focused() !== el) return { error: 'focus' };
    if (SET.includes(kind)) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, text.trim());
      el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }
    if (input || area) el.select();
    else { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
    return document.execCommand(text ? 'insertText' : 'delete', false, text) ? { ok: true } : { error: 'rejected' };
  },
  arm(el) {
    this.disarm();
    if (!el || this.focused() !== el) return { error: 'focus' };
    const page = el === document.documentElement;
    const g = { delivered: false, blocked: false, fixes: 0 };
    // Something moved focus before the key arrived: put it back (after the mover's script ends).
    const keep = () => {
      if (g.delivered || g.fixes > 20) return;
      queueMicrotask(() => {
        if (this.guard !== g || g.delivered || this.focused() === el) return;
        g.fixes++;
        if (page) { const f = document.activeElement; if (f && f.blur) f.blur(); } else el.focus();
      });
    };
    const key = (e) => {
      if (g.delivered) return;
      const t = e.composedPath()[0];
      if (t === el || (page && (t === document.body || t === document.documentElement || t === document))) { g.delivered = true; return; }
      e.preventDefault(); e.stopImmediatePropagation(); g.blocked = true;
    };
    const kinds = ['keydown', 'keypress', 'keyup'];
    document.addEventListener('focusin', keep, true); document.addEventListener('focusout', keep, true);
    for (const k of kinds) window.addEventListener(k, key, true);
    g.off = () => {
      document.removeEventListener('focusin', keep, true); document.removeEventListener('focusout', keep, true);
      for (const k of kinds) window.removeEventListener(k, key, true);
    };
    this.guard = g;
    return { ok: true };
  },
  disarm() {
    const g = this.guard;
    if (!g) return { none: true };
    g.off(); this.guard = null;
    return { delivered: g.delivered, blocked: g.blocked };
  },
  query(root, sel) {
    const [op, a, b, c] = sel.split(' ');
    if (op === 'id') return this.node(a);
    if (op === 'snapshot') return this.out({ text: this.snapshot() });
    if (op === 'describe') {
      const el = a === '@focused' ? this.focused() : /^e\\d+$/.test(a) ? document.querySelector('[data-wren-ref="' + a + '"]') : null;
      return this.out(el ? { ...this.describe(el), elementId: this.name(el, b) } : { missing: true });
    }
    if (op === 'about') {
      const el = this.node(a);
      return this.out(el ? { ...this.describe(el), elementId: a, focused: this.focused() === el } : { missing: true });
    }
    if (op === 'type') {
      if (!this.done.has(b)) { this.done.set(b, this.type(this.node(a), decodeURIComponent(c || ''))); if (this.done.size > 50) this.done.delete(this.done.keys().next().value); }
      return this.out(this.done.get(b));
    }
    if (op === 'arm') return this.out(this.arm(this.node(a)));
    if (op === 'disarm') return this.out(this.disarm());
    return null;
  },
  queryAll(root, sel) { const e = this.query(root, sel); return e ? [e] : []; },
})`;

/** What the engine says about a node. */
type About = Target & { missing?: boolean; focused?: boolean };

/** Register the isolated-world engine. Call once per Playwright instance, before launching the browser. */
export async function registerSelectors(selectors: Selectors): Promise<void> {
  try {
    await selectors.register(ENGINE_NAME, ENGINE, { contentScript: true });
  } catch (e) {
    if (!/already registered/i.test((e as Error).message)) throw e;
  }
}

export class BrowserController {
  private page: Page | null = null;
  /**
   * The pages each task owns (see BrowserAction.tab): its tab and every popup opened from it or
   * from those popups. `current` is where the task's actions go: the newest of them.
   */
  private readonly tabs = new Map<string, { pages: Set<Page>; current: Page }>();
  /** Popups whose opener is still being looked up; closing a task waits for them. */
  private readonly opening = new Set<Promise<void>>();
  private readonly context: BrowserContext;

  constructor(context: BrowserContext) {
    this.context = context;
    context.on('page', (p) => {
      const settled = p.opener().then((op) => {
        for (const t of this.tabs.values()) {
          if (op && t.pages.has(op)) {
            t.pages.add(p);
            t.current = p;
            return;
          }
        }
        if (![...this.tabs.values()].some((t) => t.pages.has(p))) this.page = p;
      }, () => {});
      this.opening.add(settled);
      void settled.finally(() => this.opening.delete(settled));
    });
  }

  private async current(tab?: string): Promise<Page> {
    if (tab) {
      const own = this.tabs.get(tab);
      if (own && !own.current.isClosed()) return own.current;
      // The newest page of the task that is still open; else a new tab. The first tab of a fresh
      // browser is reused rather than left blank beside a new one.
      const open = own && [...own.pages].filter((p) => !p.isClosed()).pop();
      if (own && open) return (own.current = open);
      const owned = (p: Page) => [...this.tabs.values()].some((t) => t.pages.has(p));
      const blank = this.context.pages().find((p) => !p.isClosed() && p.url() === 'about:blank' && !owned(p));
      const page = blank ?? (await this.context.newPage());
      if (own) {
        own.pages.add(page);
        own.current = page;
      } else this.tabs.set(tab, { pages: new Set([page]), current: page });
      return page;
    }
    const pages = this.context.pages().filter((p) => !p.isClosed());
    if (this.page && !this.page.isClosed()) return this.page;
    this.page = pages[pages.length - 1] ?? (await this.context.newPage());
    return this.page;
  }

  /** Close every page a task owns. False (and the task's pages kept on record) if any stays open. */
  private async closeTab(tab: string): Promise<boolean> {
    await Promise.all([...this.opening]);
    const own = this.tabs.get(tab);
    if (!own) return true;
    for (const p of own.pages) if (!p.isClosed()) await p.close({ runBeforeUnload: false }).catch(() => {});
    for (const p of [...own.pages]) if (p.isClosed()) own.pages.delete(p);
    if (own.pages.size) return false;
    this.tabs.delete(tab);
    return true;
  }

  private async settle(page: Page, ms = 1500) {
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
  }

  private async state(page: Page, withSnapshot = true): Promise<BrowserResponse> {
    const [title, snapshot, preview] = await Promise.all([
      page.title().catch(() => ''),
      withSnapshot ? this.ask<{ text: string }>(page, 'snapshot').then((r) => r.text, (e: Error) => `[could not read the page: ${e.message.split('\n')[0]}]`) : Promise.resolve(undefined),
      page.screenshot({ type: 'jpeg', quality: 45, scale: 'css' }).then((b) => b.toString('base64')).catch(() => undefined),
    ]);
    return { ok: true, title, url: page.url(), snapshot: snapshot ? `Title: ${title}\nURL: ${page.url()}\n\n${snapshot}` : undefined, preview };
  }

  /** Ask the isolated-world engine (see ENGINE). */
  private async ask<T>(page: Page, ...words: string[]): Promise<T> {
    const v = await page.locator(`${ENGINE_NAME}=${words.join(' ')}`).getAttribute('data-wren', { timeout: 5000 });
    return JSON.parse(v ?? '{}') as T;
  }

  /** The exact node behind an id, for Playwright to act on. */
  private node(page: Page, id: string): Locator {
    return page.locator(`${ENGINE_NAME}=id ${id}`);
  }

  /** Describe the element behind a ref (or the focused one for '@focused') and give it an id. */
  private async describe(page: Page, ref: string): Promise<Target | null> {
    if (ref !== '@focused' && !/^e\d+$/.test(ref)) return null;
    const r = await this.ask<About>(page, 'describe', ref, `el-${globalThis.crypto.randomUUID()}`);
    if (r.missing) return null;
    const { missing: _m, focused: _f, ...target } = r;
    return target;
  }

  /**
   * The element an action reaches. When the action was assessed (or approved) against an exact
   * element, that node is used and must still be in the page and look the same; otherwise the
   * ref's element right now. Either way the action then goes to that node and no other.
   */
  private async target(page: Page, a: BrowserAction): Promise<{ id?: string; target: Target | null; refused?: string }> {
    const changed = 'The page changed since this action was checked, so it was not taken. Take a new snapshot and try again.';
    const e = a.expect;
    if (e?.elementId) {
      const r = await this.ask<About>(page, 'about', e.elementId);
      if (r.missing) return { target: null, refused: 'That element is not on the page any more. Take a new snapshot and try again.' };
      const { missing: _m, focused, ...now } = r;
      // A key goes to whatever has focus: that has to be the element (or page) that was checked.
      if ((a.action === 'press' && !focused) || !same(now, e)) return { target: now, refused: changed };
      return { id: e.elementId, target: now };
    }
    const now = await this.describe(page, a.action === 'press' ? '@focused' : a.ref ?? '');
    if (e && (!now || !same(now, { ...e, elementId: now.elementId, url: e.url ?? now.url }))) return { target: now, refused: changed };
    return { id: now?.elementId, target: now };
  }

  /** Press a key on exactly this node: focus is held on it until the key arrives, and a key aimed elsewhere is stopped. */
  private async pressOn(page: Page, id: string, key: string): Promise<string | null> {
    const armed = await this.ask<{ ok?: boolean }>(page, 'arm', id);
    if (!armed.ok) return 'Focus is no longer on the element that was checked, so the key was not pressed. Take a new snapshot and try again.';
    try {
      await page.keyboard.press(key);
    } finally {
      // After a navigation the guard went with the old page, which is fine: the key arrived.
      const r = await this.ask<{ blocked?: boolean }>(page, 'disarm').catch(() => ({ blocked: false }));
      if (r.blocked) return 'The page moved focus to something else just before the key press, so Wren stopped it. Take a new snapshot and check the page.';
    }
    return null;
  }

  async act(a: BrowserAction): Promise<BrowserResponse> {
    try {
      if (a.action === 'close' && a.tab) {
        return (await this.closeTab(a.tab)) ? { ok: true } : { ok: false, error: 'Some pages this task opened could not be closed.' };
      }
      const page = await this.current(a.tab);
      let id: string | undefined;
      if (a.action === 'click' || a.action === 'type' || a.action === 'press') {
        const t = await this.target(page, a);
        let refused = t.refused;
        if (!refused && !t.id) refused = a.action === 'press' ? 'Wren could not tell what has focus on this page. Take a new snapshot and try again.' : `Element ${a.ref ?? ''} is not on the page any more. Take a new snapshot and use a current ref.`;
        if (!refused && a.action === 'type' && t.target && SECRET_FIELD.test(`${t.target.inputType ?? ''} ${t.target.autocomplete ?? ''} ${t.target.label ?? ''}`)) {
          refused = 'Agents never type passwords, card numbers or other credentials. Ask the user to do this step.';
        }
        if (refused) return { ...(await this.state(page)), ok: false, error: refused };
        id = t.id;
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
          // Through the engine's node, the click can only land on that node (Playwright checks
          // what is under the pointer), however the page rearranges itself meanwhile.
          const loc = this.node(page, id!);
          await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await loc.click({ timeout: 8000 });
          await this.settle(page);
          return this.state(await this.current(a.tab));
        }
        case 'type': {
          const r = await this.ask<{ ok?: boolean; error?: string }>(page, 'type', id!, globalThis.crypto.randomUUID(), encodeURIComponent(a.text ?? ''));
          if (!r.ok) return { ...(await this.state(page)), ok: false, error: TYPE_ERRORS[r.error ?? ''] ?? 'Wren could not type into that element.' };
          if (a.submit) {
            const refused = await this.pressOn(page, id!, 'Enter');
            if (refused) return { ...(await this.state(page)), ok: false, error: refused };
            await this.settle(page, 3000);
          }
          return this.state(await this.current(a.tab));
        }
        case 'press': {
          const refused = await this.pressOn(page, id!, a.key || 'Enter');
          if (refused) return { ...(await this.state(page)), ok: false, error: refused };
          await this.settle(page);
          return this.state(await this.current(a.tab));
        }
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

const TYPE_ERRORS: Record<string, string> = {
  gone: 'That element is not on the page any more. Take a new snapshot and try again.',
  secret: 'Agents never type passwords, card numbers or other credentials. Ask the user to do this step.',
  field: 'That element is not a text field. Click it first, or pick the field itself.',
  disabled: 'That field is disabled or read-only.',
  focus: 'Focus moved to something else when Wren selected that field, so nothing was typed. Take a new snapshot and check the page.',
  rejected: 'The page did not accept the text.',
};
