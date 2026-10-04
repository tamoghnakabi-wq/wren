// Local smoke test of BrowserController with the user's installed Chrome.
import { chromium } from 'playwright-core';
import { BrowserController } from '../src/browser/controller';

const ctx = await chromium.launchPersistentContext('/private/tmp/claude-501/-Users-tamoghnakabi-studioproject/0ac17117-7f92-435c-b524-1046fe421157/scratchpad/bprofile', { channel: 'chrome', headless: true, viewport: { width: 1280, height: 800 } });
const b = new BrowserController(ctx);
const nav = await b.act({ action: 'navigate', url: 'https://example.com' });
console.log('NAV', nav.ok, nav.title, '\n' + nav.snapshot, 'preview bytes', nav.preview?.length);
const d = await b.act({ action: 'describe', ref: 'e1' });
console.log('DESCRIBE', JSON.stringify(d.target));
const c = await b.act({ action: 'click', ref: 'e1' });
console.log('CLICK', c.ok, c.url, c.error ?? '');
const s = await b.act({ action: 'screenshot' });
console.log('SHOT', s.ok, s.image?.length);
const bad = await b.act({ action: 'click', ref: 'e999' });
console.log('BAD', bad.ok, bad.error);
await ctx.close();
