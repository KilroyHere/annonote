import { quoteOf, type Annotation } from './types';

/** Collapses the raw DOM text of a quote into readable text. */
export function cleanQuote(raw: string): string {
  return raw
    .replace(/\r/g, '')
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The quote as the reader saw it. `text` is captured from the selection when
 * the highlight is made (it keeps paragraph breaks); imported annotations fall
 * back to the stored exact quote with whitespace collapsed.
 */
export function displayQuote(a: Annotation): string {
  if (a.text?.trim()) return cleanQuote(a.text);
  return quoteOf(a).exact.replace(/\s+/g, ' ').trim();
}
