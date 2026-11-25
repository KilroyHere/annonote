import { COLORS, type Color } from '../shared/types';

/**
 * Paints highlights with the CSS Custom Highlight API. Unlike wrapping text in
 * <mark> elements, this never changes the page's DOM, so it cannot break the
 * page's own scripts or layout. Styles for ::highlight(annonote-*) live in highlights.css.
 */
export class Highlighter {
  private readonly ranges = new Map<string, { range: Range; color: Color }>();
  private active: string | null = null;
  private flashTimer: number | undefined;

  set(id: string, range: Range, color: Color): void {
    this.ranges.set(id, { range, color });
  }

  has(id: string): boolean {
    return this.ranges.has(id);
  }

  range(id: string): Range | undefined {
    return this.ranges.get(id)?.range;
  }

  setColor(id: string, color: Color): void {
    const entry = this.ranges.get(id);
    if (entry) entry.color = color;
  }

  delete(id: string): void {
    this.ranges.delete(id);
    if (this.active === id) this.active = null;
  }

  clear(): void {
    this.ranges.clear();
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
    if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
    for (const color of COLORS) {
      const ranges = [...this.ranges.values()].filter((r) => r.color === color).map((r) => r.range);
      if (ranges.length) CSS.highlights.set(`annonote-${color}`, new Highlight(...ranges));
      else CSS.highlights.delete(`annonote-${color}`);
    }
    const active = this.active ? this.ranges.get(this.active) : undefined;
    if (active) {
      const h = new Highlight(active.range);
      h.priority = 10;
      CSS.highlights.set('annonote-active', h);
    } else {
      CSS.highlights.delete('annonote-active');
    }
  }

  /** Returns the id of the highlight under a viewport point, preferring the smallest one. */
  hitTest(x: number, y: number): string | null {
    let best: string | null = null;
    let bestLength = Infinity;
    for (const [id, { range }] of this.ranges) {
      if (range.collapsed) continue;
      for (const rect of range.getClientRects()) {
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          const length = range.toString().length;
          if (length < bestLength) {
            best = id;
            bestLength = length;
          }
          break;
        }
      }
    }
    return best;
  }
}
