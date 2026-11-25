import { describe, expect, it } from 'vitest';
import { NotionClient, NotionError, parseDatabaseId, syncPageToNotion } from '../../src/shared/notion';
import type { Annotation, Page } from '../../src/shared/types';

const DB = '11111111-2222-3333-4444-555555555555';

interface Block {
  id: string;
  type: string;
  data: Record<string, unknown>;
  children: string[];
  archived: boolean;
  parent: string;
}

/** A small in-memory stand-in for the parts of the Notion API that Annonote uses. */
class FakeNotion {
  db = { properties: { Name: { type: 'title' } } as Record<string, { type: string }>, title: [{ plain_text: 'Reading' }] };
  pages = new Map<string, { archived: boolean; properties: unknown; children: string[]; database: string }>();
  blocks = new Map<string, Block>();
  calls: { method: string; path: string; body?: any }[] = [];
  failNext: number[] = [];
  private seq = 0;

  private id(prefix: string) {
    return `${prefix}-${++this.seq}`;
  }

  private addBlocks(parent: string, specs: any[]): string[] {
    return specs.map((spec) => {
      const id = this.id('blk');
      const { children = [], ...data } = spec[spec.type] ?? {};
      this.blocks.set(id, { id, type: spec.type, data, children: [], archived: false, parent });
      this.blocks.get(id)!.children = this.addBlocks(id, children);
      return id;
    });
  }

  private childList(id: string): string[] {
    return this.pages.get(id)?.children ?? this.blocks.get(id)?.children ?? [];
  }

  visible(pageId: string): Block[] {
    return this.childList(pageId).map((id) => this.blocks.get(id)!).filter((b) => !b.archived);
  }

  fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const path = url.replace('https://api.notion.com/v1', '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body as string) : undefined;
    this.calls.push({ method, path, body });
    const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
    const fail = this.failNext.shift();
    if (fail) return json(fail, { message: 'rate limited', code: 'rate_limited' });

    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/databases\/([^/?]+)$/))) {
      if (m[1] !== DB) return json(404, { message: 'Could not find database', code: 'object_not_found' });
      if (method === 'PATCH') Object.assign(this.db.properties, Object.fromEntries(Object.entries(body.properties).map(([k, v]) => [k, { type: Object.keys(v as object)[0]! }])));
      return json(200, { id: DB, ...this.db });
    }
    if (path === '/pages' && method === 'POST') {
      const id = this.id('page');
      this.pages.set(id, { archived: false, properties: body.properties, children: [], database: body.parent.database_id });
      this.pages.get(id)!.children = this.addBlocks(id, body.children ?? []);
      return json(200, { id, url: `https://www.notion.so/${id}` });
    }
    if ((m = path.match(/^\/pages\/([^/?]+)$/))) {
      const page = this.pages.get(m[1]!);
      if (!page) return json(404, { message: 'Could not find page', code: 'object_not_found' });
      if (method === 'PATCH') page.properties = body.properties;
      return json(200, { id: m[1], archived: page.archived, parent: { type: 'database_id', database_id: page.database } });
    }
    if ((m = path.match(/^\/blocks\/([^/?]+)\/children/))) {
      const parent = m[1]!;
      const list = this.childList(parent);
      if (method === 'GET') {
        return json(200, { results: this.visible(parent).map((b) => ({ id: b.id, type: b.type })), has_more: false, next_cursor: null });
      }
      const ids = this.addBlocks(parent, body.children);
      if (body.after) {
        const at = list.indexOf(body.after);
        if (at < 0 || this.blocks.get(body.after)?.archived) return json(400, { message: 'after block not found', code: 'validation_error' });
        list.splice(at + 1, 0, ...ids);
      } else {
        list.push(...ids);
      }
      return json(200, { results: ids.map((id) => ({ id })) });
    }
    if ((m = path.match(/^\/blocks\/([^/?]+)$/))) {
      const block = this.blocks.get(m[1]!);
      if (!block) return json(404, { message: 'Could not find block', code: 'object_not_found' });
      if (method === 'DELETE') {
        block.archived = true;
        return json(200, { id: block.id, archived: true });
      }
      if (method === 'PATCH') {
        if (block.archived) return json(400, { message: "Can't edit block that is archived.", code: 'validation_error' });
        block.data = body[block.type];
        return json(200, { id: block.id });
      }
    }
    return json(400, { message: `Unhandled ${method} ${path}` });
  };
}

function ann(id: string, exact: string, start: number, extra: Partial<Annotation> = {}): Annotation {
  return {
    id,
    created: '2026-11-20T10:00:00.000Z',
    updated: '2026-11-20T10:00:00.000Z',
    color: 'yellow',
    note: '',
    tags: [],
    selectors: [
      { type: 'TextQuoteSelector', exact, prefix: '', suffix: '' },
      { type: 'TextPositionSelector', start, end: start + exact.length },
    ],
    ...extra,
  };
}

function basePage(): Page {
  return {
    key: 'https://example.com/a',
    url: 'https://example.com/a',
    title: 'An article',
    created: '2026-11-20T10:00:00.000Z',
    updated: '2026-11-20T10:00:00.000Z',
    pageNote: 'Overall thoughts',
    tags: ['ml'],
    annotations: [ann('a', 'First quote', 100, { note: 'Note A' }), ann('b', 'Second quote', 500, { color: 'blue', tags: ['x'] })],
  };
}

const opts = { highlightLinks: true };
const quoteText = (b: Block) => ((b.data.rich_text as { text: { content: string } }[]) ?? []).map((r) => r.text.content).join('');

function setup() {
  const fake = new FakeNotion();
  const client = new NotionClient('secret', { fetch: fake.fetch, sleep: async () => undefined, minGapMs: 0 });
  return { fake, client };
}

describe('syncPageToNotion', () => {
  it('creates a page with properties, a source line, the page note and one quote per highlight', async () => {
    const { fake, client } = setup();
    const state = await syncPageToNotion(client, DB, basePage(), opts);

    expect(Object.keys(fake.db.properties).sort()).toEqual(['Name', 'Saved', 'Tags', 'URL']);
    const page = fake.pages.get(state.pageId)!;
    expect(page.properties).toMatchObject({
      Name: { title: [{ text: { content: 'An article' } }] },
      URL: { url: 'https://example.com/a' },
      Tags: { multi_select: [{ name: 'ml' }, { name: 'x' }] },
    });
    const blocks = fake.visible(state.pageId);
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'callout', 'quote', 'quote']);
    expect(quoteText(blocks[2]!)).toBe('First quote ↗');
    expect(blocks[3]!.data.color).toBe('blue_background');
    expect(Object.keys(state.blocks)).toEqual(['__source', '__pagenote', 'a', 'b']);
    // The note is nested under its quote.
    expect(blocks[2]!.children).toHaveLength(1);
  });

  it('on re-sync only rewrites what changed and keeps page order', async () => {
    const { fake, client } = setup();
    const page = basePage();
    page.notion = await syncPageToNotion(client, DB, page, opts);
    const firstIds = { ...page.notion.blocks };

    page.annotations = [
      // 'a' deleted, 'b' edited, 'c' added between where a and b were
      { ...page.annotations[1]!, note: 'Now with a note' },
      ann('c', 'New middle quote', 300),
    ];
    fake.calls = [];
    const next = await syncPageToNotion(client, DB, page, opts);

    const blocks = fake.visible(next.pageId);
    expect(blocks.map((b) => (b.type === 'quote' ? quoteText(b) : b.type))).toEqual([
      'paragraph',
      'callout',
      'New middle quote ↗',
      'Second quote ↗',
    ]);
    expect(next.pageId).toBe(page.notion.pageId);
    expect(next.blocks.__source!.id).toBe(firstIds.__source!.id);
    expect(fake.blocks.get(firstIds.a!.id)!.archived).toBe(true);
    expect(fake.blocks.get(firstIds.b!.id)!.archived).toBe(true);
    expect(next.blocks.a).toBeUndefined();
    const appends = fake.calls.filter((c) => c.method === 'PATCH' && c.path.endsWith('/children'));
    expect(appends).toHaveLength(1);
    expect(appends[0]!.body.after).toBe(firstIds.__pagenote!.id);
  });

  it('does not touch blocks when nothing changed', async () => {
    const { fake, client } = setup();
    const page = basePage();
    page.notion = await syncPageToNotion(client, DB, page, opts);
    fake.calls = [];
    await syncPageToNotion(client, DB, page, opts);
    const writes = fake.calls.filter((c) => c.path.startsWith('/blocks'));
    expect(writes).toEqual([]);
  });

  it('edits the page note in place', async () => {
    const { fake, client } = setup();
    const page = basePage();
    page.notion = await syncPageToNotion(client, DB, page, opts);
    page.pageNote = 'Changed my mind';
    fake.calls = [];
    const next = await syncPageToNotion(client, DB, page, opts);
    expect(next.blocks.__pagenote!.id).toBe(page.notion.blocks.__pagenote!.id);
    expect(fake.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(quoteText(fake.blocks.get(next.blocks.__pagenote!.id)!)).toContain('Changed my mind');
  });

  it('recreates the page if it was deleted in Notion', async () => {
    const { fake, client } = setup();
    const page = basePage();
    page.notion = await syncPageToNotion(client, DB, page, opts);
    fake.pages.get(page.notion.pageId)!.archived = true;
    const next = await syncPageToNotion(client, DB, page, opts);
    expect(next.pageId).not.toBe(page.notion.pageId);
    expect(fake.visible(next.pageId)).toHaveLength(4);
  });

  it('retries when rate limited', async () => {
    const { fake, client } = setup();
    fake.failNext = [429, 503];
    const state = await syncPageToNotion(client, DB, basePage(), opts);
    expect(fake.visible(state.pageId)).toHaveLength(4);
  });

  it('reports a missing database clearly', async () => {
    const { client } = setup();
    await expect(syncPageToNotion(client, '99999999-9999-9999-9999-999999999999', basePage(), opts)).rejects.toBeInstanceOf(NotionError);
  });
});

describe('parseDatabaseId', () => {
  it('accepts links and ids', () => {
    const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const dashed = 'a1b2c3d4-e5f6-0718-293a-4b5c6d7e8f90';
    expect(parseDatabaseId(`https://www.notion.so/myteam/Reading-List-${hex}?v=0123456789abcdef0123456789abcdef`)).toBe(dashed);
    expect(parseDatabaseId(`https://www.notion.so/${hex}?v=1`)).toBe(dashed);
    expect(parseDatabaseId(dashed)).toBe(dashed);
    expect(parseDatabaseId(hex.toUpperCase())).toBe(dashed);
    expect(parseDatabaseId('not an id')).toBeNull();
  });
});
