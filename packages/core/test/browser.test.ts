import { beforeAll, describe, expect, it } from 'vitest';
import { BrowserController, registerSelectors } from '../src/browser/controller';

// Drives a real Chrome (set WREN_BROWSER_TEST=1; needs Google Chrome installed).
describe.skipIf(!process.env.WREN_BROWSER_TEST)('browser controller', () => {
  beforeAll(async () => registerSelectors((await import('playwright-core')).selectors));
  it('never reveals sensitive field values, and describes the focused element', async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(`
        <form><label for=u>Email</label><input id=u value="me@example.com">
        <input type=password id=p value="hunter2-secret">
        <input name="card-number" value="4242424242424242">
        <input name="search" value="weather melbourne">
        <button id=b>Place order</button></form>`);
      const ctl = new BrowserController(context);
      const snap = (await ctl.act({ action: 'snapshot' })).snapshot ?? '';
      expect(snap).not.toContain('hunter2-secret');
      expect(snap).not.toContain('4242424242424242');
      expect(snap).toContain('value=(hidden, filled in)');
      expect(snap).toContain('weather melbourne');
      await page.focus('#b');
      const focused = await ctl.act({ action: 'describe', ref: '@focused' });
      expect(focused.target?.label).toContain('Place order');
      await page.focus('#p');
      const pw = await ctl.act({ action: 'describe', ref: '@focused' });
      expect(pw.target?.inputType).toBe('password');
      expect(JSON.stringify(pw.target)).not.toContain('hunter2');
      // The browser itself refuses: typing into a password field, and acting on a changed element.
      const snap2 = (await ctl.act({ action: 'snapshot' })).snapshot ?? '';
      const pwRef = /\[(e\d+)\] textbox "[^"]*" type=password/.exec(snap2)?.[1];
      expect((await ctl.act({ action: 'type', ref: pwRef, text: 'x' })).error).toMatch(/never type passwords/);
      const btnRef = /\[(e\d+)\] button "Place order"/.exec(snap2)?.[1];
      const moved = await ctl.act({ action: 'click', ref: btnRef, expect: { label: 'Send message', role: 'button' } });
      expect(moved.ok).toBe(false);
      expect(moved.error).toMatch(/page changed/);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('binds an approved click to the exact element, and keeps tasks in their own tabs', async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const context = await browser.newContext();
      const ctl = new BrowserController(context);
      const html = (who: string) => `data:text/html,<h1>Message to ${who}</h1><button onclick="document.title='sent to ${who}'">Send</button>`;
      // Task A sees Send on Alice's thread and that exact element is assessed.
      await ctl.act({ action: 'navigate', url: 'https://example.com', tab: 'A' }).catch(() => {});
      const pageA = context.pages().find((p) => p.url().startsWith('https://example.com'))!;
      await pageA.goto(html('Alice'));
      const snapA = (await ctl.act({ action: 'snapshot', tab: 'A' })).snapshot ?? '';
      const ref = /\[(e\d+)\] button "Send"/.exec(snapA)![1];
      const assessed = (await ctl.act({ action: 'describe', ref, tab: 'A' })).target!;
      expect(assessed.elementId).toMatch(/^el-[0-9a-f-]{36}$/);
      expect(assessed.url).toContain('Alice');
      // Task B's navigation happens in its own tab and doesn't move task A's page.
      await ctl.act({ action: 'navigate', url: 'https://example.org', tab: 'B' }).catch(() => {});
      expect(context.pages().length).toBe(2);
      expect(pageA.url()).toContain('Alice');
      // Same label, same ref, but a different page/element: refused.
      await pageA.goto(html('Bob'));
      await ctl.act({ action: 'snapshot', tab: 'A' });
      const swapped = await ctl.act({ action: 'click', ref, tab: 'A', expect: assessed });
      expect(swapped.ok).toBe(false);
      expect(swapped.error).toMatch(/page changed|not on the page/);
      expect(await pageA.title()).not.toContain('sent');
      // The real thing: back on Alice's thread, re-assessed, the click goes to that node.
      await pageA.goto(html('Alice'));
      const snap2 = (await ctl.act({ action: 'snapshot', tab: 'A' })).snapshot ?? '';
      const ref2 = /\[(e\d+)\] button "Send"/.exec(snap2)![1];
      const t2 = (await ctl.act({ action: 'describe', ref: ref2, tab: 'A' })).target!;
      const ok = await ctl.act({ action: 'click', ref: ref2, tab: 'A', expect: t2 });
      expect(ok.ok, ok.error).toBe(true);
      expect(await pageA.title()).toBe('sent to Alice');
      // Closing task B's tab leaves task A's alone.
      await ctl.act({ action: 'close', tab: 'B' });
      expect(context.pages().length).toBe(1);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('keeps element identity out of the page, and refuses look-alikes and changed destinations', async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const context = await browser.newContext();
      const ctl = new BrowserController(context);
      await ctl.act({ action: 'snapshot', tab: 'T' });
      const page = context.pages()[0];
      const load = async () => {
        await page.setContent(`<form action="https://example.com/save" method="post" onsubmit="event.preventDefault();document.title='submitted to '+this.getAttribute('action')"><input name=q><button>Save</button></form>`);
        const snap = (await ctl.act({ action: 'snapshot', tab: 'T' })).snapshot ?? '';
        const ref = /\[(e\d+)\] button "Save"/.exec(snap)![1];
        return { ref, target: (await ctl.act({ action: 'describe', ref, tab: 'T' })).target! };
      };

      // The id lives only in Wren: nothing in the page carries it, and describing again gives the same id.
      let { ref, target } = await load();
      expect(target.form).toBe('POST https://example.com/save');
      expect(await page.evaluate(() => document.querySelectorAll('[data-wren-id]').length)).toBe(0);
      expect(await page.content()).not.toContain(target.elementId!);
      expect((await ctl.act({ action: 'describe', ref, tab: 'T' })).target!.elementId).toBe(target.elementId);

      // A clone with the same ref, label and attributes put in its place is a different node.
      await page.evaluate(() => {
        const b = document.querySelector('button')!;
        const form = document.createElement('form');
        form.setAttribute('action', 'https://example.com/save');
        form.setAttribute('method', 'post');
        form.onsubmit = (e) => { e.preventDefault(); document.title = 'clone clicked'; };
        const clone = b.cloneNode(true) as HTMLElement;
        form.appendChild(clone);
        b.closest('form')!.replaceWith(form);
      });
      const cloned = await ctl.act({ action: 'click', ref, tab: 'T', expect: target });
      expect(cloned.ok).toBe(false);
      expect(cloned.error).toMatch(/not on the page any more/);
      expect(await page.title()).not.toBe('clone clicked');

      // The same node, but its form now submits somewhere else.
      ({ ref, target } = await load());
      await page.evaluate(() => document.querySelector('form')!.setAttribute('action', 'https://evil.example/steal'));
      const moved = await ctl.act({ action: 'click', ref, tab: 'T', expect: target });
      expect(moved.ok).toBe(false);
      expect(moved.error).toMatch(/page changed/);

      // A forged id can't name anything.
      ({ ref, target } = await load());
      const forged = await ctl.act({ action: 'click', ref, tab: 'T', expect: { ...target, elementId: 'el-00000000-0000-0000-0000-000000000000' } });
      expect(forged.ok).toBe(false);

      // Unchanged: the click goes to that exact node, even if refs were renumbered meanwhile.
      await ctl.act({ action: 'snapshot', tab: 'T' });
      await page.evaluate(() => document.querySelector('button')!.setAttribute('data-wren-ref', 'e999'));
      const ok = await ctl.act({ action: 'click', ref, tab: 'T', expect: target });
      expect(ok.ok, ok.error).toBe(true);
      expect(await page.title()).toBe('submitted to https://example.com/save');

      // A key press approved for "the page" is refused once that page is replaced.
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      const pageTarget = (await ctl.act({ action: 'describe', ref: '@focused', tab: 'T' })).target!;
      expect(pageTarget.role).toBe('page');
      expect((await ctl.act({ action: 'describe', ref: '@focused', tab: 'T' })).target!.elementId).toBe(pageTarget.elementId);
      await page.goto('data:text/html,<p>another document</p>');
      const press = await ctl.act({ action: 'press', key: 'Enter', tab: 'T', expect: pageTarget });
      expect(press.ok).toBe(false);
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('W-75: a page that rewrites Array, eval or iterators cannot give one element another\'s identity', async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const context = await browser.newContext();
      const ctl = new BrowserController(context);
      await ctl.act({ action: 'snapshot', tab: 'T' });
      const page = context.pages()[0];
      await page.setContent(`<button onclick="document.title='A'">Send</button><button onclick="document.title='B'">Send</button>`);
      const snap = (await ctl.act({ action: 'snapshot', tab: 'T' })).snapshot ?? '';
      const [refA, refB] = [...snap.matchAll(/\[(e\d+)\] button "Send"/g)].map((m) => m[1]);
      const a = (await ctl.act({ action: 'describe', ref: refA, tab: 'T' })).target!;
      // Now the page sabotages everything Playwright's in-page helpers use.
      await page.evaluate(() => {
        Array.prototype.indexOf = () => 0;
        Array.prototype.slice = function () { return [] as never; };
        Array.prototype[Symbol.iterator] = function* () {} as never;
        window.eval = (() => () => 'hijacked') as never;
      });
      const b = (await ctl.act({ action: 'describe', ref: refB, tab: 'T' })).target!;
      expect(b.elementId).not.toBe(a.elementId);
      const clicked = await ctl.act({ action: 'click', ref: refB, tab: 'T', expect: b });
      expect(clicked.ok, clicked.error).toBe(true);
      expect(await page.title()).toBe('B');
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('W-77: typing and key presses reach the checked element or nothing', async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const context = await browser.newContext();
      const ctl = new BrowserController(context);
      await ctl.act({ action: 'snapshot', tab: 'T' });
      const page = context.pages()[0];
      await page.setContent(`
        <div id=note contenteditable aria-label="Note">x</div>
        <div id=trap contenteditable aria-label="Comment">y</div>
        <input id=pw type=password>
        <label id=lab for=pw role=textbox>Search</label>
        <input id=q aria-label="Query"><input id=r aria-label="Other">
        <button id=ok onclick="document.title='ok'">OK</button><button id=bad onclick="document.title='bad'">Delete all</button>
        <script>
          document.getElementById('trap').addEventListener('focus', () => document.getElementById('pw').focus());
          document.getElementById('note').addEventListener('beforeinput', () => document.getElementById('pw').focus());
        </script>`);
      const snap = (await ctl.act({ action: 'snapshot', tab: 'T' })).snapshot ?? '';
      const ref = (label: string) => new RegExp(`\\[(e\\d+)\\] \\w+ "${label}"`).exec(snap)![1];
      const pw = () => page.locator('#pw').inputValue();
      const typeInto = async (label: string, text: string) => {
        const r = ref(label);
        const t = (await ctl.act({ action: 'describe', ref: r, tab: 'T' })).target!;
        return ctl.act({ action: 'type', ref: r, text, tab: 'T', expect: t });
      };

      // A field that hands focus to the password box when clicked into: nothing is typed.
      const trapped = await typeInto('Comment', 'secret-1');
      expect(trapped.ok).toBe(false);
      expect(trapped.error).toMatch(/Focus moved/);
      expect(await pw()).toBe('');
      // A handler that moves focus while the text goes in can't take the text with it.
      const note = await typeInto('Note', 'hello');
      expect(note.ok, note.error).toBe(true);
      expect(await page.locator('#note').textContent()).toBe('hello');
      expect(await pw()).toBe('');
      // A label is not its field: no typing through it into the password box.
      const viaLabel = await typeInto('Search', 'secret-2');
      expect(viaLabel.ok).toBe(false);
      expect(await pw()).toBe('');
      // Plain inputs still work, and only the checked one changes.
      expect((await typeInto('Query', 'weather')).ok).toBe(true);
      expect(await page.locator('#q').inputValue()).toBe('weather');
      expect(await page.locator('#r').inputValue()).toBe('');

      // Enter approved for OK, while the page keeps moving focus to "Delete all": OK is pressed.
      await page.focus('#ok');
      const okTarget = (await ctl.act({ action: 'describe', ref: '@focused', tab: 'T' })).target!;
      await page.evaluate(() => { setInterval(() => (document.getElementById('bad') as HTMLElement).focus(), 0); });
      await page.waitForTimeout(50);
      await page.focus('#ok');
      const pressed = await ctl.act({ action: 'press', key: 'Enter', tab: 'T', expect: okTarget });
      if (pressed.ok) expect(await page.title()).toBe('ok');
      else expect(pressed.error).toMatch(/Focus is no longer|moved focus/);
      expect(await page.title()).not.toBe('bad');
    } finally {
      await browser.close();
    }
  }, 60_000);

  it('W-80: closing a task closes its popups too, and says so when it can\'t', async () => {
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const context = await browser.newContext();
      const ctl = new BrowserController(context);
      await ctl.act({ action: 'snapshot', tab: 'T' });
      await ctl.act({ action: 'snapshot', tab: 'U' }); // another task keeps the browser in use
      const opener = context.pages()[0];
      const first = context.waitForEvent('page');
      await opener.evaluate(() => { window.open('about:blank#popup1'); });
      const popup = await first;
      const second = context.waitForEvent('page');
      await popup.evaluate(() => { window.open('about:blank#popup2'); });
      const popup2 = await second;
      // The task's actions now go to its newest page.
      expect((await ctl.act({ action: 'snapshot', tab: 'T' })).url).toContain('popup2');

      // A page that refuses to close: the task isn't reported closed, and stays on record.
      const realClose = popup.close.bind(popup);
      popup.close = async () => { throw new Error('stuck'); };
      const failed = await ctl.act({ action: 'close', tab: 'T' });
      expect(failed.ok).toBe(false);
      expect(opener.isClosed()).toBe(true);
      expect(popup2.isClosed()).toBe(true);
      expect(popup.isClosed()).toBe(false);
      popup.close = realClose;
      const retried = await ctl.act({ action: 'close', tab: 'T' });
      expect(retried.ok).toBe(true);
      expect(popup.isClosed()).toBe(true);
      // The other task's tab is untouched.
      expect(context.pages().length).toBe(1);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
