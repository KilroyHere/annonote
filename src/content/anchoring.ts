import type { AnnotationImage, Selector, TextPositionSelector, TextQuoteSelector } from '../shared/types';
import { atomAncestor, atomOf, type Atom } from './atoms';
import { locate } from './locate';

/** Text inside these elements is never part of the page text used for anchoring. */
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'textarea']);
const CONTEXT = 32;

/**
 * The page's text as one string, with a map back to the DOM nodes it came from.
 * Most segments are text nodes; math and images ("atoms") are single element
 * segments whose text is their TeX source or a placeholder character.
 */
export interface TextMap {
  text: string;
  nodes: (Text | Element)[];
  starts: number[];
  index: Map<Node, number>;
  atoms: Map<Element, Atom>;
}

export function buildTextMap(root: Node): TextMap {
  const nodes: (Text | Element)[] = [];
  const starts: number[] = [];
  const index = new Map<Node, number>();
  const atoms = new Map<Element, Atom>();
  const parts: string[] = [];
  let offset = 0;
  const add = (node: Text | Element, text: string) => {
    index.set(node, nodes.length);
    nodes.push(node);
    starts.push(offset);
    parts.push(text);
    offset += text.length;
  };

  // Iterative depth-first walk in document order; atoms and skipped elements are not entered.
  const stack: Node[] = [];
  for (let c = root.lastChild; c; c = c.previousSibling) stack.push(c);
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeType === Node.TEXT_NODE) {
      if ((node as Text).length) add(node as Text, (node as Text).data);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as Element;
    if (SKIP.has(el.localName)) continue;
    const atom = atomOf(el);
    if (atom) {
      atoms.set(el, atom);
      if (atom.text) add(el, atom.text);
      continue;
    }
    for (let c = el.lastChild; c; c = c.previousSibling) stack.push(c);
  }
  return { text: parts.join(''), nodes, starts, index, atoms };
}

function segmentLength(map: TextMap, i: number): number {
  return (i + 1 < map.starts.length ? map.starts[i + 1]! : map.text.length) - map.starts[i]!;
}

/** Converts a DOM boundary point to an offset in the page text. Points inside an atom snap to its edges. */
function toOffset(map: TextMap, node: Node, offset: number, isEnd: boolean): number {
  const atom = atomAncestor(node);
  if (atom) {
    const i = map.index.get(atom);
    if (i !== undefined) return map.starts[i]! + (isEnd ? segmentLength(map, i) : 0);
    // An atom with no text (e.g. empty math): treat the point as sitting just before it.
    node = atom.parentNode ?? atom;
    offset = atom.parentNode ? [...atom.parentNode.childNodes].indexOf(atom as ChildNode) + (isEnd ? 1 : 0) : 0;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    const i = map.index.get(node);
    if (i !== undefined) return map.starts[i]! + Math.min(offset, (node as Text).length);
  }
  // The point sits between elements (or in skipped text): use the first segment after it.
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

/** Finds the segment holding a text offset. `isEnd` prefers the previous segment at boundaries. */
function segmentAt(map: TextMap, offset: number, isEnd: boolean): number {
  const { starts } = map;
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const s = starts[mid]!;
    if (isEnd ? s < offset : s <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function rangeFromSpan(map: TextMap, start: number, end: number): Range | null {
  if (!map.nodes.length) return null;
  const si = segmentAt(map, start, false);
  const ei = segmentAt(map, end, true);
  const sNode = map.nodes[si]!;
  const eNode = map.nodes[ei]!;
  const range = sNode.ownerDocument!.createRange();
  if (sNode.nodeType === Node.TEXT_NODE) {
    range.setStart(sNode, Math.max(0, Math.min(start - map.starts[si]!, (sNode as Text).length)));
  } else if (start < map.starts[si]! + segmentLength(map, si)) {
    range.setStartBefore(sNode);
  } else {
    range.setStartAfter(sNode);
  }
  if (eNode.nodeType === Node.TEXT_NODE) {
    range.setEnd(eNode, Math.max(0, Math.min(end - map.starts[ei]!, (eNode as Text).length)));
  } else if (end > map.starts[ei]!) {
    range.setEndAfter(eNode);
  } else {
    range.setEndBefore(eNode);
  }
  return range;
}

/** Describes a DOM range with W3C selectors (quote + position), trimming surrounding whitespace. */
export function describe(map: TextMap, range: Range): { quote: TextQuoteSelector; position: TextPositionSelector } | null {
  let start = toOffset(map, range.startContainer, range.startOffset, false);
  let end = toOffset(map, range.endContainer, range.endOffset, true);
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

/** True if any math or image falls inside the span. */
export function spanHasAtoms(map: TextMap, start: number, end: number): boolean {
  for (let i = segmentAt(map, start, false); i < map.nodes.length && map.starts[i]! < end; i++) {
    if (map.atoms.has(map.nodes[i] as Element)) return true;
  }
  return false;
}

const BLOCK = 'p, div, li, ul, ol, dl, dt, dd, h1, h2, h3, h4, h5, h6, blockquote, pre, figure, figcaption, table, tr, td, th, section, article, header, footer, aside, main, nav, details, summary, hr';

function blockOf(node: Node): Element | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element).parentElement : node.parentElement;
  return el?.closest(BLOCK) ?? null;
}

/**
 * The span as readable text: math as $TeX$ (display math on its own line),
 * images left out of the text and returned separately, paragraph breaks kept.
 */
export function renderSpan(map: TextMap, start: number, end: number): { text: string; images: AnnotationImage[] } {
  const out: string[] = [];
  const images: AnnotationImage[] = [];
  let lastBlock: Element | null | undefined;
  for (let i = segmentAt(map, start, false); i < map.nodes.length && map.starts[i]! < end; i++) {
    const node = map.nodes[i]!;
    const block = blockOf(node);
    if (lastBlock !== undefined && block !== lastBlock) out.push('\n\n');
    lastBlock = block;
    const atom = map.atoms.get(node as Element);
    if (atom?.kind === 'image') {
      images.push({ ...(atom.src ? { src: atom.src } : {}), alt: atom.alt ?? '' });
    } else if (atom?.kind === 'math') {
      out.push(atom.display ? `\n\n${atom.text}\n\n` : atom.text);
    } else {
      const s = map.starts[i]!;
      const data = (node as Text).data;
      out.push(data.slice(Math.max(0, start - s), Math.min(data.length, end - s)).replace(/\s+/g, ' '));
    }
  }
  return { text: out.join(''), images };
}
