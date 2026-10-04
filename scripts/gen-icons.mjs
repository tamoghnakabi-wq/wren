// Renders the Wren mark to PNG icons for the web (PWA) and desktop builds.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';

const bird = `<path d="M8.5 19.2c0-4.6 3.6-8.3 8.1-8.3 2.2 0 4 .8 5.3 2.2l3.7-1.6-1.9 3.4c.4 1 .6 2.1.6 3.3 0 .5 0 .9-.1 1.4l2 2.6-3.2-.6c-1.5 2.1-3.9 3.4-6.6 3.4H8.5l2.6-2.4c-1.6-.9-2.6-2-2.6-3.4Z" fill="FILL"/>`;
const app = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ef7a3f"/><stop offset="1" stop-color="#c9531f"/></linearGradient></defs><g transform="translate(${pad} ${pad}) scale(${(32 - 2 * pad) / 32})"><rect width="32" height="32" rx="7.2" fill="url(#g)"/><g transform="translate(-1.6 -1.5)">${bird.replace('FILL', '#fff')}<circle cx="20.2" cy="15.6" r="1.25" fill="#d9622b"/></g></g></svg>`;
const tray = (fill) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 8 22 18">${bird.replace('FILL', fill)}<circle cx="20.2" cy="15.6" r="1.3" fill="${fill === '#000' ? 'transparent' : '#fff'}"/></svg>`;
writeFileSync('apps/web/src/app/icon.svg', app(0));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
async function render(svg, size, out, bg = 'transparent') {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:${bg}">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  writeFileSync(out, await page.screenshot({ omitBackground: bg === 'transparent', clip: { x: 0, y: 0, width: size, height: size } }));
}
await render(app(2.2), 1024, 'apps/desktop/build/icon.png');
await render(app(0), 512, 'apps/web/public/icon-512.png');
await render(app(0), 192, 'apps/web/public/icon-192.png');
await render(app(0).replace('rx="7.2"', 'rx="0"'), 180, 'apps/web/src/app/apple-icon.png');
await render(tray('#ffffff').replace('fill="#ffffff"', 'fill="#d9622b"'), 72, 'apps/web/public/badge-72.png');
await render(tray('#000'), 16, 'apps/desktop/build/trayTemplate.png');
await render(tray('#000'), 32, 'apps/desktop/build/trayTemplate@2x.png');
await render(app(0), 32, 'apps/desktop/build/tray.png');
await browser.close();
console.log('icons written');
