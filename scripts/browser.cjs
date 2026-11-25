// Opens Chromium with the built extension loaded, for trying Annonote by hand.
// Usage: npm run browser [-- <url>]. Notes are kept in .dev-profile/ between runs.
// Needs Playwright (npm install --no-save playwright && npx playwright install chromium).
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const ext = path.join(root, 'dist');
const url = process.argv[2] || 'https://en.wikipedia.org/wiki/Diffusion_equation';

(async () => {
  const context = await chromium.launchPersistentContext(path.join(root, '.dev-profile'), {
    headless: false,
    viewport: null,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--start-maximized'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(url);
  console.log(`Annonote is running. Close the browser window to stop.`);
  context.on('close', () => process.exit(0));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
