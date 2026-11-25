/**
 * "Atoms" are page elements that are anchored and highlighted as a whole
 * instead of character by character: rendered math and images.
 *
 * Math renderers put several copies of a formula in the DOM (visible glyphs,
 * hidden MathML, the TeX source), and MathJax draws its glyphs with CSS so there
 * is no text to select or paint at all. Treating the formula as one unit gives
 * a clean quote (its TeX source) and lets us paint it with an overlay box.
 */

export type AtomKind = 'math' | 'image';

export interface Atom {
  kind: AtomKind;
  /** What the atom contributes to the page text used for anchoring. */
  text: string;
  /** TeX source for math. */
  tex?: string;
  /** Display (block) math rather than inline. */
  display?: boolean;
  /** Image address and alt text. */
  src?: string;
  alt?: string;
}

/** Stands in for an image in the page text (U+FFFC OBJECT REPLACEMENT CHARACTER). */
export const IMAGE_CHAR = '￼';

const MATH_CLASSES = '.katex-display, .katex, .MathJax_Display, .MathJax, .MathJax_SVG, .MathJax_CHTML, .mwe-math-element';
/** Every element that can be an atom (some only when their own checks pass). */
export const ATOM_QUERY = `img, math, mjx-container, ${MATH_CLASSES}`;

/** Inline data: images larger than this are stored without their address. */
const MAX_DATA_URL = 100_000;

export function isAtom(el: Element): boolean {
  const name = el.localName;
  if (name === 'img' || name === 'math' || name === 'mjx-container') return true;
  return el.classList.length > 0 && el.matches(MATH_CLASSES);
}

/** The outermost atom containing `node`, if any. */
export function atomAncestor(node: Node, stopAt?: Node): Element | null {
  let found: Element | null = null;
  for (let el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement; el && el !== stopAt; el = el.parentElement) {
    if (isAtom(el)) found = el;
  }
  return found;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Removes the wrappers Wikipedia and others put around TeX. */
export function cleanTex(raw: string): string {
  let tex = collapse(raw);
  const m = tex.match(/^\{\\(?:displaystyle|textstyle)\s*(.*)\}$/s);
  if (m) tex = m[1]!.trim();
  tex = tex.replace(/^\\\[(.*)\\\]$/s, '$1').replace(/^\\\((.*)\\\)$/s, '$1').replace(/^\$\$?(.*?)\$?\$$/s, '$1');
  return tex.trim();
}

const TEX_ANNOTATION = 'annotation[encoding="application/x-tex"], annotation[encoding="TeX"], annotation[encoding="text/x-tex"]';

function texSource(el: Element): string | null {
  const ann = el.matches(TEX_ANNOTATION) ? el : el.querySelector(TEX_ANNOTATION);
  if (ann?.textContent?.trim()) return ann.textContent;
  const attr = el.getAttribute('data-tex') ?? el.getAttribute('data-latex') ?? el.querySelector('[data-tex], [data-latex]')?.getAttribute('data-tex');
  if (attr?.trim()) return attr;
  const math = el.localName === 'math' ? el : el.querySelector('math[alttext]');
  const alttext = math?.getAttribute('alttext');
  if (alttext?.trim()) return alttext;
  const img = el.localName === 'img' ? el : el.querySelector('img[alt]');
  const alt = img?.getAttribute('alt');
  if (alt?.trim() && (el.localName !== 'img' || isMathImage(el))) return alt;
  // MathJax 2 keeps the source in a <script type="math/tex"> right after the rendered output.
  const next = el.nextElementSibling;
  if (next?.localName === 'script' && /^math\/tex/i.test(next.getAttribute('type') ?? '')) return next.textContent;
  return null;
}

/** A rough TeX rendering of MathML, for renderers (MathJax 3) that keep no TeX source in the page. */
export function mathmlToTex(node: Element): string {
  const kids = [...node.children];
  const arg = (i: number) => mathmlToTex(kids[i] ?? node.ownerDocument.createElement('mrow'));
  const group = (i: number) => {
    const s = arg(i);
    return s.length === 1 ? s : `{${s}}`;
  };
  switch (node.localName) {
    case 'mi':
    case 'mn':
    case 'mtext':
    case 'ms':
      return collapse(node.textContent ?? '');
    case 'mo': {
      const op = collapse(node.textContent ?? '');
      return op === '−' ? '-' : op;
    }
    case 'mfrac':
      return `\\frac{${arg(0)}}{${arg(1)}}`;
    case 'msqrt':
      return `\\sqrt{${kids.map(mathmlToTex).join('')}}`;
    case 'mroot':
      return `\\sqrt[${arg(1)}]{${arg(0)}}`;
    case 'msup':
      return `${arg(0)}^${group(1)}`;
    case 'msub':
      return `${arg(0)}_${group(1)}`;
    case 'msubsup':
      return `${arg(0)}_${group(1)}^${group(2)}`;
    case 'munder':
      return `${arg(0)}_${group(1)}`;
    case 'mover':
      return `${arg(0)}^${group(1)}`;
    case 'munderover':
      return `${arg(0)}_${group(1)}^${group(2)}`;
    case 'annotation':
    case 'annotation-xml':
      return '';
    case 'semantics':
      return kids[0] ? mathmlToTex(kids[0]) : '';
    default:
      return kids.length ? kids.map(mathmlToTex).join('') : collapse(node.textContent ?? '');
  }
}

function isMathImage(img: Element): boolean {
  return img.matches('img.latex, img.tex, img.mathtex, img.mwe-math-fallback-image-inline, img.mwe-math-fallback-image-display');
}

function isDisplayMath(el: Element): boolean {
  if (el.matches('.katex-display, .MathJax_Display, mjx-container[display="true"], math[display="block"]')) return true;
  if (el.querySelector('math[display="block"], .mwe-math-fallback-image-display, .mwe-math-mathml-display')) return true;
  const next = el.nextElementSibling;
  return next?.localName === 'script' && /mode=display/i.test(next.getAttribute('type') ?? '');
}

/** Usable address of an image: the one the browser actually loaded, never script URLs, big inline data dropped. */
function imageSrc(img: HTMLImageElement): string | undefined {
  const src = img.currentSrc || img.src;
  if (!src || !/^(https?:|data:image\/|file:|blob:)/i.test(src)) return undefined;
  if (src.startsWith('data:') && src.length > MAX_DATA_URL) return undefined;
  return src;
}

/** Describes an element as an atom, or returns null if it is ordinary content. */
export function atomOf(el: Element): Atom | null {
  if (!isAtom(el)) return null;
  if (el.localName === 'img' && !isMathImage(el)) {
    const img = el as HTMLImageElement;
    return { kind: 'image', text: IMAGE_CHAR, src: imageSrc(img), alt: collapse(img.alt ?? '') };
  }
  const display = isDisplayMath(el);
  let tex = texSource(el);
  if (tex === null) {
    const mml = el.localName === 'math' ? el : el.querySelector('math');
    tex = mml ? mathmlToTex(mml) : (el.textContent ?? '');
  }
  const clean = cleanTex(tex);
  if (!clean) return { kind: 'math', text: '', tex: '', display };
  return { kind: 'math', text: display ? `$$${clean}$$` : `$${clean}$`, tex: clean, display };
}
