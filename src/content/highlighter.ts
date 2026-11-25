import { COLORS, type Color } from '../shared/types';
import { ATOM_QUERY, atomAncestor, isAtom } from './atoms';

interface Entry {
  range: Range;
  color: Color;
  /** The highlight minus its atoms: what the CSS Custom Highlight API paints. */
  textRanges: Range[];
  /** Math and images inside the highlight, painted with overlay boxes. */
  atoms: Element[];
}

/** Outermost math/image elements that a range covers, in document order. */
export function atomsInRange(range: Range): Element[] {
  const root = range.commonAncestorContainer;
  const el = root.nodeType === Node.ELEMENT_NODE ? (root as Element) : root.parentElement;
  if (!el) return [];
  const self = atomAncestor(el);
  if (self) return [self];
  return [...el.querySelectorAll(ATOM_QUERY)].filter(
    (a) => isAtom(a) && !atomAncestor(a.parentElement ?? a, el) && range.intersectsNode(a),
  );
}

function splitAround(range: Range, atoms: Element[]): Range[] {
  if (!atoms.length) return [range];
  const out: Range[] = [];
  let cur = range.cloneRange();
  for (const atom of atoms) {
    const piece = cur.cloneRange();
    piece.setEndBefore(atom);
    if (!piece.collapsed) out.push(piece);
    cur = cur.cloneRange();
    cur.setStartAfter(atom);
    if (cur.compareBoundaryPoints(Range.END_TO_END, range) > 0) cur.setEnd(range.endContainer, range.endOffset);
  }
  if (!cur.collapsed) out.push(cur);
  return out;
}

/** The box to draw for an atom: the formula itself rather than its full-width display wrapper. */
function atomRect(atom: Element): DOMRect {
  const inner = atom.matches('.katex-display') ? atom.querySelector('.katex') : atom.matches('mjx-container') ? atom.querySelector('mjx-math, svg') : null;
  return (inner ?? atom).getBoundingClientRect();
}

/**
 * Paints highlights with the CSS Custom Highlight API. Unlike wrapping text in
 * <mark> elements, this never changes the page's DOM, so it cannot break the
 * page's own scripts or layout. Styles for ::highlight(annonote-*) live in highlights.css.
 *
 * Math and images have no text to paint, so they get translucent boxes drawn in
 * the extension's own shadow root (never in the page) and kept in place on scroll.
 */
export class Highlighter {
  private readonly entries = new Map<string, Entry>();
  private active: string | null = null;
  private flashTimer: number | undefined;
  private layer: (() => HTMLElement) | null = null;
  private boxes: HTMLElement[] = [];
  private frame = 0;
  private resizeObserver: ResizeObserver | null = null;

  /** Where overlay boxes go (created on first use). */
  setLayer(layer: () => HTMLElement): void {
    this.layer = layer;
  }

  set(id: string, range: Range, color: Color): void {
    const atoms = atomsInRange(range);
    this.entries.set(id, { range, color, atoms, textRanges: splitAround(range, atoms) });
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  range(id: string): Range | undefined {
    return this.entries.get(id)?.range;
  }

  /** First element of the highlight, for scrolling to it. */
  element(id: string): Element | null {
    const e = this.entries.get(id);
    if (!e) return null;
    const start = e.range.startContainer;
    const node = start.nodeType === Node.ELEMENT_NODE ? (start.childNodes[e.range.startOffset] ?? start) : start;
    return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  }

  /** The highlight that covers this math or image element, if any. */
  idForAtom(atom: Element): string | null {
    for (const [id, e] of this.entries) if (e.atoms.includes(atom)) return id;
    return null;
  }

  setColor(id: string, color: Color): void {
    const entry = this.entries.get(id);
    if (entry) entry.color = color;
  }

  delete(id: string): void {
    this.entries.delete(id);
    if (this.active === id) this.active = null;
  }

  clear(): void {
    this.entries.clear();
    this.active = null;
  }

  setActive(id: string | null): void {
    this.active = id;
    this.render();
  }

  flash(id: string): void {
    this.setActive(id);
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => {
      if (this.active === id) this.setActive(null);
    }, 1600);
  }

  render(): void {
    if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
      for (const color of COLORS) {
        const ranges = [...this.entries.values()].filter((r) => r.color === color).flatMap((r) => r.textRanges);
        if (ranges.length) CSS.highlights.set(`annonote-${color}`, new Highlight(...ranges));
        else CSS.highlights.delete(`annonote-${color}`);
      }
      const active = this.active ? this.entries.get(this.active) : undefined;
      if (active?.textRanges.length) {
        const h = new Highlight(...active.textRanges);
        h.priority = 10;
        CSS.highlights.set('annonote-active', h);
      } else {
        CSS.highlights.delete('annonote-active');
      }
    }
    this.watchLayout();
    this.positionBoxes();
  }

  /** Moves overlay boxes after scrolling, resizing or layout changes (batched per frame). */
  reposition(): void {
    if (this.frame || !this.boxes.length) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.positionBoxes();
    });
  }

  private watchLayout(): void {
    const atoms = [...this.entries.values()].flatMap((e) => e.atoms);
    if (!atoms.length) {
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      return;
    }
    if (typeof ResizeObserver === 'undefined') return;
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => this.reposition());
    this.resizeObserver.observe(document.documentElement);
    for (const a of atoms) this.resizeObserver.observe(a);
  }

  private positionBoxes(): void {
    const wanted: { rect: DOMRect; color: Color; active: boolean }[] = [];
    for (const [id, e] of this.entries) {
      for (const atom of e.atoms) {
        if (!atom.isConnected) continue;
        const rect = atomRect(atom);
        if (rect.width < 1 || rect.height < 1) continue;
        if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) continue;
        wanted.push({ rect, color: e.color, active: id === this.active });
      }
    }
    if (!wanted.length && !this.boxes.length) return;
    const layer = this.layer?.();
    if (!layer) return;
    while (this.boxes.length < wanted.length) {
      const box = document.createElement('div');
      layer.appendChild(box);
      this.boxes.push(box);
    }
    this.boxes.forEach((box, i) => {
      const w = wanted[i];
      if (!w) {
        box.hidden = true;
        return;
      }
      box.hidden = false;
      box.className = `g-overlay g-overlay-${w.color}${w.active ? ' is-active' : ''}`;
      box.style.left = `${w.rect.left - 2}px`;
      box.style.top = `${w.rect.top - 2}px`;
      box.style.width = `${w.rect.width + 4}px`;
      box.style.height = `${w.rect.height + 4}px`;
    });
  }

  /** Returns the id of the highlight under a viewport point, preferring the smallest one. */
  hitTest(x: number, y: number): string | null {
    let best: string | null = null;
    let bestSize = Infinity;
    const inside = (r: DOMRect) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    for (const [id, { range, atoms }] of this.entries) {
      if (range.collapsed) continue;
      const hit = atoms.some((a) => inside(atomRect(a))) || [...range.getClientRects()].some(inside);
      if (!hit) continue;
      const size = range.toString().length + atoms.length;
      if (size < bestSize) {
        best = id;
        bestSize = size;
      }
    }
    return best;
  }
}
