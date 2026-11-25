# Plan: highlighting PDFs

Status: proposal · 2026-11-25

## The problem

When Chrome opens a PDF, it renders it in its own built-in viewer, which runs out of process. Our content script
can run in the wrapper page around the viewer, but it can't reach the viewer's text, selection or layout, so there
is nothing to anchor highlights to or paint them on. Every annotation tool that supports PDFs in Chrome solves this
by showing the PDF in **its own viewer built on [PDF.js](https://mozilla.github.io/pdf.js/)** instead. Hypothesis does this
with its [annotate-pdf.js](https://github.com/internetarchive/annotate-pdf.js/wiki) fork of the PDF.js viewer. We
should do the same.

## Goals

- Highlight text in a PDF in five colors, with notes and tags, using the same sidebar, library, folders,
  color filter, night mode and exports as for web pages.
- Highlights come back when the PDF is opened again, including at a different address (a mirror, a local copy,
  a link that redirects).
- Highlight regions such as figures, equations and scanned pages by dragging a box. This is the PDF counterpart of
  the image highlights on web pages.
- Never surprise the user: Chrome's own viewer stays the default until they choose otherwise.

Not in scope for the first release: PDF forms, PDFs shown inside other pages' iframes, OCR for scanned PDFs (they
get box highlights only), and DRM-protected PDFs.

## How it fits the current code

| Today (web pages) | For PDFs |
| --- | --- |
| `content/index.tsx` mounts the UI on the page | A new extension page, `pdf.html`, hosts PDF.js and mounts the same `App` |
| `Controller` reads `document.body` and the page URL | `Controller` talks to a **document adapter** with two versions: `HtmlDocument` (today's code) and `PdfDocument` |
| `buildTextMap(document.body)` gives one text string for the page | `PdfDocument` builds the same `TextMap` shape from PDF.js `getTextContent()` for every page |
| `Highlighter` paints `Range`s with the CSS Custom Highlight API, plus boxes over atoms | The same, applied to PDF.js text-layer spans; box highlights reuse the overlay code from math and images |
| A page record is keyed by its normalized URL, with lookup by canonical URL or DOI | Also look up by the **PDF fingerprint** (`pdfDocument.fingerprints[0]`), using the same `index` record |
| Jump links use `#:~:text=` | Jump links use `#page=N` (works in Chrome's viewer and in PDF.js) |

Most of the work is the adapter split and the viewer page. Storage, the library, folders, exports and the sidebar
need only small additions.

## Design

### 1. Opening PDFs in Annonote's viewer

Do this in stages, from least to most automatic:

1. **"Annotate this PDF" bar (default).** The content script already runs on the page Chrome builds around a PDF
   (`document.contentType === 'application/pdf'`). There, instead of the normal UI, it shows a small bar:
   *Annotate with Annonote*. Clicking it opens
   `chrome-extension://<id>/pdf.html?file=<encoded url>`. The bar also shows the number of highlights if this
   PDF already has some.
2. **Toolbar popup and context menu.** The popup gets *Open in Annonote* when the tab shows a PDF. Right-clicking
   a link to a PDF offers *Open PDF in Annonote*. This works with no extra permissions.
3. **Optional: "Always open PDFs in Annonote" setting.** This is automatic redirection with
   `declarativeNetRequest`. A rule matching on `Content-Type: application/pdf` needs the `responseHeaders`
   condition. That condition [exists in Chrome](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest)
   and is evaluated once response headers arrive. However, [MDN notes](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest/HeaderInfo)
   that Chrome 121–127 ignored it and applied the rule to every response. So this needs
   `minimum_chrome_version` 128 or later, plus a check in the spike that a redirect action works at that stage. If
   it doesn't, fall back to a URL rule for `*.pdf` main-frame requests. That fallback misses PDFs served from
   URLs without `.pdf`, which the bar in stage 1 still covers.

Redirecting breaks Chrome's own "Save as" and print for that tab
([known trade-off](https://discourse.mozilla.org/t/developing-a-add-on-extension-to-view-pdfs/55619)). The viewer
needs its own **Download** and **Print** buttons, plus a link back to *Open in Chrome's viewer*.

### 2. Loading the file

- `pdf.html` fetches the PDF from the extension origin. Fetching another site's file there needs host permission,
  so add `optional_host_permissions: ["<all_urls>"]`. The viewer then asks for the PDF's origin with
  `chrome.permissions.request` the first time, from a button click (it needs a user gesture). We never ask for
  every site at install time.
- **PDFs behind a login.** The extension origin may not get the site's cookies (SameSite). Fallback: the content
  script on Chrome's PDF page fetches the same URL from the page's own origin, so the user's session applies.
  It then streams the bytes to the viewer over a `chrome.runtime` port in 1 MB chunks.
- **Local files.** `file://` PDFs work if the user turns on *Allow access to file URLs*. Also accept PDFs
  dropped onto the viewer or picked with a file input. These have no URL, so they're matched by fingerprint.
- Cap the size at around 200 MB, with a clear message above it.

### 3. Rendering

- Bundle `pdfjs-dist`, pinning an exact version. Text positions depend on how PDF.js extracts text, so upgrades
  must be deliberate (see "Risks"). Use the reusable viewer components (`PDFViewer`, `EventBus`,
  `PDFLinkService`, `PDFFindController`) rather than the full Firefox viewer UI, so the page looks like Annonote.
- The worker (`pdf.worker.mjs`) ships as an extension file, so it's allowed under MV3's CSP. No `eval`; set
  `isEvalSupported: false`.
- Viewer features to include: zoom, page navigation, the document outline, find in document, Download, Print, and
  **night mode**. Night mode uses our theme for the chrome around the pages, plus an optional *Dim pages* toggle
  that applies `filter: invert(0.88) hue-rotate(180deg)` to page canvases.

### 4. Anchoring

- **Page text.** `PdfDocument.buildTextMap()` joins `getTextContent()` items page by page and inserts a newline
  where an item has `hasEOL` and a blank line between pages. It also records `starts` for each page. The
  result is the same `TextMap` the rest of the code uses, so `describe`, `locate` (exact, then fuzzy) and the
  quote/position selectors work unchanged. Text for all pages is extracted once in the background when the PDF
  opens, cached in memory by fingerprint, and takes about 1 s per 300 pages.
- **Selectors stored for a PDF highlight:** `TextQuoteSelector` and `TextPositionSelector` as today, plus a W3C
  `FragmentSelector` with `page=N` (1-based) so we know which page to open without extracting text. This is
  also what jump links and exports use.
- **Painting.** PDF.js renders the text layer only for pages near the viewport. On each `textlayerrendered`
  event, map that page's part of each highlight to the text-layer spans and add `Range`s to the existing
  `Highlighter`. Text-layer glyphs are transparent, but `::highlight()` backgrounds still paint, so the look
  matches web pages. When a page scrolls away its ranges are dropped, and they're rebuilt when it renders
  again.
- **Selecting.** The text layer is a normal DOM selection, so the toolbar code works once `usableSelection()`
  accepts selections inside the viewer's container. Selections across page breaks map to a single span.

### 5. Box highlights (figures, equations, scanned pages)

- Add a box tool to the toolbar: drag a rectangle on a page. Store a `FragmentSelector` with
  `page=N&viewrect=x,y,w,h`, in PDF user-space units so it's independent of zoom. Add an `image` entry with a
  small PNG thumbnail cropped from the canvas, saved as a `data:` URL. The 100 kB cap from web images applies.
- These show up in the sidebar, library and Markdown exactly like image highlights do now. They reuse the
  `images` field and the `QuoteContent` thumbnails.
- In Notion, data-URL images can't be shown. The highlight is sent with its page number and a note that it is a
  region.

### 6. Storage and identity

- `Page` gets `kind?: 'pdf'`, `fingerprint?: string` and `pageCount?: number`. The `index` record learns
  `fingerprint`. `findPage` adds "then by fingerprint" after canonical URL and DOI.
- Many papers carry a DOI in their metadata. PDF.js exposes the document info and XMP metadata, so read
  `dc:identifier`/`prism:doi`. This lets a PDF and the article's web page share one record, which already works
  for web pages with a DOI.
- Title comes from the PDF metadata, then the first large text on page 1, then the file name.

### 7. Library, exports, Notion

- In the library, cards get a small **PDF** label, and each highlight shows **p. N**. Clicking a quote opens
  `pdf.html?file=…&annotation=<id>`, which scrolls to the highlight and flashes it.
- Markdown front matter gains `type: pdf` and `pages: N`. Each quote's jump link is `url#page=N`, which Chrome's
  own viewer understands, so links work without Annonote. Quotes from PDFs often contain hyphenation and line
  breaks; reuse `cleanQuote` and also join `word-\nbreak`.
- In Notion, the page gets a link to the PDF, and each quote gets "p. N" in gray.
- Folders, tags, search, the color filter and night mode need no changes.

## Delivery

| Phase | What | Rough size |
| --- | --- | --- |
| 0. Spike | `pdf.html` renders a PDF with a text layer, selection and a hard-coded highlight. Check: Custom Highlight API on the text layer, fetching with an optional permission, the `responseHeaders` redirect on Chrome 128+, bundle size | 2–3 days |
| 1. Adapter refactor | Split `Controller` into the controller plus `HtmlDocument`; no change in behavior; the existing E2E suite must stay green | 2 days |
| 2. Viewer + opening | Viewer page (zoom, pages, outline, find, download, print, theme), the "Annotate this PDF" bar, popup entry, context menu | 4–5 days |
| 3. PDF anchoring | `PdfDocument` text map, selectors with page, lazy painting, re-anchoring on reopen, fingerprint/DOI lookup | 4–5 days |
| 4. Library and exports | PDF labels, page numbers, open-at-highlight links, Markdown/Notion changes | 2 days |
| 5. Box highlights | Box tool, viewrect selectors, thumbnails | 3 days |
| 6. Auto-open setting | DNR rules (or the `*.pdf` fallback), settings toggle, onboarding note | 1–2 days |

About 3–4 weeks of focused work in total. After phase 3 you can already highlight and annotate PDFs.

## Testing

- **Fixtures in `tests/e2e/fixtures/`:** a one-column text PDF, a two-column paper with hyphenation and ligatures
  ("ﬁ"), a PDF with a DOI in its metadata, a scanned (image-only) page, and a 300-page PDF for performance. All
  generated by a script so they're small and license-free.
- **Unit tests:** building the text map from `getTextContent` output (recorded as JSON so tests don't need
  PDF.js), page offsets, quote cleanup for hyphenation, viewrect conversion between zoom levels, fingerprint
  lookup.
- **E2E:** open each fixture through the bar, highlight, reload, check highlights come back; open the same PDF
  from a second URL and as a local file; box-highlight a figure; export Markdown and check `#page=` links; night
  mode with *Dim pages*.

## Risks and open questions

- **PDF.js upgrades change text extraction.** Stored positions may then point at slightly different text. The
  quote and context with fuzzy matching already handle this for edited web pages. Pin the version and run
  the fixture suite before any upgrade.
- **Taking over from Chrome's viewer** is a real UX cost (Save as, print, Chrome's own features). Keep it opt-in
  and always offer "Open in Chrome's viewer".
- **Bundle size.** `pdfjs-dist` plus its worker adds a few MB to the extension. That's fine for the Web Store
  limit, but it should load only in `pdf.html`, never in the content script.
- **Permissions UX.** Asking per origin is the most privacy-friendly option but adds one click per new site.
  Alternatively, ask once for `<all_urls>` behind a clear explanation in Settings. We need to decide.
- **Open question:** should a PDF and the web page of the same article (same DOI) share one record, or be two
  records shown together? Sharing is simpler to build. Two records keep page numbers meaningful.
