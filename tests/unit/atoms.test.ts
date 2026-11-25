// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { anchor, buildTextMap, describe as describeRange, renderSpan, spanHasAtoms } from '../../src/content/anchoring';
import { IMAGE_CHAR, atomOf, cleanTex, mathmlToTex } from '../../src/content/atoms';
import { atomsInRange } from '../../src/content/highlighter';
import { cleanQuote } from '../../src/shared/quote';

const KATEX = `<span class="katex"><span class="katex-mathml"><math><semantics><mrow><msub><mi>u</mi><mi>t</mi></msub></mrow><annotation encoding="application/x-tex">u_t</annotation></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="mord">u</span><span class="msupsub">t</span></span></span>`;
const KATEX_DISPLAY = `<span class="katex-display">${KATEX.replace('u_t', 'E = mc^2')}</span>`;
const MATHJAX3 = `<mjx-container class="MathJax" jax="CHTML"><mjx-math aria-hidden="true"><mjx-c></mjx-c></mjx-math><mjx-assistive-mml><math><msqrt><mn>2</mn><mi>D</mi><mi>t</mi></msqrt></math></mjx-assistive-mml></mjx-container>`;
const NATIVE = `<math alttext="J=-D\\nabla\\phi"><mi>J</mi><annotation encoding="application/x-tex">J=-D\\nabla\\phi</annotation></math>`;
const WIKI = `<span class="mwe-math-element"><span style="display:none"><math alttext="{\\displaystyle D}"><mi>D</mi></math></span><img class="mwe-math-fallback-image-inline" alt="{\\displaystyle D}" src="https://upload.example/d.svg"></span>`;

beforeEach(() => {
  document.body.innerHTML = `
    <article>
      <p id="k">The heat equation ${KATEX} describes heat.</p>
      ${KATEX_DISPLAY}
      <p id="j">Spreads like ${MATHJAX3} over time.</p>
      <p id="n">Fick's law ${NATIVE} relates flux.</p>
      <p id="w">The coefficient ${WIKI} has units.</p>
      <figure><img id="plot" alt="Concentration profiles" src="https://example.com/plot.png"><figcaption>Figure 1.</figcaption></figure>
      <p id="after">Diffusion is everywhere.</p>
    </article>`;
});

function rangeOver(el: Element): Range {
  const r = document.createRange();
  r.selectNodeContents(el);
  return r;
}

describe('math and images in the page text', () => {
  it('replaces each formula with its TeX source and each image with a placeholder', () => {
    const { text } = buildTextMap(document.body);
    expect(text).toContain('The heat equation $u_t$ describes heat.');
    expect(text).toContain('$$E = mc^2$$');
    expect(text).toContain('Spreads like $\\sqrt{2Dt}$ over time.');
    expect(text).toContain("Fick's law $J=-D\\nabla\\phi$ relates flux.");
    expect(text).toContain('The coefficient $D$ has units.');
    expect(text).toContain(`${IMAGE_CHAR}Figure 1.`);
    // None of the hidden copies leak in.
    expect(text).not.toContain('ut');
    expect(text).not.toContain('displaystyle');
  });

  it('describes a selection across a formula with clean TeX and finds it again', () => {
    const map = buildTextMap(document.body);
    const desc = describeRange(map, rangeOver(document.getElementById('k')!))!;
    expect(desc.quote.exact).toBe('The heat equation $u_t$ describes heat.');
    const range = anchor(buildTextMap(document.body), [desc.quote, desc.position])!;
    expect(atomsInRange(range)).toEqual([document.querySelector('.katex')]);
  });

  it('snaps selection ends that fall inside a formula to the whole formula', () => {
    const map = buildTextMap(document.body);
    const range = document.createRange();
    range.setStart(document.getElementById('k')!.firstChild!, 4); // "heat equation …"
    range.setEnd(document.querySelector('#k .katex-html .mord')!.firstChild!, 1); // inside the visible glyphs
    expect(describeRange(map, range)!.quote.exact).toBe('heat equation $u_t$');
  });

  it('highlights a whole image', () => {
    const map = buildTextMap(document.body);
    const range = document.createRange();
    range.selectNode(document.getElementById('plot')!);
    const desc = describeRange(map, range)!;
    expect(desc.quote.exact).toBe(IMAGE_CHAR);
    expect(desc.quote.suffix.startsWith('Figure 1.')).toBe(true);
    expect(spanHasAtoms(map, desc.position.start, desc.position.end)).toBe(true);
    expect(renderSpan(map, desc.position.start, desc.position.end)).toEqual({
      text: '',
      images: [{ src: 'https://example.com/plot.png', alt: 'Concentration profiles' }],
    });
    const again = anchor(buildTextMap(document.body), [desc.quote, desc.position])!;
    expect(atomsInRange(again)).toEqual([document.getElementById('plot')]);
  });

  it('renders readable text: inline math as $TeX$, display math on its own line, paragraphs kept', () => {
    const map = buildTextMap(document.body);
    const range = document.createRange();
    range.setStart(document.getElementById('k')!, 0);
    range.setEnd(document.getElementById('j')!, document.getElementById('j')!.childNodes.length);
    const desc = describeRange(map, range)!;
    const { text } = renderSpan(map, desc.position.start, desc.position.end);
    expect(cleanQuote(text)).toBe(
      'The heat equation $u_t$ describes heat.\n\n$$E = mc^2$$\n\nSpreads like $\\sqrt{2Dt}$ over time.',
    );
  });

  it('a page with no math or images maps exactly as before', () => {
    document.body.innerHTML = '<p>Plain <em>text</em> only.</p>';
    expect(buildTextMap(document.body).text).toBe('Plain text only.');
  });
});

describe('TeX helpers', () => {
  it('strips Wikipedia and delimiter wrappers', () => {
    expect(cleanTex('{\\displaystyle x^{2}}')).toBe('x^{2}');
    expect(cleanTex('\\[ a+b \\]')).toBe('a+b');
    expect(cleanTex('$$ y $$')).toBe('y');
  });

  it('turns MathML into TeX when there is no source', () => {
    const div = document.createElement('div');
    div.innerHTML = '<math><mfrac><mi>a</mi><mrow><mi>b</mi><mo>+</mo><mn>1</mn></mrow></mfrac><msup><mi>x</mi><mn>2</mn></msup><msub><mi>y</mi><mrow><mi>i</mi><mi>j</mi></mrow></msub></math>';
    expect(mathmlToTex(div.firstElementChild!)).toBe('\\frac{a}{b+1}x^2y_{ij}');
  });

  it('reads MathJax 2 source from the script tag that follows the output', () => {
    document.body.innerHTML = '<p><span class="MathJax">x</span><script type="math/tex; mode=display">\\int f</script></p>';
    expect(atomOf(document.querySelector('.MathJax')!)).toMatchObject({ kind: 'math', tex: '\\int f', display: true, text: '$$\\int f$$' });
  });

  it('treats ordinary images as images and LaTeX images as math', () => {
    document.body.innerHTML = '<img class="latex" alt="a^2" src="x.png"><img alt="cat" src="cat.jpg">';
    const [tex, cat] = document.querySelectorAll('img');
    expect(atomOf(tex!)).toMatchObject({ kind: 'math', tex: 'a^2' });
    expect(atomOf(cat!)).toMatchObject({ kind: 'image', alt: 'cat', text: IMAGE_CHAR });
  });
});
