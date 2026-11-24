import type { Selector, TextPositionSelector, TextQuoteSelector } from '../shared/types';
import { locate } from './locate';

/** Text inside these elements is never part of the page text used for anchoring. */
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'textarea']);
const CONTEXT = 32;

/** The page's text as one string, with a map back to the DOM text nodes it came from. */
export interface TextMap {
  text: string;
  nodes: Text[];
  starts: number[];
  index: Map<Text, number>;
}

export function buildTextMap(root: Node): TextMap {
  const doc = root.ownerDocument ?? (root as Document);
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || SKIP.has(parent.localName)) return NodeFilter.FILTER_REJECT;
      return (node as Text).length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  const index = new Map<Text, number>();
  const parts: string[] = [];
  let offset = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    index.set(t, nodes.length);
    nodes.push(t);
    starts.push(offset);
    parts.push(t.data);
    offset += t.data.length;
  }
  return { text: parts.join(''), nodes, starts, index };
}

/** Converts a DOM boundary point to an offset in the page text. */
function toOffset(map: TextMap, node: Node, offset: number): number {
  if (node.nodeType === Node.TEXT_NODE) {
    const i = map.index.get(node as Text);
    if (i !== undefined) return map.starts[i]! + Math.min(offset, (node as Text).length);
  }
  // The point sits between elements (or in skipped text): use the first text node after it.
  const doc = node.ownerDocument ?? (node as Document);
  const point = doc.createRange();
  point.setStart(node, offset);
  let lo = 0;
  let hi = map.nodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (point.comparePoint(map.nodes[mid]!, 0) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo < map.nodes.length ? map.starts[lo]! : map.text.length;
}

/** Converts a text offset back to a DOM point. `isEnd` prefers the end of the previous node at boundaries. */
function toPoint(map: TextMap, offset: number, isEnd: boolean): { node: Text; offset: number } | null {
  const { nodes, starts } = map;
  if (!nodes.length) return null;
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const s = starts[mid]!;
    if (isEnd ? s < offset : s <= offset) lo = mid;
    else hi = mid - 1;
  }
  const node = nodes[lo]!;
  return { node, offset: Math.max(0, Math.min(offset - starts[lo]!, node.length)) };
}

export function rangeFromSpan(map: TextMap, start: number, end: number): Range | null {
  const s = toPoint(map, start, false);
  const e = toPoint(map, end, true);
  if (!s || !e) return null;
  const range = s.node.ownerDocument.createRange();
  range.setStart(s.node, s.offset);
  range.setEnd(e.node, e.offset);
  return range;
}

/** Describes a DOM range with W3C selectors (quote + position), trimming surrounding whitespace. */
export function describe(map: TextMap, range: Range): { quote: TextQuoteSelector; position: TextPositionSelector } | null {
  let start = toOffset(map, range.startContainer, range.startOffset);
  let end = toOffset(map, range.endContainer, range.endOffset);
  const { text } = map;
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  if (end <= start) return null;
  return {
    quote: {
      type: 'TextQuoteSelector',
      exact: text.slice(start, end),
      prefix: text.slice(Math.max(0, start - CONTEXT), start),
      suffix: text.slice(end, end + CONTEXT),
    },
    position: { type: 'TextPositionSelector', start, end },
  };
}

/** Finds the range an annotation refers to, or null if the text is no longer on the page. */
export function anchor(map: TextMap, selectors: Selector[]): Range | null {
  const quote = selectors.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector');
  if (!quote) return null;
  const pos = selectors.find((s): s is TextPositionSelector => s.type === 'TextPositionSelector');
  const span = locate(map.text, quote, pos);
  return span ? rangeFromSpan(map, span.start, span.end) : null;
}
