import search from 'approx-string-match';
import type { TextPositionSelector, TextQuoteSelector } from '../shared/types';

export interface Span {
  start: number;
  end: number;
}

const MAX_EXACT_HITS = 500;
const MIN_FUZZY_LENGTH = 8;
/** A fuzzy match must keep at least this share of the quote. */
const MIN_QUOTE_SCORE = 0.75;

/** Normalized edit-distance similarity in [0, 1]. Inputs here are short (prefix/suffix context). */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

function contextScore(text: string, span: Span, quote: TextQuoteSelector, pos?: TextPositionSelector): number {
  const before = text.slice(Math.max(0, span.start - quote.prefix.length), span.start);
  const after = text.slice(span.end, span.end + quote.suffix.length);
  const prefix = quote.prefix ? similarity(quote.prefix, before) : 1;
  const suffix = quote.suffix ? similarity(quote.suffix, after) : 1;
  const nearness = pos ? 1 - Math.min(1, Math.abs(span.start - pos.start) / Math.max(1, text.length)) : 0.5;
  return (20 * prefix + 20 * suffix + 2 * nearness) / 42;
}

/**
 * Finds where a quote now lives in the page text.
 *  1. The stored position, if the text there is unchanged.
 *  2. Exact matches of the quote (prefix/suffix decide between duplicates).
 *  3. Approximate matches, for pages whose wording changed slightly.
 */
export function locate(text: string, quote: TextQuoteSelector, pos?: TextPositionSelector): Span | null {
  const { exact } = quote;
  if (!exact) return null;

  if (pos && pos.end - pos.start === exact.length && text.slice(pos.start, pos.end) === exact) {
    return { start: pos.start, end: pos.end };
  }

  const hits: Span[] = [];
  for (let i = text.indexOf(exact); i !== -1 && hits.length < MAX_EXACT_HITS; i = text.indexOf(exact, i + 1)) {
    hits.push({ start: i, end: i + exact.length });
  }
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) {
    let best = hits[0]!;
    let bestScore = -1;
    for (const h of hits) {
      const s = contextScore(text, h, quote, pos);
      if (s > bestScore) {
        best = h;
        bestScore = s;
      }
    }
    return best;
  }

  if (exact.length < MIN_FUZZY_LENGTH) return null;
  const maxErrors = Math.min(256, Math.floor(exact.length / 4));
  const matches = search(text, exact, maxErrors);
  let best: Span | null = null;
  let bestScore = -1;
  for (const m of matches) {
    const quoteScore = 1 - m.errors / exact.length;
    if (quoteScore < MIN_QUOTE_SCORE) continue;
    const score = (50 * quoteScore + 42 * contextScore(text, m, quote, pos)) / 92;
    if (score > bestScore) {
      best = { start: m.start, end: m.end };
      bestScore = score;
    }
  }
  return best;
}
