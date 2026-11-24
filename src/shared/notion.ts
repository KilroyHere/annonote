import { byPosition, nowIso, quoteOf, type Annotation, type NotionState, type Page } from './types';
import { displayQuote } from './quote';
import { textFragmentUrl } from './textFragment';

/** Pinned API version: page parents are plain database ids and `after` positions appended blocks. */
export const NOTION_VERSION = '2022-06-28';
const API = 'https://api.notion.com/v1';
const MAX_TEXT = 2000;
const MAX_CHILDREN = 100;
const MIN_GAP_MS = 350; // Notion allows ~3 requests/second on average.

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class NotionError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'NotionError';
  }
}

export interface NotionClientOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  minGapMs?: number;
}

export class NotionClient {
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly minGapMs: number;
  private last = 0;

  constructor(
    private readonly token: string,
    opts: NotionClientOptions = {},
  ) {
    // Wrap so `fetch` is never called with a foreign `this` (illegal invocation).
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.minGapMs = opts.minGapMs ?? MIN_GAP_MS;
  }

  async request<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const wait = this.last + this.minGapMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.last = Date.now();
      const res = await this.fetchFn(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const message = typeof json.message === 'string' ? json.message : `Notion request failed (${res.status})`;
        throw new NotionError(message, res.status, typeof json.code === 'string' ? json.code : undefined);
      }
      return json as T;
    }
  }
}

/** Accepts a database id (with or without dashes) or a Notion database URL. */
export function parseDatabaseId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let candidate = trimmed;
  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split('/').filter(Boolean);
    candidate = segments[segments.length - 1] ?? '';
  } catch {
    /* not a URL */
  }
  const compact = candidate.replace(/-/g, '');
  const m = compact.match(/([0-9a-f]{32})$/i);
  if (!m) return null;
  const h = m[1]!.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Block builders

type RichText = {
  type: 'text';
  text: { content: string; link?: { url: string } | null };
  annotations?: { color?: string; italic?: boolean };
};

function richText(content: string, extra: { link?: string; color?: string; italic?: boolean } = {}): RichText[] {
  const out: RichText[] = [];
  for (let i = 0; i < content.length; i += MAX_TEXT) {
    const item: RichText = { type: 'text', text: { content: content.slice(i, i + MAX_TEXT) } };
    if (extra.link) item.text.link = { url: extra.link };
    if (extra.color || extra.italic) item.annotations = { color: extra.color, italic: extra.italic };
    out.push(item);
  }
  return out.slice(0, 100);
}

function paragraph(rt: RichText[]): object {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: rt } };
}

function noteParagraphs(note: string, limit: number): object[] {
  const parts = note
    .trim()
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > limit) parts.splice(limit - 1, parts.length, parts.slice(limit - 1).join('\n\n'));
  return parts.map((p) => paragraph(richText(p)));
}

function tagLine(tags: string[]): RichText[] {
  return richText(tags.map((t) => `#${t}`).join(' '), { color: 'gray' });
}

export interface SyncOptions {
  highlightLinks: boolean;
}

interface Item {
  key: string;
  block: object;
  hash: string;
  /** Items without children can be edited in place instead of replaced. */
  editable: boolean;
}

const SOURCE_KEY = '__source';
const PAGE_NOTE_KEY = '__pagenote';

function hashOf(value: unknown): string {
  const s = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + s.length.toString(36);
}

function annotationBlock(page: Page, a: Annotation, opts: SyncOptions): object {
  const quote = displayQuote(a);
  const rt = richText(quote);
  if (opts.highlightLinks) rt.push(...richText(' ↗', { link: textFragmentUrl(page.url, quote) }));
  const children = noteParagraphs(a.note, MAX_CHILDREN - 1);
  if (a.tags.length) children.push(paragraph(tagLine(a.tags)));
  const block: Record<string, unknown> = { rich_text: rt.slice(0, 100), color: `${a.color}_background` };
  if (children.length) block.children = children;
  return { object: 'block', type: 'quote', quote: block };
}

export function buildItems(page: Page, opts: SyncOptions): Item[] {
  const items: Item[] = [];
  const source = paragraph([...richText('Source: ', { color: 'gray' }), ...richText(page.url, { link: page.url })]);
  items.push({ key: SOURCE_KEY, block: source, hash: hashOf(source), editable: true });
  const noteText = [page.pageNote.trim(), page.tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join('\n\n');
  if (noteText) {
    const callout = {
      object: 'block',
      type: 'callout',
      callout: { rich_text: richText(noteText), icon: { type: 'emoji', emoji: '📝' }, color: 'gray_background' },
    };
    items.push({ key: PAGE_NOTE_KEY, block: callout, hash: hashOf(callout), editable: true });
  }
  for (const a of [...page.annotations].sort(byPosition)) {
    quoteOf(a); // throws on malformed annotations rather than syncing an empty block
    const block = annotationBlock(page, a, opts);
    items.push({ key: a.id, block, hash: hashOf(block), editable: false });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Database schema

export interface Schema {
  titleProp: string;
  urlProp?: string;
  tagsProp?: string;
  savedProp?: string;
}

const WANTED: Record<'urlProp' | 'tagsProp' | 'savedProp', { name: string; type: string }> = {
  urlProp: { name: 'URL', type: 'url' },
  tagsProp: { name: 'Tags', type: 'multi_select' },
  savedProp: { name: 'Saved', type: 'date' },
};

/** Reads the database and adds URL / Tags / Saved columns if they are missing. */
export async function ensureSchema(client: NotionClient, databaseId: string): Promise<Schema> {
  const db = await client.request<{ properties: Record<string, { type: string }> }>('GET', `/databases/${databaseId}`);
  const props = db.properties ?? {};
  const titleProp = Object.entries(props).find(([, p]) => p.type === 'title')?.[0];
  if (!titleProp) throw new NotionError('That database has no title column.', 400);
  const schema: Schema = { titleProp };
  const missing: Record<string, object> = {};
  for (const [field, want] of Object.entries(WANTED) as [keyof typeof WANTED, (typeof WANTED)[keyof typeof WANTED]][]) {
    const existing = props[want.name];
    if (!existing) missing[want.name] = { [want.type]: {} };
    else if (existing.type === want.type) schema[field] = want.name;
  }
  if (Object.keys(missing).length) {
    try {
      await client.request('PATCH', `/databases/${databaseId}`, { properties: missing });
      for (const [field, want] of Object.entries(WANTED) as [keyof typeof WANTED, (typeof WANTED)[keyof typeof WANTED]][]) {
        if (missing[want.name]) schema[field] = want.name;
      }
    } catch {
      // No permission to change columns: sync with the columns that exist.
    }
  }
  return schema;
}

function buildProperties(page: Page, schema: Schema, tags: string[]): Record<string, unknown> {
  const props: Record<string, unknown> = {
    [schema.titleProp]: { title: richText((page.title || page.url).slice(0, MAX_TEXT)) },
  };
  if (schema.urlProp) props[schema.urlProp] = { url: page.url };
  if (schema.tagsProp) {
    props[schema.tagsProp] = { multi_select: tags.map((t) => ({ name: t.replace(/,/g, ' ').slice(0, 100) })) };
  }
  if (schema.savedProp) props[schema.savedProp] = { date: { start: page.created.slice(0, 10) } };
  return props;
}

// ---------------------------------------------------------------------------
// Sync

function sameId(a: string | undefined, b: string): boolean {
  return !!a && a.replace(/-/g, '') === b.replace(/-/g, '');
}

async function listChildIds(client: NotionClient, blockId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const q = cursor ? `?page_size=100&start_cursor=${encodeURIComponent(cursor)}` : '?page_size=100';
    const res = await client.request<{ results: { id: string }[]; has_more: boolean; next_cursor: string | null }>(
      'GET',
      `/blocks/${blockId}/children${q}`,
    );
    ids.push(...res.results.map((r) => r.id));
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
  return ids;
}

async function append(client: NotionClient, parentId: string, blocks: object[], after?: string): Promise<string[]> {
  const body: Record<string, unknown> = { children: blocks };
  if (after) body.after = after;
  try {
    const res = await client.request<{ results: { id: string }[] }>('PATCH', `/blocks/${parentId}/children`, body);
    return res.results.map((r) => r.id);
  } catch (err) {
    // The block we wanted to insert after was deleted in Notion: append at the end instead.
    if (after && err instanceof NotionError && (err.status === 400 || err.status === 404)) {
      return append(client, parentId, blocks);
    }
    throw err;
  }
}

async function deleteBlock(client: NotionClient, id: string): Promise<void> {
  try {
    await client.request('DELETE', `/blocks/${id}`);
  } catch (err) {
    if (!(err instanceof NotionError && (err.status === 404 || err.status === 400))) throw err;
  }
}

async function createPage(
  client: NotionClient,
  databaseId: string,
  properties: Record<string, unknown>,
  items: Item[],
): Promise<NotionState> {
  const created = await client.request<{ id: string; url?: string }>('POST', '/pages', {
    parent: { database_id: databaseId },
    properties,
    children: items.slice(0, MAX_CHILDREN).map((i) => i.block),
  });
  for (let i = MAX_CHILDREN; i < items.length; i += MAX_CHILDREN) {
    await append(client, created.id, items.slice(i, i + MAX_CHILDREN).map((it) => it.block));
  }
  const ids = await listChildIds(client, created.id);
  const blocks: NotionState['blocks'] = {};
  items.forEach((item, i) => {
    const id = ids[i];
    if (id) blocks[item.key] = { id, hash: item.hash };
  });
  return { pageId: created.id, url: created.url, blocks, syncedAt: nowIso() };
}

async function updatePage(
  client: NotionClient,
  state: NotionState,
  properties: Record<string, unknown>,
  items: Item[],
): Promise<NotionState> {
  const pageId = state.pageId;
  await client.request('PATCH', `/pages/${pageId}`, { properties });
  const blocks: NotionState['blocks'] = { ...state.blocks };
  const wanted = new Map(items.map((i) => [i.key, i]));

  for (const [key, ref] of Object.entries(blocks)) {
    const item = wanted.get(key);
    if (item && item.hash === ref.hash) continue;
    if (item?.editable) {
      const { type } = item.block as { type: string };
      try {
        const content = { ...(item.block as Record<string, any>)[type] };
        delete content.children;
        await client.request('PATCH', `/blocks/${ref.id}`, { [type]: content });
        blocks[key] = { id: ref.id, hash: item.hash };
        continue;
      } catch (err) {
        if (!(err instanceof NotionError && (err.status === 400 || err.status === 404))) throw err;
      }
    }
    await deleteBlock(client, ref.id);
    delete blocks[key];
  }

  // Insert missing items after their predecessor so Notion keeps page order.
  let prev: string | undefined;
  let run: Item[] = [];
  let runAfter: string | undefined;
  const flush = async () => {
    if (!run.length) return;
    const ids = await append(client, pageId, run.map((r) => r.block), runAfter);
    run.forEach((item, i) => {
      const id = ids[i];
      if (id) blocks[item.key] = { id, hash: item.hash };
    });
    prev = ids[ids.length - 1] ?? prev;
    run = [];
  };
  for (const item of items) {
    const existing = blocks[item.key];
    if (existing) {
      await flush();
      prev = existing.id;
      continue;
    }
    if (!run.length) runAfter = prev;
    run.push(item);
    if (run.length === MAX_CHILDREN) await flush();
  }
  await flush();
  return { ...state, blocks, syncedAt: nowIso() };
}

/**
 * Creates or updates the Notion page mirroring `page`. Returns the new sync
 * state to store with the page. Only changed highlights are rewritten.
 */
export async function syncPageToNotion(
  client: NotionClient,
  databaseId: string,
  page: Page,
  opts: SyncOptions,
  schema?: Schema,
): Promise<NotionState> {
  const s = schema ?? (await ensureSchema(client, databaseId));
  const tags = [...new Set([...page.tags, ...page.annotations.flatMap((a) => a.tags)])];
  const properties = buildProperties(page, s, tags);
  const items = buildItems(page, opts);

  let state = page.notion;
  if (state) {
    try {
      const existing = await client.request<{ archived?: boolean; in_trash?: boolean; parent?: { database_id?: string } }>(
        'GET',
        `/pages/${state.pageId}`,
      );
      if (existing.archived || existing.in_trash || !sameId(existing.parent?.database_id, databaseId)) state = undefined;
    } catch (err) {
      if (err instanceof NotionError && (err.status === 404 || err.status === 400)) state = undefined;
      else throw err;
    }
  }
  return state ? updatePage(client, state, properties, items) : createPage(client, databaseId, properties, items);
}

/** Checks the token and database before saving settings. */
export async function testConnection(client: NotionClient, databaseId: string): Promise<string> {
  const db = await client.request<{ title?: { plain_text?: string }[] }>('GET', `/databases/${databaseId}`);
  return db.title?.map((t) => t.plain_text ?? '').join('') || 'Untitled database';
}
