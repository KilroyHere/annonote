// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { anchor, buildTextMap, describe as describeRange } from '../../src/content/anchoring';

function selectText(container: Node, startText: string, endText: string): Range {
  const map = buildTextMap(container);
  const start = map.text.indexOf(startText);
  const end = map.text.indexOf(endText) + endText.length;
  const walk = (offset: number) => {
    for (let i = map.nodes.length - 1; i >= 0; i--) {
      if (map.starts[i]! <= offset) return { node: map.nodes[i]!, offset: offset - map.starts[i]! };
    }
    throw new Error('offset out of range');
  };
  const s = walk(start);
  const e = walk(end);
  const range = document.createRange();
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  return range;
}

describe('anchoring in the DOM', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <article>
        <h1>Title</h1>
        <p>First paragraph with <em>emphasis</em> and a <a href="#">link</a>.</p>
        <script>var ignored = "First paragraph";</script>
        <p>Second paragraph.</p>
      </article>`;
  });

  it('ignores script text', () => {
    expect(buildTextMap(document.body).text).not.toContain('ignored');
  });

  it('describes a selection that spans inline elements and finds it again', () => {
    const range = selectText(document.body, 'paragraph with', 'and a link');
    const desc = describeRange(buildTextMap(document.body), range)!;
    expect(desc.quote.exact).toBe('paragraph with emphasis and a link');
    expect(desc.quote.prefix.endsWith('First ')).toBe(true);

    const found = anchor(buildTextMap(document.body), [desc.quote, desc.position])!;
    expect(found.toString()).toBe('paragraph with emphasis and a link');
  });

  it('trims surrounding whitespace from a selection', () => {
    const p = document.querySelectorAll('p')[1]!;
    const range = document.createRange();
    range.selectNodeContents(p.parentElement!); // whole article, starting with whitespace
    const desc = describeRange(buildTextMap(document.body), range)!;
    expect(desc.quote.exact.startsWith('Title')).toBe(true);
    expect(desc.quote.exact.endsWith('Second paragraph.')).toBe(true);
  });

  it('handles boundary points between elements', () => {
    const article = document.querySelector('article')!;
    const range = document.createRange();
    const firstP = article.querySelector('p')!;
    range.setStart(firstP, 0);
    range.setEnd(firstP, firstP.childNodes.length);
    const desc = describeRange(buildTextMap(document.body), range)!;
    expect(desc.quote.exact).toBe('First paragraph with emphasis and a link.');
  });

  it('re-anchors after the page inserts content above the highlight', () => {
    const range = selectText(document.body, 'Second', 'paragraph.');
    const desc = describeRange(buildTextMap(document.body), range)!;
    const banner = document.createElement('div');
    banner.textContent = 'Cookie banner with lots of text. Second opinions welcome.';
    document.body.prepend(banner);
    const found = anchor(buildTextMap(document.body), [desc.quote, desc.position])!;
    expect(found.toString()).toBe('Second paragraph.');
    expect(found.startContainer.parentElement?.tagName).toBe('P');
  });

  it('returns null when the text was removed', () => {
    const range = selectText(document.body, 'Second', 'paragraph.');
    const desc = describeRange(buildTextMap(document.body), range)!;
    document.querySelectorAll('p')[1]!.remove();
    expect(anchor(buildTextMap(document.body), [desc.quote, desc.position])).toBeNull();
  });
});
