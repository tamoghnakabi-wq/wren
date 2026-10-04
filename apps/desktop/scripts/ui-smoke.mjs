// Drives the running desktop app (started with --remote-debugging-port) over CDP:
// signs in with the local test account if needed, then checks the desktop bridge,
// link state and the "This computer" settings.  node scripts/ui-smoke.mjs <port> <accounts.json>
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';

const [port = '9233', accountsFile] = process.argv.slice(2);
const acct = JSON.parse(readFileSync(accountsFile, 'utf8')).owner;
for (let i = 0; i < 30; i++) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 500));
  }
}
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith('http://localhost:5310'));
if (!page) throw new Error('Wren window not found: ' + browser.contexts().flatMap((c) => c.pages()).map((p) => p.url()).join(', '));
await page.waitForLoadState('domcontentloaded');
if (page.url().includes('/login')) {
  await page.fill('#email', acct.email);
  await page.fill('#password', acct.password);
  await page.click('button[type=submit]');
  await page.waitForURL(/\/app/, { timeout: 15000 });
}
const bridge = await page.evaluate(async () => (window.wren ? await window.wren.status() : null));
console.log('BRIDGE', JSON.stringify({ linked: bridge?.linked, connected: bridge?.connected, version: bridge?.version, engines: bridge?.engines, local: bridge?.local?.reachable, chatgpt: bridge?.chatgpt }));
await page.goto('http://localhost:5310/app/settings');
await page.waitForSelector('text=This computer', { timeout: 15000 });
const folders = await page.locator('li.font-mono, li:has(button[aria-label^="Remove"])').allInnerTexts();
console.log('FOLDERS', JSON.stringify(folders));
writeFileSync(process.argv[4] ?? '/tmp/wren-settings.png', await page.screenshot({ fullPage: false }));
await page.goto('http://localhost:5310/app/connections');
await page.waitForSelector('text=Your computers', { timeout: 15000 });
const devicesText = await page.locator('#devices').innerText();
console.log('DEVICES', devicesText.replace(/\s+/g, ' ').slice(0, 400));
await browser.close();
