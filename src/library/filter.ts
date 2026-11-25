import { displayQuote } from '../shared/quote';
import { allTags, byPosition, inFolder, type Annotation, type Page } from '../shared/types';

/** Folder selection meaning "pages that are not in any folder". */
export const UNFILED = '\u0000unfiled';

export interface Filtered {
  page: Page;
  annotations: Annotation[];
}

/** Pages in the selected folder (and its subfolders). `null` selects every page. */
export function pagesInFolder(pages: Page[], folder: string | null): Page[] {
  if (folder === null) return pages;
  if (folder === UNFILED) return pages.filter((p) => !p.folder);
  return pages.filter((p) => inFolder(p.folder, folder));
}

/** Every word of the query must appear somewhere in the text. */
function matches(haystack: string, words: string[]): boolean {
  const h = haystack.toLowerCase();
  return words.every((w) => h.includes(w));
}

/**
 * Applies the library filters. The folder narrows the pages first; the tag and the
 * search then work within that folder.
 */
export function filterPages(pages: Page[], query: string, tag: string | null, folder: string | null = null): Filtered[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: Filtered[] = [];
  for (const page of pagesInFolder(pages, folder)) {
    const sorted = [...page.annotations].sort(byPosition);
    const pageText = `${page.title} ${page.url} ${page.pageNote} ${page.tags.join(' ')} ${page.folder ?? ''}`;
    const pageMatchesQuery = words.length > 0 && matches(pageText, words);
    const pageHasTag = !!tag && page.tags.includes(tag);
    const annMatches = (a: Annotation) =>
      (!tag || pageHasTag || a.tags.includes(tag)) &&
      (!words.length || pageMatchesQuery || matches(`${displayQuote(a)} ${a.images?.map((i) => i.alt).join(' ') ?? ''} ${a.note} ${a.tags.join(' ')}`, words));
    const anns = sorted.filter(annMatches);
    const filtering = words.length > 0 || !!tag;
    if (!filtering) out.push({ page, annotations: sorted });
    else if (anns.length) out.push({ page, annotations: anns });
    else if ((pageMatchesQuery || pageHasTag) && (!tag || pageHasTag) && (!words.length || pageMatchesQuery)) {
      out.push({ page, annotations: [] });
    }
  }
  return out;
}

/** Tags used by the given pages, most used first, with the number of pages using each. */
export function tagCounts(pages: Page[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const p of pages) for (const t of allTags(p)) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Number of pages in each folder, counting pages in its subfolders too. */
export function folderCounts(pages: Page[], folders: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of folders) counts.set(f, pages.filter((p) => inFolder(p.folder, f)).length);
  return counts;
}
