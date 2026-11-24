import { describe, expect, it } from 'vitest';
import { locate, similarity } from '../../src/content/locate';
import type { TextPositionSelector, TextQuoteSelector } from '../../src/shared/types';

const quote = (exact: string, prefix = '', suffix = ''): TextQuoteSelector => ({ type: 'TextQuoteSelector', exact, prefix, suffix });
const pos = (start: number, end: number): TextPositionSelector => ({ type: 'TextPositionSelector', start, end });

describe('locate', () => {
  const text = 'The quick brown fox jumps over the lazy dog. The quick brown fox sleeps.';

  it('uses the stored position when the text there is unchanged', () => {
    const start = text.indexOf('lazy dog');
    expect(locate(text, quote('lazy dog'), pos(start, start + 8))).toEqual({ start, end: start + 8 });
  });

  it('finds a unique exact match when the position moved', () => {
    const moved = `Intro paragraph added. ${text}`;
    const start = moved.indexOf('lazy dog');
    expect(locate(moved, quote('lazy dog'), pos(10, 18))).toEqual({ start, end: start + 8 });
  });

  it('uses prefix/suffix to choose between duplicate quotes', () => {
    const second = text.lastIndexOf('quick brown fox');
    const span = locate(text, quote('quick brown fox', 'lazy dog. The ', ' sleeps.'));
    expect(span).toEqual({ start: second, end: second + 'quick brown fox'.length });
  });

  it('finds the quote after small edits to the page wording', () => {
    const original = 'Attention lets each token look at every other token in the sequence.';
    const edited = 'Intro. Attention lets every token look at all other tokens in the sequence. Outro.';
    const span = locate(edited, quote(original, 'Intro. ', ' Outro.'));
    expect(span).not.toBeNull();
    expect(edited.slice(span!.start, span!.end)).toContain('Attention lets every token');
  });

  it('gives up when the passage is gone', () => {
    expect(locate(text, quote('an entirely different sentence that is not here'))).toBeNull();
  });

  it('does not fuzzy-match very short quotes', () => {
    expect(locate(text, quote('cat'))).toBeNull();
  });
});

describe('similarity', () => {
  it('is 1 for equal strings and lower for different ones', () => {
    expect(similarity('abc', 'abc')).toBe(1);
    expect(similarity('abc', 'abd')).toBeCloseTo(2 / 3);
    expect(similarity('', 'abc')).toBe(0);
  });
});
