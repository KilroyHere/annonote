import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseImport, toBackup } from '../../src/shared/backup';
import { markdownFilenames, pageToMarkdown, slugify } from '../../src/shared/markdown';
import { textFragmentUrl } from '../../src/shared/textFragment';
import type { Annotation, Page } from '../../src/shared/types';
import { cleanUrl, normalizeUrl, usableCanonical } from '../../src/shared/url';
import { createZip } from '../../src/shared/zip';

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

const page: Page = {
  key: 'https://example.com/article',
  url: 'https://example.com/article',
  title: 'How Transformers Work: a "guide"',
  siteName: 'Example',
  created: '2026-11-20T10:00:00.000Z',
  updated: '2026-11-21T10:00:00.000Z',
  pageNote: 'Great overview.',
  tags: ['ml'],
  annotations: [
    ann('b', 'Second highlight', 500, { color: 'green', note: 'Why quadratic?', tags: ['question', 'attention'] }),
    ann('a', 'Attention lets each token look at every other token.', 100),
  ],
};

describe('normalizeUrl', () => {
  it('drops tracking parameters and fragments, sorts the query', () => {
    expect(normalizeUrl('https://Example.com/a/?utm_source=x&b=2&a=1&fbclid=z#section')).toBe('https://example.com/a/?a=1&b=2');
    expect(normalizeUrl('https://example.com/post/')).toBe('https://example.com/post');
    expect(normalizeUrl('https://example.com:443/')).toBe('https://example.com/');
  });

  it('keeps single-page-app routes in the fragment', () => {
    expect(normalizeUrl('https://app.example.com/#/notes/42')).toBe('https://app.example.com/#/notes/42');
  });

  it('cleanUrl only removes tracking parameters and anchors', () => {
    expect(cleanUrl('https://Example.com/a/?utm_source=x&b=2&a=1#section')).toBe('https://example.com/a/?b=2&a=1');
    expect(cleanUrl('https://example.com/a?utm_medium=x')).toBe('https://example.com/a');
  });

  it('ignores canonical URLs that point at the home page', () => {
    expect(usableCanonical('https://example.com/', 'https://example.com/a')).toBeUndefined();
    expect(usableCanonical('/story/1?utm_medium=x', 'https://example.com/a')).toBe('https://example.com/story/1');
  });
});

describe('textFragmentUrl', () => {
  it('encodes short quotes as a single term, escaping dashes and commas', () => {
    expect(textFragmentUrl('https://e.com/a#top', 'well-known, really')).toBe('https://e.com/a#:~:text=well%2Dknown%2C%20really');
  });

  it('uses a start,end range for long or multi-paragraph quotes', () => {
    const url = textFragmentUrl('https://e.com/a', 'One two three four five six\n\nseven eight nine ten eleven twelve');
    expect(url).toBe('https://e.com/a#:~:text=One%20two%20three%20four%20five,eight%20nine%20ten%20eleven%20twelve');
  });
});

describe('pageToMarkdown', () => {
  const md = pageToMarkdown(page, { highlightLinks: true });

  it('writes YAML front matter with escaped strings and merged tags', () => {
    expect(md.startsWith('---\ntitle: "How Transformers Work: a \\"guide\\""\nurl: "https://example.com/article"')).toBe(true);
    expect(md).toContain('tags: ["attention", "ml", "question"]');
    expect(md).toContain('highlights: 2');
  });

  it('lists highlights in page order with notes, tags and jump links', () => {
    const first = md.indexOf('> Attention lets each token');
    const second = md.indexOf('> Second highlight');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(md).toContain('> [↗ jump to highlight](https://example.com/article#:~:text=Attention%20lets');
    expect(md).toContain('Why quadratic?\n\n#question #attention');
  });

  it('can leave out the links', () => {
    expect(pageToMarkdown(page, { highlightLinks: false })).not.toContain('jump to highlight');
  });

  it('prefers the rendered quote text, keeping paragraph breaks', () => {
    const p = { ...page, annotations: [ann('x', 'raw   text\n  with source whitespace', 1, { text: 'Para one.\n\nPara two.' })] };
    expect(pageToMarkdown(p, { highlightLinks: false })).toContain('> Para one.\n>\n> Para two.');
  });
});

describe('filenames', () => {
  it('makes safe, unique names', () => {
    expect(slugify('A/B: c? "d"')).toBe('A B c d');
    const names = markdownFilenames([
      { ...page, key: '1', title: 'Same' },
      { ...page, key: '2', title: 'same' },
    ]);
    expect([...names.values()]).toEqual(['Same.md', 'same (2).md']);
  });
});

describe('createZip', () => {
  it('produces an archive that unzip accepts', () => {
    const zip = createZip([
      { name: 'Notes.md', data: '# Hello\n' },
      { name: 'Ünïcödé (2).md', data: 'x'.repeat(5000) },
    ]);
    const dir = mkdtempSync(join(tmpdir(), 'gloss-zip-'));
    const file = join(dir, 'test.zip');
    writeFileSync(file, zip);
    let out: string;
    try {
      out = execFileSync('unzip', ['-t', file], { encoding: 'utf8' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // unzip not installed
      throw err;
    }
    expect(out).toContain('No errors detected');
    expect(execFileSync('unzip', ['-p', file, 'Notes.md'], { encoding: 'utf8' })).toBe('# Hello\n');
  });
});

describe('backup', () => {
  it('round-trips pages through the W3C backup format', () => {
    const backup = JSON.parse(JSON.stringify(toBackup([page])));
    expect(backup.type).toBe('AnnotationCollection');
    expect(backup.items[0].target.selector[0].type).toBe('TextQuoteSelector');
    const { source, pages } = parseImport(backup);
    expect(source).toBe('gloss');
    expect(pages).toHaveLength(1);
    const restored = pages[0]!;
    expect(restored.title).toBe(page.title);
    expect(restored.pageNote).toBe('Great overview.');
    expect(restored.annotations.map((a) => a.id).sort()).toEqual(['a', 'b']);
    const b = restored.annotations.find((a) => a.id === 'b')!;
    expect(b).toMatchObject({ color: 'green', note: 'Why quadratic?', tags: ['question', 'attention'] });
  });

  it('converts Hypothesis API rows, turning page notes into the page note and skipping replies', () => {
    const rows = [
      {
        id: 'h1',
        uri: 'https://example.com/paper?utm_source=tw',
        text: 'Interesting',
        tags: ['reading'],
        created: '2025-01-01T00:00:00Z',
        updated: '2025-01-02T00:00:00Z',
        document: { title: ['A Paper'] },
        target: [
          {
            source: 'https://example.com/paper',
            selector: [
              { type: 'RangeSelector', startContainer: '/p[1]', startOffset: 0, endContainer: '/p[1]', endOffset: 5 },
              { type: 'TextPositionSelector', start: 10, end: 20 },
              { type: 'TextQuoteSelector', exact: 'the result', prefix: 'We show ', suffix: ' holds.' },
            ],
          },
        ],
      },
      { id: 'h2', uri: 'https://example.com/paper', text: 'Whole-paper thought', tags: ['todo'], target: [{ source: 'x' }] },
      { id: 'h3', uri: 'https://example.com/paper', text: 'a reply', references: ['h1'], target: [{ selector: [] }] },
    ];
    const { source, pages } = parseImport({ total: 3, rows });
    expect(source).toBe('hypothesis');
    expect(pages).toHaveLength(1);
    const p = pages[0]!;
    expect(p.key).toBe('https://example.com/paper');
    expect(p.title).toBe('A Paper');
    expect(p.pageNote).toBe('Whole-paper thought');
    expect(p.tags).toEqual(['todo']);
    expect(p.annotations).toHaveLength(1);
    expect(p.annotations[0]).toMatchObject({ id: 'hypothesis-h1', note: 'Interesting', tags: ['reading'] });
    expect(p.annotations[0]!.selectors.map((s) => s.type)).toEqual(['TextPositionSelector', 'TextQuoteSelector']);
  });

  it('drops pages with non-web URLs from imported files', () => {
    const backup = JSON.parse(JSON.stringify(toBackup([{ ...page, key: 'javascript:alert(1)', url: 'javascript:alert(1)' }])));
    expect(parseImport(backup).pages).toEqual([]);
    expect(parseImport([{ id: 'x', uri: 'data:text/html,hi', target: [{ selector: [{ type: 'TextQuoteSelector', exact: 'hi' }] }] }]).pages).toEqual([]);
  });

  it('rejects files it does not understand', () => {
    expect(() => parseImport({ hello: 'world' })).toThrow(/Unrecognized/);
  });
});
