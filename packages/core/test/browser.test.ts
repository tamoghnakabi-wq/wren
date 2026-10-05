import { describe, expect, it } from 'vitest';
import { BrowserController } from '../src/browser/controller';

// Drives a real Chrome (set WREN_BROWSER_TEST=1; needs Google Chrome installed).
describe.skipIf(!process.env.WREN_BROWSER_TEST)('browser controller', () => {
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
      expect(assessed.elementId).toMatch(/^[a-z0-9]+-\d+$/);
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
      expect(swapped.error).toMatch(/page changed/);
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
});
