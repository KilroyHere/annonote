import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Annotation, Page, PageMeta } from '../../src/shared/types';

// In-memory chrome.storage.local with copy-on-read/write, like the real thing.
let store: Record<string, unknown> = {};
const clone = <T>(v: T): T => structuredClone(v);
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: async (keys: string | null) => {
        if (keys === null) return clone(store);
        return keys in store ? { [keys]: clone(store[keys]) } : {};
      },
      set: async (items: Record<string, unknown>) => {
        await new Promise((r) => setTimeout(r, Math.random() * 3)); // interleave concurrent writers
        Object.assign(store, clone(items));
      },
      remove: async (key: string) => {
        delete store[key];
      },
    },
  },
});

const db = await import('../../src/background/db');

function ann(id: string, updated = '2026-11-20T10:00:00.000Z'): Annotation {
  return {
    id,
    created: '2026-11-20T10:00:00.000Z',
    updated,
    color: 'yellow',
    note: `note ${id}`,
    tags: [],
    selectors: [{ type: 'TextQuoteSelector', exact: `quote ${id}`, prefix: '', suffix: '' }],
  };
}

const meta = (url: string, extra: Partial<PageMeta> = {}): PageMeta => ({ url, title: 'Title', ...extra });

beforeEach(() => {
  store = {};
});

describe('page storage', () => {
  it('stores annotations under the normalized URL and finds them from URL variants', async () => {
    const page = await db.saveAnnotation(meta('https://example.com/post/?utm_source=x'), undefined, ann('1'));
    expect(page.key).toBe('https://example.com/post');
    expect((await db.findPage(meta('https://EXAMPLE.com/post#comments')))?.annotations).toHaveLength(1);
  });

  it('finds a page by canonical URL or DOI from a different address', async () => {
    await db.saveAnnotation(meta('https://example.com/story/1', { canonical: 'https://example.com/story/1', doi: '10.1234/ABC.5' }), undefined, ann('1'));
    expect(await db.findPage(meta('https://m.example.com/s/1', { canonical: 'https://example.com/story/1' }))).toBeDefined();
    expect(await db.findPage(meta('https://mirror.org/paper.html', { doi: 'https://doi.org/10.1234/abc.5' }))).toBeDefined();
    expect(await db.findPage(meta('https://other.com/x', { canonical: 'https://other.com/' }))).toBeUndefined();
  });

  it('does not lose writes when several tabs save at once', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => db.saveAnnotation(meta('https://example.com/a'), undefined, ann(String(i)))));
    expect((await db.getPage('https://example.com/a'))!.annotations).toHaveLength(12);
  });

  it('removes a page once its last highlight is deleted', async () => {
    await db.saveAnnotation(meta('https://example.com/a'), undefined, ann('1'));
    expect(await db.deleteAnnotation('https://example.com/a', '1')).toBeNull();
    expect(await db.listPages()).toEqual([]);
  });

  it('keeps a page that still has a page note', async () => {
    await db.saveAnnotation(meta('https://example.com/a'), undefined, ann('1'));
    await db.updatePage('https://example.com/a', undefined, { pageNote: 'keep me' });
    expect(await db.deleteAnnotation('https://example.com/a', '1')).not.toBeNull();
  });

  it('can create a page from just a page note', async () => {
    const page = await db.updatePage(undefined, meta('https://example.com/b'), { pageNote: 'Thoughts' });
    expect(page?.key).toBe('https://example.com/b');
    expect(page?.annotations).toEqual([]);
  });

  it('merges imports: adds new annotations, keeps the newer version of existing ones', async () => {
    await db.saveAnnotation(meta('https://example.com/a'), undefined, ann('1', '2026-11-20T10:00:00.000Z'));
    await db.saveAnnotation(meta('https://example.com/a'), undefined, ann('2', '2026-11-22T10:00:00.000Z'));
    const incoming: Page = {
      key: 'https://example.com/a',
      url: 'https://example.com/a',
      title: 'Title',
      created: '2026-11-01T00:00:00.000Z',
      updated: '2026-11-23T00:00:00.000Z',
      pageNote: 'From backup',
      tags: [],
      annotations: [
        { ...ann('1', '2026-11-21T10:00:00.000Z'), note: 'newer' },
        { ...ann('2', '2026-11-21T10:00:00.000Z'), note: 'older' },
        ann('3'),
      ],
    };
    const result = await db.importPages([incoming]);
    expect(result).toEqual({ pages: 1, added: 1, updated: 1 });
    const page = (await db.getPage('https://example.com/a'))!;
    expect(page.annotations.find((a) => a.id === '1')!.note).toBe('newer');
    expect(page.annotations.find((a) => a.id === '2')!.note).toBe('note 2');
    expect(page.pageNote).toBe('From backup');
  });
});
