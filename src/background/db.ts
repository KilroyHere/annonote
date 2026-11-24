import type { AnnotationPatch, ImportResult, PagePatch } from '../shared/messages';
import { DEFAULT_SETTINGS, nowIso, type Annotation, type NotionState, type Page, type PageMeta, type Settings } from '../shared/types';
import { cleanUrl, normalizeDoi, normalizeUrl, usableCanonical } from '../shared/url';

/**
 * Storage layout in chrome.storage.local:
 *   page:<normalized url>  → Page (with its annotations)
 *   index                  → { [pageKey]: { canonical?, doi? } } for lookups by canonical URL / DOI
 *   settings               → Settings
 * All writes go through `withLock` so concurrent edits from several tabs cannot clobber each other.
 */

export const PAGE_PREFIX = 'page:';
const INDEX_KEY = 'index';
export const SETTINGS_KEY = 'settings';

type Index = Record<string, { canonical?: string; doi?: string }>;

let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

const storage = () => chrome.storage.local;

export async function getSettings(): Promise<Settings> {
  const { [SETTINGS_KEY]: s } = await storage().get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(s as Partial<Settings> | undefined) };
}

async function getIndex(): Promise<Index> {
  const { [INDEX_KEY]: idx } = await storage().get(INDEX_KEY);
  return (idx as Index | undefined) ?? {};
}

export async function getPage(key: string): Promise<Page | undefined> {
  const k = PAGE_PREFIX + key;
  const { [k]: page } = await storage().get(k);
  return page as Page | undefined;
}

export async function listPages(): Promise<Page[]> {
  const all = await storage().get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(PAGE_PREFIX))
    .map(([, v]) => v as Page)
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

/** Finds the stored page for what the browser is showing: by URL, then canonical URL, then DOI. */
export async function findPage(meta: PageMeta): Promise<Page | undefined> {
  const key = normalizeUrl(meta.url);
  const direct = await getPage(key);
  if (direct) return direct;
  const canonical = usableCanonical(meta.canonical, meta.url);
  const doi = normalizeDoi(meta.doi);
  if (!canonical && !doi) return undefined;
  const idx = await getIndex();
  for (const [k, v] of Object.entries(idx)) {
    if ((canonical && (k === canonical || v.canonical === canonical)) || (doi && v.doi === doi)) {
      const page = await getPage(k);
      if (page) return page;
    }
  }
  return undefined;
}

async function putPage(page: Page): Promise<void> {
  const idx = await getIndex();
  idx[page.key] = { canonical: page.canonical, doi: page.doi };
  await storage().set({ [PAGE_PREFIX + page.key]: page, [INDEX_KEY]: idx });
}

async function removePage(key: string): Promise<void> {
  const idx = await getIndex();
  delete idx[key];
  await storage().remove(PAGE_PREFIX + key);
  await storage().set({ [INDEX_KEY]: idx });
}

function isEmpty(page: Page): boolean {
  return page.annotations.length === 0 && !page.pageNote.trim() && page.tags.length === 0;
}

function newPage(key: string, meta: PageMeta): Page {
  const now = nowIso();
  return {
    key,
    url: cleanUrl(meta.url),
    title: meta.title,
    canonical: usableCanonical(meta.canonical, meta.url),
    doi: normalizeDoi(meta.doi),
    siteName: meta.siteName,
    author: meta.author,
    published: meta.published,
    created: now,
    updated: now,
    pageNote: '',
    tags: [],
    annotations: [],
  };
}

/** Fills in metadata the page record is missing (e.g. a title that loaded late). */
function refreshMeta(page: Page, meta: PageMeta): void {
  if (!page.title && meta.title) page.title = meta.title;
  page.canonical ??= usableCanonical(meta.canonical, meta.url);
  page.doi ??= normalizeDoi(meta.doi);
  page.siteName ??= meta.siteName;
  page.author ??= meta.author;
  page.published ??= meta.published;
}

async function resolvePage(pageKey: string | undefined, meta: PageMeta): Promise<Page> {
  const existing = pageKey ? await getPage(pageKey) : await findPage(meta);
  if (existing) {
    refreshMeta(existing, meta);
    return existing;
  }
  return newPage(pageKey ?? normalizeUrl(meta.url), meta);
}

export function saveAnnotation(meta: PageMeta, pageKey: string | undefined, annotation: Annotation): Promise<Page> {
  return withLock(async () => {
    const page = await resolvePage(pageKey, meta);
    const i = page.annotations.findIndex((a) => a.id === annotation.id);
    if (i >= 0) page.annotations[i] = annotation;
    else page.annotations.push(annotation);
    page.updated = nowIso();
    await putPage(page);
    return page;
  });
}

export function updateAnnotation(pageKey: string, id: string, patch: AnnotationPatch): Promise<Page | null> {
  return withLock(async () => {
    const page = await getPage(pageKey);
    const a = page?.annotations.find((x) => x.id === id);
    if (!page || !a) return null;
    if (patch.note !== undefined) a.note = patch.note;
    if (patch.tags !== undefined) a.tags = patch.tags;
    if (patch.color !== undefined) a.color = patch.color;
    a.updated = page.updated = nowIso();
    await putPage(page);
    return page;
  });
}

export function deleteAnnotation(pageKey: string, id: string): Promise<Page | null> {
  return withLock(async () => {
    const page = await getPage(pageKey);
    if (!page) return null;
    page.annotations = page.annotations.filter((a) => a.id !== id);
    page.updated = nowIso();
    if (isEmpty(page) && !page.notion) {
      await removePage(pageKey);
      return null;
    }
    await putPage(page);
    return page;
  });
}

export function updatePage(pageKey: string | undefined, meta: PageMeta | undefined, patch: PagePatch): Promise<Page | null> {
  return withLock(async () => {
    let page = pageKey ? await getPage(pageKey) : undefined;
    if (!page && meta) page = await resolvePage(pageKey, meta);
    if (!page) return null;
    if (patch.pageNote !== undefined) page.pageNote = patch.pageNote;
    if (patch.tags !== undefined) page.tags = patch.tags;
    if (patch.title !== undefined) page.title = patch.title;
    page.updated = nowIso();
    if (isEmpty(page) && !page.notion) {
      if (await getPage(page.key)) await removePage(page.key);
      return null;
    }
    await putPage(page);
    return page;
  });
}

export function setNotionState(pageKey: string, notion: NotionState | null): Promise<Page | null> {
  return withLock(async () => {
    const page = await getPage(pageKey);
    if (!page) return null;
    if (notion) page.notion = notion;
    else delete page.notion;
    await putPage(page);
    return page;
  });
}

export function deletePage(pageKey: string): Promise<void> {
  return withLock(() => removePage(pageKey));
}

/** Merges imported pages: new annotations are added, newer versions replace older ones. */
export function importPages(pages: Page[]): Promise<ImportResult> {
  return withLock(async () => {
    const result: ImportResult = { pages: 0, added: 0, updated: 0 };
    for (const incoming of pages) {
      const key = incoming.key || normalizeUrl(incoming.url);
      const existing = await getPage(key);
      if (!existing) {
        await putPage({
          ...incoming,
          key,
          canonical: usableCanonical(incoming.canonical, incoming.url),
          doi: normalizeDoi(incoming.doi),
        });
        result.pages++;
        result.added += incoming.annotations.length;
        continue;
      }
      let changed = false;
      for (const a of incoming.annotations) {
        const i = existing.annotations.findIndex((x) => x.id === a.id);
        if (i < 0) {
          existing.annotations.push(a);
          result.added++;
          changed = true;
        } else if (a.updated > existing.annotations[i]!.updated) {
          existing.annotations[i] = a;
          result.updated++;
          changed = true;
        }
      }
      if (!existing.pageNote.trim() && incoming.pageNote.trim()) {
        existing.pageNote = incoming.pageNote;
        changed = true;
      }
      for (const t of incoming.tags) {
        if (!existing.tags.includes(t)) {
          existing.tags.push(t);
          changed = true;
        }
      }
      if (!existing.title && incoming.title) {
        existing.title = incoming.title;
        changed = true;
      }
      if (changed) {
        existing.updated = nowIso();
        await putPage(existing);
        result.pages++;
      }
    }
    return result;
  });
}
