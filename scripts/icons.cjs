// Renders the extension icons to PNG with Playwright. Run once: node scripts/icons.cjs
const { chromium } = require('playwright');
const path = require('node:path');

const svg = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="8" fill="#26262e"/>
  <rect x="6" y="15" width="20" height="8" rx="2" fill="#ffd60a"/>
  <rect x="6" y="9" width="14" height="3" rx="1.5" fill="#ffffff" opacity="0.9"/>
  <rect x="9" y="17.5" width="14" height="3" rx="1.5" fill="#26262e"/>
</svg>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg(size)}`);
    await page.locator('svg').screenshot({
      path: path.join(__dirname, '..', 'src', 'static', 'icons', `icon-${size}.png`),
      omitBackground: true,
    });
  }
  await browser.close();
})();
