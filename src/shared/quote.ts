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
  // U+FFFC stands in for an image in the page text; images are shown separately.
  return quoteOf(a).exact.replace(/\uFFFC/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A short label for a highlight, for places that need some text (e.g. an image-only highlight). */
export function quoteLabel(a: Annotation): string {
  const q = displayQuote(a);
  if (q) return q;
  const alt = a.images?.find((i) => i.alt)?.alt;
  return alt ? `Image: ${alt}` : 'Image';
}

/**
 * $$display$$ and $inline$ TeX. Like Pandoc and Obsidian, an inline opening $ must be
 * followed by a non-space and the closing $ preceded by one and not followed by a digit,
 * so prices such as "$5 and $10" are not taken for math.
 */
export function mathPattern(): RegExp {
  return /\$\$([^$]+?)\$\$|\$(?=\S)([^$\n]*?\S)\$(?!\d)/g;
}

/** Splits a quote into text and $TeX$ / $$TeX$$ pieces so math can be styled. */
export function splitMath(quote: string): { text: string; math: boolean; display: boolean }[] {
  const out: { text: string; math: boolean; display: boolean }[] = [];
  const re = mathPattern();
  let last = 0;
  for (let m = re.exec(quote); m; m = re.exec(quote)) {
    if (m.index > last) out.push({ text: quote.slice(last, m.index), math: false, display: false });
    out.push({ text: (m[1] ?? m[2])!, math: true, display: m[1] !== undefined });
    last = m.index + m[0].length;
  }
  if (last < quote.length) out.push({ text: quote.slice(last), math: false, display: false });
  return out;
}
