import {
  COLORS,
  nowIso,
  type Color,
  type Page,
  type Selector,
  type TextPositionSelector,
  type TextQuoteSelector,
} from './types';
import { cleanUrl, normalizeDoi, normalizeUrl, usableCanonical } from './url';

const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';

/**
 * The backup file is a W3C Web Annotation `AnnotationCollection`
 * (https://www.w3.org/TR/annotation-model/). Gloss-specific fields that the
 * standard has no place for live under a `gloss` key so a restore loses nothing.
 */
export interface BackupFile {
  '@context': string;
  type: 'AnnotationCollection';
  generator: { name: string; version: string };
  generated: string;
  total: number;
  items: W3CAnnotation[];
  gloss: { format: 1; pages: Omit<Page, 'annotations'>[] };
}

interface TextualBody {
  type: 'TextualBody';
  value: string;
  purpose: 'commenting' | 'tagging';
  format?: string;
}

interface W3CAnnotation {
  '@context'?: string;
  id: string;
  type: 'Annotation';
  motivation: 'commenting' | 'highlighting';
  created: string;
  modified: string;
  body: TextualBody[];
  target: { source: string; selector: Selector[] };
  gloss: { pageKey: string; color: Color; text?: string };
}

export function toBackup(pages: Page[]): BackupFile {
  const items: W3CAnnotation[] = [];
  for (const page of pages) {
    for (const a of page.annotations) {
      const body: TextualBody[] = [];
      if (a.note.trim()) body.push({ type: 'TextualBody', value: a.note, purpose: 'commenting', format: 'text/markdown' });
      for (const tag of a.tags) body.push({ type: 'TextualBody', value: tag, purpose: 'tagging' });
      items.push({
        id: `urn:uuid:${a.id}`,
        type: 'Annotation',
        motivation: a.note.trim() ? 'commenting' : 'highlighting',
        created: a.created,
        modified: a.updated,
        body,
        target: { source: page.url, selector: a.selectors },
        gloss: { pageKey: page.key, color: a.color, ...(a.text ? { text: a.text } : {}) },
      });
    }
  }
  return {
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    type: 'AnnotationCollection',
    generator: { name: 'Gloss', version: VERSION },
    generated: nowIso(),
    total: items.length,
    items,
    gloss: { format: 1, pages: pages.map(({ annotations: _annotations, ...meta }) => meta) },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function cleanSelectors(raw: unknown): Selector[] {
  if (!Array.isArray(raw)) return [];
  const out: Selector[] = [];
  for (const s of raw) {
    if (!isObject(s)) continue;
    if (s.type === 'TextQuoteSelector' && typeof s.exact === 'string' && s.exact.trim()) {
      out.push({ type: 'TextQuoteSelector', exact: s.exact, prefix: str(s.prefix), suffix: str(s.suffix) } satisfies TextQuoteSelector);
    } else if (s.type === 'TextPositionSelector' && typeof s.start === 'number' && typeof s.end === 'number') {
      out.push({ type: 'TextPositionSelector', start: s.start, end: s.end } satisfies TextPositionSelector);
    }
  }
  return out;
}

function toColor(v: unknown): Color {
  return (COLORS as readonly string[]).includes(v as string) ? (v as Color) : 'yellow';
}

/** Only web and file addresses are accepted from imported files (never javascript: or data: URLs). */
function isPageUrl(url: string): boolean {
  return /^(https?|file):/i.test(url);
}

function emptyPage(key: string, url: string, title: string, created: string): Page {
  return { key, url, title, created, updated: created, pageNote: '', tags: [], annotations: [] };
}

function fromGlossBackup(file: Record<string, unknown>): Page[] {
  const pages = new Map<string, Page>();
  const glossMeta = isObject(file.gloss) && Array.isArray(file.gloss.pages) ? file.gloss.pages : [];
  for (const raw of glossMeta) {
    if (!isObject(raw) || typeof raw.key !== 'string' || typeof raw.url !== 'string' || !isPageUrl(raw.url)) continue;
    const created = str(raw.created, nowIso());
    pages.set(raw.key, {
      ...emptyPage(raw.key, raw.url, str(raw.title), created),
      updated: str(raw.updated, created),
      canonical: typeof raw.canonical === 'string' ? raw.canonical : undefined,
      doi: typeof raw.doi === 'string' ? raw.doi : undefined,
      siteName: typeof raw.siteName === 'string' ? raw.siteName : undefined,
      author: typeof raw.author === 'string' ? raw.author : undefined,
      published: typeof raw.published === 'string' ? raw.published : undefined,
      pageNote: str(raw.pageNote),
      tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
      notion: isObject(raw.notion) && typeof raw.notion.pageId === 'string' ? (raw.notion as unknown as Page['notion']) : undefined,
    });
  }
  const items = Array.isArray(file.items) ? file.items : [];
  for (const item of items) {
    if (!isObject(item)) continue;
    const target = isObject(item.target) ? item.target : {};
    const selectors = cleanSelectors(target.selector);
    if (!selectors.some((s) => s.type === 'TextQuoteSelector')) continue;
    const source = str(target.source);
    const extra = isObject(item.gloss) ? item.gloss : {};
    const key = str(extra.pageKey) || normalizeUrl(source);
    if (!key) continue;
    const created = str(item.created, nowIso());
    let page = pages.get(key);
    if (!page) {
      if (!isPageUrl(source)) continue;
      page = emptyPage(key, source || key, '', created);
      pages.set(key, page);
    }
    const bodies = Array.isArray(item.body) ? item.body.filter(isObject) : [];
    page.annotations.push({
      id: str(item.id).replace(/^urn:uuid:/, '') || crypto.randomUUID(),
      created,
      updated: str(item.modified, created),
      color: toColor(extra.color),
      note: bodies.filter((b) => b.purpose === 'commenting').map((b) => str(b.value)).join('\n\n'),
      tags: bodies.filter((b) => b.purpose === 'tagging').map((b) => str(b.value)).filter(Boolean),
      selectors,
      ...(typeof extra.text === 'string' && extra.text ? { text: extra.text } : {}),
    });
  }
  return [...pages.values()];
}

/**
 * Converts annotations from the Hypothesis API (`/api/search` rows) into pages.
 * Page notes (annotations without a text selector) become the page note; replies are skipped.
 */
export function fromHypothesis(rows: unknown[]): Page[] {
  const pages = new Map<string, Page>();
  for (const row of rows) {
    if (!isObject(row) || typeof row.uri !== 'string') continue;
    if (Array.isArray(row.references) && row.references.length > 0) continue;
    if (!isPageUrl(row.uri)) continue;
    const doc = isObject(row.document) ? row.document : {};
    const title = Array.isArray(doc.title) ? str(doc.title[0]) : str(doc.title);
    const key = normalizeUrl(row.uri);
    const created = str(row.created, nowIso());
    let page = pages.get(key);
    if (!page) {
      page = emptyPage(key, cleanUrl(row.uri), title, created);
      pages.set(key, page);
    }
    if (!page.title && title) page.title = title;
    if (created < page.created) page.created = created;
    const updated = str(row.updated, created);
    if (updated > page.updated) page.updated = updated;

    const target = Array.isArray(row.target) && isObject(row.target[0]) ? row.target[0] : {};
    const selectors = cleanSelectors(target.selector);
    const text = str(row.text);
    const tags = Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === 'string') : [];
    if (!selectors.some((s) => s.type === 'TextQuoteSelector')) {
      if (text.trim()) page.pageNote = page.pageNote ? `${page.pageNote}\n\n${text}` : text;
      for (const t of tags) if (!page.tags.includes(t)) page.tags.push(t);
      continue;
    }
    page.annotations.push({
      id: `hypothesis-${str(row.id) || crypto.randomUUID()}`,
      created,
      updated,
      color: 'yellow',
      note: text,
      tags,
      selectors,
    });
  }
  return [...pages.values()];
}

export type ImportSource = 'gloss' | 'hypothesis';

/** Detects the format of an imported JSON file and converts it to pages. */
export function parseImport(json: unknown): { source: ImportSource; pages: Page[] } {
  if (isObject(json) && json.type === 'AnnotationCollection') {
    return { source: 'gloss', pages: fromGlossBackup(json) };
  }
  const rows = Array.isArray(json) ? json : isObject(json) && Array.isArray(json.rows) ? json.rows : null;
  if (rows) return { source: 'hypothesis', pages: fromHypothesis(rows) };
  throw new Error('Unrecognized file. Expected a Gloss backup or Hypothesis annotations (JSON).');
}

export function pageMetaFixups(page: Page): Page {
  return {
    ...page,
    canonical: usableCanonical(page.canonical, page.url),
    doi: normalizeDoi(page.doi),
  };
}
