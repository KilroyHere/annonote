import { mathPattern } from './quote';

/**
 * Builds a URL text fragment (`#:~:text=`) so that opening the link scrolls to
 * and highlights the passage in Chromium-based browsers, without the extension.
 * https://wicg.github.io/scroll-to-text-fragment/
 */

const WORDS_FOR_RANGE = 5;
const MAX_SINGLE_TERM = 80;

function encodeTerm(term: string): string {
  return encodeURIComponent(term).replace(/-/g, '%2D').replace(/,/g, '%2C').replace(/&/g, '%26');
}

function firstWords(text: string, n: number): string {
  return text.split(' ').slice(0, n).join(' ');
}

function lastWords(text: string, n: number): string {
  const words = text.split(' ');
  return words.slice(Math.max(0, words.length - n)).join(' ');
}

export function textFragmentDirective(exact: string): string | null {
  // Text fragments cannot match across block boundaries with a single term,
  // so a quote spanning paragraphs becomes a start,end range.
  // Math is shown as TeX in quotes but rendered differently on the page, so it can't be
  // matched: treat each formula as a break and match the text around it.
  const lines = exact
    .replace(mathPattern(), '\n')
    .replace(/\uFFFC/g, '\n')
    .split(/\n+/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const first = lines[0]!;
  const last = lines[lines.length - 1]!;
  if (lines.length === 1 && (first.length <= MAX_SINGLE_TERM || first.split(' ').length <= WORDS_FOR_RANGE * 2)) {
    return `text=${encodeTerm(first)}`;
  }
  const start = firstWords(first, WORDS_FOR_RANGE);
  const end = lastWords(last, WORDS_FOR_RANGE);
  return `text=${encodeTerm(start)},${encodeTerm(end)}`;
}

/** True if a quote has text a browser can find on the page (not only math or images). */
export function hasTextFragment(exact: string): boolean {
  return textFragmentDirective(exact) !== null;
}

export function textFragmentUrl(pageUrl: string, exact: string): string {
  const directive = textFragmentDirective(exact);
  let base = pageUrl;
  const hashAt = base.indexOf('#');
  if (hashAt >= 0) base = base.slice(0, hashAt);
  return directive ? `${base}#:~:${directive}` : base;
}
