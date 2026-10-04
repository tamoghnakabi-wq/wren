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
    } finally {
      await browser.close();
    }
  }, 60_000);
});
