import { allTags, byPosition, type AnnotationImage, type Page } from './types';
import { displayQuote } from './quote';
import { hostOf } from './url';
import { hasTextFragment, textFragmentUrl } from './textFragment';

export interface MarkdownOptions {
  highlightLinks: boolean;
}

function yamlString(value: string): string {
  // JSON strings are valid YAML double-quoted scalars.
  return JSON.stringify(value);
}

function blockquote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : '>'))
    .join('\n');
}

function tagList(tags: string[]): string {
  return tags.map((t) => `#${t.replace(/\s+/g, '-')}`).join(' ');
}

function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}

export function pageToMarkdown(page: Page, opts: MarkdownOptions): string {
  const tags = allTags(page);
  const front: string[] = ['---', `title: ${yamlString(page.title || page.url)}`, `url: ${yamlString(page.url)}`];
  const site = page.siteName || hostOf(page.url);
  if (site) front.push(`site: ${yamlString(site)}`);
  if (page.author) front.push(`author: ${yamlString(page.author)}`);
  if (page.published) front.push(`published: ${yamlString(page.published)}`);
  if (page.doi) front.push(`doi: ${yamlString(page.doi)}`);
  if (page.folder) front.push(`folder: ${yamlString(page.folder)}`);
  front.push(`saved: ${dateOnly(page.created)}`, `updated: ${dateOnly(page.updated)}`);
  front.push(tags.length ? `tags: [${tags.map(yamlString).join(', ')}]` : 'tags: []');
  front.push(`highlights: ${page.annotations.length}`, '---');

  const body: string[] = [`# ${page.title || page.url}`, '', `Source: <${page.url}>`];
  if (page.pageNote.trim()) body.push('', page.pageNote.trim());
  if (page.tags.length) body.push('', tagList(page.tags));

  const sorted = [...page.annotations].sort(byPosition);
  if (sorted.length) body.push('', '## Highlights');
  for (const a of sorted) {
    const quote = displayQuote(a);
    const images = (a.images ?? []).map(imageMarkdown);
    const parts = [quote, ...images].filter(Boolean);
    body.push('', blockquote(parts.join('\n\n') || 'Image'));
    if (opts.highlightLinks && hasTextFragment(quote)) body.push('>', `> [↗ jump to highlight](${textFragmentUrl(page.url, quote)})`);
    if (a.note.trim()) body.push('', a.note.trim());
    if (a.tags.length) body.push('', tagList(a.tags));
  }
  return `${front.join('\n')}\n\n${body.join('\n')}\n`;
}

function imageMarkdown(img: AnnotationImage): string {
  const alt = img.alt.replace(/[[\]\n]/g, ' ').trim();
  if (!img.src) return alt ? `*[image: ${alt}]*` : '*[image]*';
  return `![${alt}](<${img.src.replace(/>/g, '%3E')}>)`;
}

export function slugify(input: string, maxLength = 80): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
    .replace(/[\u0000-\u001f]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
    .trim();
  return slug || 'untitled';
}

/** Gives each page a unique, filesystem-safe Markdown filename. */
export function markdownFilenames(pages: Page[]): Map<string, string> {
  const used = new Set<string>();
  const names = new Map<string, string>();
  for (const page of pages) {
    const base = slugify(page.title || hostOf(page.url) || 'untitled');
    let name = `${base}.md`;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base} (${i}).md`;
    used.add(name.toLowerCase());
    names.set(page.key, name);
  }
  return names;
}

/** Path of a page's file inside a Markdown export: its folder (each level made filesystem-safe), then the file name. */
export function markdownPath(page: Page, filename: string): string {
  if (!page.folder) return filename;
  return [...page.folder.split('/').map((part) => slugify(part, 60)), filename].join('/');
}
