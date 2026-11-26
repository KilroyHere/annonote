import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UNFILED, filterPages, folderCounts, tagCounts } from '../../src/library/filter';
import { markdownPath, pageToMarkdown } from '../../src/shared/markdown';
import { parseImport, toBackup } from '../../src/shared/backup';
import { splitMath } from '../../src/shared/quote';
import { textFragmentUrl } from '../../src/shared/textFragment';
import { folderAncestors, inFolder, normalizeFolder, type Annotation, type Page } from '../../src/shared/types';

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
        Object.assign(store, clone(items));
      },
      remove: async (key: string) => {
        delete store[key];
      },
    },
  },
});
const db = await import('../../src/background/db');

function ann(id: string, extra: Partial<Annotation> = {}): Annotation {
  return {
    id,
    created: '2026-11-20T10:00:00.000Z',
    updated: '2026-11-20T10:00:00.000Z',
    color: 'yellow',
    note: '',
    tags: [],
    selectors: [{ type: 'TextQuoteSelector', exact: `quote ${id}`, prefix: '', suffix: '' }],
    ...extra,
  };
}

function page(key: string, extra: Partial<Page> = {}): Page {
  return {
    key,
    url: key,
    title: key,
    created: '2026-11-20T10:00:00.000Z',
    updated: '2026-11-20T10:00:00.000Z',
    pageNote: '',
    tags: [],
    annotations: [ann(`${key}-1`)],
    ...extra,
  };
}

describe('folder paths', () => {
  it('normalizes typed names', () => {
    expect(normalizeFolder('  Research /  ML  papers / ')).toBe('Research/ML papers');
    expect(normalizeFolder('///')).toBe('');
    expect(folderAncestors('a/b/c')).toEqual(['a', 'a/b', 'a/b/c']);
    expect(inFolder('a/b', 'a')).toBe(true);
    expect(inFolder('ab', 'a')).toBe(false);
    expect(inFolder(undefined, 'a')).toBe(false);
  });
});

describe('library filters', () => {
  const pages = [
    page('https://a.test/1', { folder: 'Research/ML', tags: ['ml'], annotations: [ann('1', { tags: ['to-read'] })] }),
    page('https://a.test/2', { folder: 'Research', annotations: [ann('2', { tags: ['to-read'] })] }),
    page('https://a.test/3', { folder: 'Cooking', annotations: [ann('3', { tags: ['to-read'] })] }),
    page('https://a.test/4'),
  ];

  it('a folder includes its subfolders; "not in a folder" selects the rest', () => {
    expect(filterPages(pages, '', null, 'Research').map((f) => f.page.key)).toEqual(['https://a.test/1', 'https://a.test/2']);
    expect(filterPages(pages, '', null, 'Research/ML').map((f) => f.page.key)).toEqual(['https://a.test/1']);
    expect(filterPages(pages, '', null, UNFILED).map((f) => f.page.key)).toEqual(['https://a.test/4']);
    expect(filterPages(pages, '', null, null)).toHaveLength(4);
  });

  it('tags filter within the selected folder', () => {
    expect(filterPages(pages, '', 'to-read', null)).toHaveLength(3);
    expect(filterPages(pages, '', 'to-read', 'Research').map((f) => f.page.key)).toEqual(['https://a.test/1', 'https://a.test/2']);
    expect(filterPages(pages, '', 'to-read', 'Cooking').map((f) => f.page.key)).toEqual(['https://a.test/3']);
  });

  it('counts tags and folders', () => {
    expect(tagCounts(pages.slice(0, 2))).toEqual([
      ['to-read', 2],
      ['ml', 1],
    ]);
    expect(Object.fromEntries(folderCounts(pages, ['Cooking', 'Research', 'Research/ML']))).toEqual({ Cooking: 1, Research: 2, 'Research/ML': 1 });
  });
});

describe('folder storage', () => {
  beforeEach(() => {
    store = {};
  });

  it('lists created folders, folders in use and their parents', async () => {
    await db.addFolder('Empty');
    await db.saveAnnotation({ url: 'https://x.test/a', title: 'A' }, undefined, ann('a'));
    await db.movePages(['https://x.test/a'], 'Work/Projects');
    expect(await db.listFolders()).toEqual(['Empty', 'Work', 'Work/Projects']);
    expect((await db.getPage('https://x.test/a'))!.folder).toBe('Work/Projects');
  });

  it('renames a folder with its subfolders and pages', async () => {
    await db.saveAnnotation({ url: 'https://x.test/a', title: 'A' }, undefined, ann('a'));
    await db.saveAnnotation({ url: 'https://x.test/b', title: 'B' }, undefined, ann('b'));
    await db.movePages(['https://x.test/a'], 'Work');
    await db.movePages(['https://x.test/b'], 'Work/Old');
    expect(await db.renameFolder('Work', 'Job')).toEqual(['Job', 'Job/Old']);
    expect((await db.getPage('https://x.test/a'))!.folder).toBe('Job');
    expect((await db.getPage('https://x.test/b'))!.folder).toBe('Job/Old');
    await expect(db.renameFolder('Job', 'Job/Inner')).rejects.toThrow(/inside itself/);
  });

  it('deleting a folder keeps its pages and moves them up a level', async () => {
    await db.saveAnnotation({ url: 'https://x.test/a', title: 'A' }, undefined, ann('a'));
    await db.movePages(['https://x.test/a'], 'Work/Old');
    expect(await db.deleteFolder('Work/Old')).toEqual(['Work']);
    expect((await db.getPage('https://x.test/a'))!.folder).toBe('Work');
    await db.deleteFolder('Work');
    expect((await db.getPage('https://x.test/a'))!.folder).toBeUndefined();
  });

  it('tags on highlights (older data, imports) move up to the page', async () => {
    const saved = await db.saveAnnotation({ url: 'https://x.test/t', title: 'T' }, undefined, ann('t', { tags: ['ml', 'to-read'] }));
    expect(saved.tags).toEqual(['ml', 'to-read']);
    expect(saved.annotations[0]!.tags).toEqual([]);
    // A page stored by an older version is upgraded once.
    store['page:https://x.test/old'] = page('https://x.test/old', { tags: ['a'], annotations: [ann('o', { tags: ['a', 'b'] })] });
    expect(await db.migrate()).toBe(1);
    const old = (await db.getPage('https://x.test/old'))!;
    expect(old.tags).toEqual(['a', 'b']);
    expect(old.annotations[0]!.tags).toEqual([]);
    expect(await db.migrate()).toBe(0);
  });

  it('a page can be filed before it has highlights, and is kept', async () => {
    const saved = await db.updatePage(undefined, { url: 'https://x.test/new', title: 'New' }, { folder: 'Inbox' });
    expect(saved?.folder).toBe('Inbox');
    expect(await db.getPage('https://x.test/new')).toBeTruthy();
    // Taking it out of the folder leaves an empty record, which is removed.
    expect(await db.updatePage('https://x.test/new', undefined, { folder: '' })).toBeNull();
  });
});

describe('exports with math, images and folders', () => {
  const p = page('https://example.com/diffusion', {
    title: 'Diffusion',
    folder: 'Physics/Notes',
    annotations: [
      ann('m', { text: 'The heat equation $u_t = \\alpha u_{xx}$ describes heat.' }),
      ann('i', {
        selectors: [{ type: 'TextQuoteSelector', exact: '￼', prefix: 'before ', suffix: 'Figure 1' }],
        images: [{ src: 'https://example.com/plot.png', alt: 'Profiles' }],
      }),
    ],
  });

  it('Markdown keeps TeX, embeds images and records the folder', () => {
    const md = pageToMarkdown(p, { highlightLinks: true });
    expect(md).toContain('folder: "Physics/Notes"');
    expect(md).toContain('> The heat equation $u_t = \\alpha u_{xx}$ describes heat.');
    expect(md).toContain('> ![Profiles](<https://example.com/plot.png>)');
    // Image-only highlights get no (useless) jump link; math is skipped in the one for text.
    expect(md.match(/jump to highlight/g)).toHaveLength(1);
    expect(md).toContain('#:~:text=The%20heat%20equation,describes%20heat.');
    expect(markdownPath(p, 'Diffusion.md')).toBe('Physics/Notes/Diffusion.md');
  });

  it('backups keep images and folders', () => {
    const { pages } = parseImport(JSON.parse(JSON.stringify(toBackup([p]))));
    expect(pages[0]!.folder).toBe('Physics/Notes');
    expect(pages[0]!.annotations.find((a) => a.id === 'i')!.images).toEqual([{ src: 'https://example.com/plot.png', alt: 'Profiles' }]);
  });

  it('only TeX-like dollar spans count as math', () => {
    expect(splitMath('costs $5 and $10 today').every((part) => !part.math)).toBe(true);
    expect(splitMath('so $x^2$ and $$y$$')).toEqual([
      { text: 'so ', math: false, display: false },
      { text: 'x^2', math: true, display: false },
      { text: ' and ', math: false, display: false },
      { text: 'y', math: true, display: true },
    ]);
    expect(textFragmentUrl('https://e.com/', 'Let $x$ be')).toBe('https://e.com/#:~:text=Let,be');
  });
});
