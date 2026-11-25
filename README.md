# Annonote

A browser extension for highlighting and annotating any web page. Your notes stay on your computer
and export cleanly to Markdown (Obsidian, any editor) and Notion.

- **Highlight in five colors.** Add notes and tags, plus a note and tags for the page as a whole.
- **Highlights that survive page changes.** Each one is stored as a quote with surrounding context (W3C Web Annotation selectors)
  and found again with fuzzy matching when the wording changes. If a passage disappears, the quote and
  your note are kept and listed under *Not found on this page*.
- **Doesn't touch the page's DOM.** Highlights are painted with the CSS Custom Highlight API instead of
  wrapping text in elements, so pages (including React apps) keep working.
- **Private by default.** Everything is stored locally in the extension. Nothing leaves your browser
  unless you send it to Notion. The sidebar sits in a closed shadow root that page scripts can't read.
- **One library for everything.** Search across pages, quotes, notes and tags; filter by tag or color; edit anything.
- **Exports**
  - **Markdown**: one file per page with YAML front matter, highlights as blockquotes, and
    "jump to highlight" links (`#:~:text=` URL fragments) that open the page at the passage in Chrome, Edge
    and Safari, even without the extension. Copy, download one file, or download everything as a `.zip`.
  - **Notion**: each page becomes a row in a database you choose; highlights become colored quote
    blocks with your notes nested underneath. Sending again updates only what changed.
  - **JSON backup**: a W3C `AnnotationCollection` you can restore from.
- **Import** an Annonote backup or your **Hypothesis** annotations (via the API or an exported JSON file).

## Install (developer mode)

Requires Node 20+ and Chrome, Edge, Brave or another Chromium browser (version 120 or later).

```bash
npm install
```

```bash
npm run build
```

Then open `chrome://extensions`, switch on **Developer mode**, click **Load unpacked**, and choose the
`dist/` folder. Pages that were already open need a reload before Annonote works on them.

To get a zip instead (for sharing or the Chrome Web Store): `npm run package` → `release/annonote-<version>.zip`.

## Using it

| Action | How |
| --- | --- |
| Highlight | Select text, then pick a color in the toolbar, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> |
| Highlight + note | **Note** in the toolbar, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> |
| Sidebar | Click a highlight, use the toolbar button's popup, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> |
| Library | **Open library** in the sidebar or popup |
| Change shortcuts | `chrome://extensions/shortcuts` |

To use Annonote on local files (`file://`), turn on **Allow access to file URLs** in the extension's details.

### Connecting Notion

1. Create an internal integration at <https://www.notion.so/my-integrations> and copy its secret.
2. In Notion, open (or create) a database, then **••• → Connections** and add the integration.
3. In the Annonote library → **Settings**, paste the secret and the database link, and click **Connect**.

Annonote adds `URL`, `Tags` and `Saved` columns if the database doesn't have them. It remembers which Notion
blocks belong to which highlight, so re-sending a page rewrites only edited highlights, removes deleted ones and
inserts new ones in page order. If you delete the Notion page, the next send creates a new one.

## How it works

```
src/
  content/      Runs in each web page
    controller.ts   selection → highlight → storage; re-anchoring on DOM changes and SPA navigation
    anchoring.ts    DOM ⇄ text offsets; describe a selection / find it again
    locate.ts       position → exact → fuzzy (approx-string-match) search with context scoring
    highlighter.ts  CSS Custom Highlight API painting and hit-testing
    App.tsx         toolbar, sidebar, toasts (Preact, in a shadow root)
  background/   Service worker
    db.ts           chrome.storage.local, serialized writes, lookup by URL / canonical URL / DOI
    index.ts        message router, Notion sync for single pages, keyboard commands, badge
  library/      Library + settings page (search, edit, export, import)
  popup/        Toolbar popup
  shared/       Data model, Markdown, Notion, backup/import, URL handling, ZIP writer, UI components
```

**Finding a page's notes.** Pages are stored under a normalized URL: tracking parameters (`utm_*`,
`fbclid`, …) and anchors are dropped and the query is sorted. A page you open at another address is
also matched by its `<link rel="canonical">` or DOI, so the same article on a mirror or AMP page shows your highlights.

**Finding a highlight again.** Each highlight stores the exact quote with 32 characters of context on each side,
plus its character offsets. When the page loads, Annonote tries the stored offsets first, then exact matches
of the quote (using the context to choose between duplicates), then approximate matches that allow up
to 25% of the quote to differ. It retries whenever the page's content changes, which covers articles that
load after the page.

## Development

```bash
npm run watch
```

Rebuilds on change; click the reload icon on `chrome://extensions` to pick up changes.

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npm run test:e2e
```

- `npm test`: unit tests (anchoring, fuzzy matching, URL handling, Markdown, ZIP, backup/import,
  storage, and Notion sync against an in-memory fake of the Notion API).
- `npm run test:e2e`: loads the built extension into Chromium with Playwright and runs through highlighting,
  re-anchoring after page edits, late-loading content, the sidebar, the library, and the exports.
  Needs Playwright with its Chromium installed. Screenshots go to `test-results/`.

## Not yet supported

- PDFs (Chrome's built-in viewer isn't reachable from extensions; this needs a bundled PDF.js viewer).
- Text inside iframes, and editors that draw text on a canvas (e.g. Google Docs).
- Firefox (it should be mostly a manifest change).
- Automatic sync to an Obsidian vault folder (today: download the `.zip` or single files).
- Syncing between devices, and sharing or group annotation (needs a server).
