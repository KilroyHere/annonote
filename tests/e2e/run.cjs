// End-to-end test: loads the built extension (npm run test:e2e builds it with --e2e)
// into Chromium with Playwright and exercises highlighting, re-anchoring, the
// sidebar, the library, and exports. Requires the `playwright` package and its Chromium.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const EXT = path.resolve(__dirname, '../../dist');
const OUT = path.resolve(process.env.E2E_OUT || path.join(__dirname, '../../test-results'));
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Fixture server. The article changes between versions to test re-anchoring.

const base = fs.readFileSync(path.join(__dirname, 'fixtures/article.html'), 'utf8');
let version = 1;
function articleHtml() {
  let html = base;
  if (version >= 2) {
    html = html
      .replace('<!--INTRO-->', '<p id="p0">Editor\'s note: this article was updated with new reporting about river restoration.</p>')
      .replace(
        'As water rounds a bend, it is pushed toward the outer bank, which raises the water surface there.',
        'As water rounds a bend, it gets pushed toward the outer bank, raising the water surface there.',
      );
  }
  if (version >= 3) html = html.replace(/<p id="p3">[\s\S]*?<\/p>/, '');
  return html;
}

function lateHtml() {
  // No canonical link, and the article only appears after a delay (like a single-page app).
  const article = base.match(/<article>[\s\S]*<\/article>/)[0];
  return base
    .replace(/<link rel="canonical"[^>]*>/, '')
    .replace(/<article>[\s\S]*<\/article>/, '<div id="root">Loading…</div>')
    .replace(
      '<script>',
      `<script>setTimeout(() => { document.getElementById('root').outerHTML = ${JSON.stringify(article)}; }, 1200);</script><script>`,
    );
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (url.pathname === '/article' || url.pathname === '/mirror') return res.end(articleHtml());
  if (url.pathname === '/late') return res.end(lateHtml());
  res.statusCode = 404;
  res.end('not found');
});

// ---------------------------------------------------------------------------
// Tiny test runner

let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 6).join('\n      ')}`);
  }
}

async function eventually(fn, { timeout = 5000, interval = 100 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (Date.now() - start > timeout) throw err;
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}

// ---------------------------------------------------------------------------
// Page helpers (they run in the page's main world)

async function selectPhrase(page, phrase) {
  await page.evaluate((phrase) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(phrase);
      if (i >= 0) {
        const range = document.createRange();
        range.setStart(n, i);
        range.setEnd(n, i + phrase.length);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));
        return;
      }
    }
    throw new Error(`phrase not found: ${phrase}`);
  }, phrase);
}

function highlightCounts(page) {
  return page.evaluate(() => {
    const out = {};
    for (const [name, h] of CSS.highlights) out[name] = h.size;
    return out;
  });
}

function highlightedTexts(page) {
  return page.evaluate(() => {
    const out = {};
    for (const [name, h] of CSS.highlights) out[name] = [...h].map((r) => r.toString());
    return out;
  });
}

/** Badge text of every open tab (the worker can't see tab URLs without the "tabs" permission). */
function badgeTexts(sw) {
  return sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    return Promise.all(tabs.map((t) => chrome.action.getBadgeText({ tabId: t.id })));
  });
}

/** Sends a message to every tab's content script, as a keyboard shortcut would to the active one. */
function sendToTabs(sw, message) {
  return sw.evaluate(async (message) => {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((t) => chrome.tabs.sendMessage(t.id, message).catch(() => undefined)));
  }, message);
}

async function storedPages(sw) {
  const all = await sw.evaluate(() => chrome.storage.local.get(null));
  return Object.entries(all)
    .filter(([k]) => k.startsWith('page:'))
    .map(([, v]) => v);
}

// ---------------------------------------------------------------------------

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gloss-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    viewport: { width: 1280, height: 860 },
    acceptDownloads: true,
  });
  const errors = [];
  context.on('weberror', (e) => errors.push(e.error().message));

  let sw = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
  const extId = new URL(sw.url()).host;
  console.log(`Extension ${extId} loaded from ${EXT}\n`);

  const page = await context.newPage();
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  await page.goto(`${origin}/article?utm_source=newsletter`);
  // Wait for the content script.
  await eventually(async () => assert.equal(await page.evaluate(() => typeof CSS.highlights), 'object'));
  await page.waitForTimeout(300);

  console.log('Highlighting');
  await step('selecting text shows the toolbar', async () => {
    await selectPhrase(page, 'The outside of each curve erodes while the inside collects sand and gravel');
    await page.locator('.g-toolbar').waitFor({ timeout: 3000 });
    await page.screenshot({ path: path.join(OUT, '1-toolbar.png') });
  });

  await step('clicking a color creates a highlight without changing the DOM', async () => {
    const before = await page.evaluate(() => document.body.innerHTML.length);
    await page.locator('.g-toolbar button[aria-label="Green"]').click();
    await eventually(async () => assert.deepEqual(await highlightedTexts(page), {
      'gloss-green': ['The outside of each curve erodes while the inside collects sand and gravel'],
    }));
    assert.equal(await page.evaluate(() => document.body.innerHTML.length), before);
    assert.equal(await page.locator('.g-toolbar').count(), 0);
    await eventually(async () => {
      const pages = await storedPages(sw);
      assert.equal(pages.length, 1);
      assert.equal(pages[0].key, `${origin}/article`, 'tracking parameter dropped from key');
      assert.equal(pages[0].title, 'Why Rivers Meander');
      assert.equal(pages[0].siteName, 'Field Notes');
      assert.equal(pages[0].annotations[0].color, 'green');
    });
  });

  await step('"Note" highlights and opens the editor in the sidebar', async () => {
    await selectPhrase(page, 'As water rounds a bend, it is pushed toward the outer bank, which raises the water surface there.');
    await page.locator('.g-toolbar').getByRole('button', { name: 'Note' }).click();
    const editor = page.locator('.g-editor');
    await editor.waitFor();
    await editor.getByLabel('Note').fill('This is the key mechanism: a helical flow.\n\nCompare with the Coriolis effect?');
    await editor.getByLabel('Tags').fill('geology, #to-read');
    await editor.getByRole('button', { name: 'Save' }).click();
    await eventually(async () => {
      const [p] = await storedPages(sw);
      const a = p.annotations.find((x) => x.note.startsWith('This is the key'));
      assert.ok(a, 'note saved');
      assert.deepEqual(a.tags, ['geology', 'to-read']);
    });
    await page.locator('.g-card .g-note').filter({ hasText: 'key mechanism' }).waitFor();
  });

  await step('triple-click selects a paragraph; keyboard shortcut path highlights it', async () => {
    await page.locator('#p3').click({ clickCount: 3 });
    await page.locator('.g-toolbar').waitFor();
    await page.locator('.g-toolbar button[aria-label="Pink"]').click();
    await eventually(async () => assert.equal((await highlightCounts(page))['gloss-pink'], 1));
  });

  await step('page note and page tags save', async () => {
    const note = page.getByLabel('Page note');
    await note.fill('Good intro to fluvial geomorphology.');
    await page.getByLabel('Page tags').fill('rivers');
    await page.getByLabel('Page tags').press('Enter');
    await note.blur();
    await eventually(async () => {
      const [p] = await storedPages(sw);
      assert.equal(p.pageNote, 'Good intro to fluvial geomorphology.');
      assert.deepEqual(p.tags, ['rivers']);
    });
  });

  await step('sidebar lists highlights in page order', async () => {
    const quotes = await page.locator('.g-cards .g-quote').allInnerTexts();
    assert.equal(quotes.length, 3);
    assert.ok(quotes[0].startsWith('The outside of each curve'));
    assert.ok(quotes[1].startsWith('As water rounds a bend'));
    assert.ok(quotes[2].startsWith('Over decades'));
    await page.screenshot({ path: path.join(OUT, '2-sidebar.png') });
  });

  await step('Copy Markdown puts a formatted export on the clipboard', async () => {
    await page.getByRole('button', { name: 'Copy Markdown' }).click();
    const md = await eventually(async () => {
      const text = await page.evaluate(() => navigator.clipboard.readText());
      assert.ok(text.startsWith('---\ntitle: "Why Rivers Meander"'), text.slice(0, 80));
      return text;
    });
    assert.ok(md.includes(`url: "${origin}/article"`), 'tracking parameter removed from exported URL');
    assert.ok(md.includes('tags: ["geology", "rivers", "to-read"]'));
    assert.ok(md.includes('> The outside of each curve erodes while the inside collects sand and gravel'));
    assert.ok(md.includes('#:~:text=The%20outside%20of%20each%20curve'));
    assert.ok(md.includes('This is the key mechanism: a helical flow.\n\nCompare with the Coriolis effect?\n\n#geology #to-read'));
    fs.writeFileSync(path.join(OUT, 'sidebar-export.md'), md);
  });

  await step('Download .md saves a file', async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '.md' }).click()]);
    assert.equal(download.suggestedFilename(), 'Why Rivers Meander.md');
  });

  await step('Notion button explains how to connect when not set up', async () => {
    await page.getByRole('button', { name: 'Notion' }).click();
    await page.locator('.g-toast').filter({ hasText: 'Connect Notion' }).waitFor();
  });

  console.log('\nRe-anchoring');
  await step('highlights come back after reload', async () => {
    await page.reload();
    await eventually(async () => assert.deepEqual(await highlightCounts(page), { 'gloss-green': 1, 'gloss-yellow': 1, 'gloss-pink': 1 }));
  });

  await step('badge shows the count', async () => {
    assert.ok((await badgeTexts(sw)).includes('3'));
  });

  await step('clicking a highlight opens its note in the sidebar', async () => {
    const box = await page.evaluate(() => {
      const r = [...CSS.highlights.get('gloss-yellow')][0].getClientRects()[0];
      return { x: r.left + 20, y: r.top + r.height / 2 };
    });
    await page.mouse.click(box.x, box.y);
    await page.locator('.g-card.is-focused').filter({ hasText: 'key mechanism' }).waitFor();
  });

  await step('highlights survive edits to the page (new intro + reworded sentence)', async () => {
    version = 2;
    await page.reload();
    await eventually(async () => {
      const texts = await highlightedTexts(page);
      assert.equal(texts['gloss-yellow'][0], 'As water rounds a bend, it gets pushed toward the outer bank, raising the water surface there.');
      assert.equal(texts['gloss-green'].length, 1);
      assert.equal(texts['gloss-pink'].length, 1);
    });
  });

  await step('removed passages are listed as "not found", notes kept', async () => {
    version = 3;
    try {
    await page.reload();
    await eventually(async () => assert.equal((await highlightCounts(page))['gloss-pink'], undefined));
    // Browser-level shortcuts can't be pressed from Playwright; send what the shortcut would.
    await sendToTabs(sw, { type: 'sidebar:open' });
    await page.locator('.g-orphans').filter({ hasText: 'Not found on this page · 1' }).waitFor();
    assert.ok((await page.locator('.g-orphans .g-quote').innerText()).startsWith('Over decades'));
    await page.screenshot({ path: path.join(OUT, '3-orphan.png') });
    } finally {
      version = 1;
      await page.reload();
      await eventually(async () => assert.equal(Object.keys(await highlightCounts(page)).length, 3));
      await sendToTabs(sw, { type: 'sidebar:open' });
    }
  });

  await step('the same article at another URL is matched by its canonical link', async () => {
    const mirror = await context.newPage();
    await mirror.goto(`${origin}/mirror`);
    await eventually(async () => assert.deepEqual(await highlightCounts(mirror), { 'gloss-green': 1, 'gloss-yellow': 1, 'gloss-pink': 1 }));
    await mirror.close();
  });

  await step('content that loads late (single-page apps) still gets its highlights', async () => {
    const late = await context.newPage();
    await late.goto(`${origin}/late`);
    await late.locator('#p2').waitFor();
    await selectPhrase(late, 'helical current');
    await late.locator('.g-toolbar button[aria-label="Blue"]').click();
    await eventually(async () => assert.equal((await highlightCounts(late))['gloss-blue'], 1));
    await late.reload();
    assert.equal((await highlightCounts(late))['gloss-blue'], undefined, 'content not there yet');
    await eventually(async () => assert.equal((await highlightCounts(late))['gloss-blue'], 1), { timeout: 6000 });
    await late.close();
  });

  await step('page scripts are unaffected and see no extension DOM inside <body>', async () => {
    assert.equal(await page.evaluate(() => window.pageScriptRan), true);
    assert.equal(await page.evaluate(() => document.body.querySelectorAll('gloss-root, mark').length), 0);
  });

  console.log('\nLibrary');
  const lib = await context.newPage();
  await lib.goto(`chrome-extension://${extId}/library.html`);

  await step('lists pages and highlights', async () => {
    await lib.locator('.l-page').first().waitFor();
    assert.equal(await lib.locator('.l-page').count(), 2);
    assert.equal(await lib.locator('.l-page').filter({ hasText: 'saved' }).first().locator('.l-ann').count() > 0, true);
    await lib.screenshot({ path: path.join(OUT, '4-library.png'), fullPage: false });
  });

  await step('search filters highlights', async () => {
    try {
      await lib.getByLabel('Search').fill('oxbow');
      await eventually(async () => assert.equal(await lib.locator('.l-ann').count(), 1));
      await lib.getByLabel('Search').fill('coriolis');
      await eventually(async () => assert.equal(await lib.locator('.l-ann').count(), 1));
      await lib.getByLabel('Search').fill('meander');
      await eventually(async () => assert.equal(await lib.locator('.l-page').count(), 2)); // matches page titles
    } finally {
      await lib.getByLabel('Search').fill('');
    }
  });

  await step('tag filter', async () => {
    await lib.locator('.l-tag-filter', { hasText: '#geology' }).click();
    await eventually(async () => assert.equal(await lib.locator('.l-ann').count(), 1));
    await lib.getByRole('button', { name: 'Clear filters' }).click();
  });

  await step('editing a note in the library updates the open page', async () => {
    const card = lib.locator('.l-page', { hasText: 'Good intro' }).locator('.l-ann').filter({ hasText: 'The outside of each curve' });
    await card.getByRole('button', { name: 'Edit' }).click();
    await card.getByLabel('Note').fill('Erosion on the outside, deposition inside.');
    await card.getByRole('button', { name: 'Save' }).click();
    await page.locator('.g-card .g-note').filter({ hasText: 'Erosion on the outside' }).waitFor();
  });

  let zipPath;
  await step('exports all pages as a Markdown zip', async () => {
    const [download] = await Promise.all([lib.waitForEvent('download'), lib.getByRole('button', { name: 'Markdown (.zip)' }).click()]);
    zipPath = path.join(OUT, download.suggestedFilename());
    await download.saveAs(zipPath);
    const listing = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
    assert.ok(listing.includes('Why Rivers Meander.md'));
    assert.ok(listing.includes('Why Rivers Meander (2).md'));
    execFileSync('unzip', ['-t', zipPath]);
  });

  let backupPath;
  await step('exports a JSON backup', async () => {
    const [download] = await Promise.all([lib.waitForEvent('download'), lib.getByRole('button', { name: 'Backup (.json)' }).click()]);
    backupPath = path.join(OUT, download.suggestedFilename());
    await download.saveAs(backupPath);
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    assert.equal(backup.type, 'AnnotationCollection');
    assert.equal(backup.total, 4);
  });

  await step('deleting a page, then restoring it from the backup', async () => {
    lib.once('dialog', (d) => d.accept());
    await lib.locator('.l-page', { hasText: 'Good intro' }).getByRole('button', { name: 'Delete page and its highlights' }).click();
    await eventually(async () => assert.equal(await lib.locator('.l-page').count(), 1));
    await eventually(async () => assert.equal(Object.keys(await highlightCounts(page)).length, 0));
    await lib.locator('input[type=file]').setInputFiles(backupPath);
    await lib.locator('.l-toast').filter({ hasText: 'Imported from backup' }).waitFor();
    await eventually(async () => assert.equal(await lib.locator('.l-page').count(), 2));
    await eventually(async () => assert.equal(Object.keys(await highlightCounts(page)).length, 3));
  });

  await step('settings page renders and validates Notion input', async () => {
    await lib.getByRole('button', { name: 'Settings' }).click();
    await lib.getByRole('heading', { name: 'Notion' }).waitFor();
    await lib.getByRole('button', { name: 'Connect' }).click();
    await lib.locator('.l-toast').filter({ hasText: 'Enter the integration secret' }).waitFor();
    await lib.screenshot({ path: path.join(OUT, '5-settings.png') });
  });

  await step('library in dark mode', async () => {
    await lib.emulateMedia({ colorScheme: 'dark' });
    await lib.getByRole('button', { name: 'Back to notes' }).click();
    await lib.locator('.l-page').first().waitFor();
    await lib.screenshot({ path: path.join(OUT, '6-library-dark.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(OUT, '7-sidebar-dark.png') });
  });

  await step('popup renders', async () => {
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 300, height: 200 });
    await popup.goto(`chrome-extension://${extId}/popup.html`);
    await popup.getByRole('button', { name: 'Library' }).waitFor();
  });

  await step('no uncaught errors', async () => {
    assert.deepEqual(errors, []);
  });

  await context.close();
  server.close();
  console.log(failures ? `\n${failures} step(s) failed` : '\nAll steps passed');
  console.log(`Screenshots and exports in ${OUT}`);
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
