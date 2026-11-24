const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'twclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'oly_anon_id',
  'oly_enc_id',
  'vero_id',
  'ref_src',
  'ref_url',
  'spm',
]);

function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('utm_') || n.startsWith('pk_') || TRACKING_PARAMS.has(n);
}

/**
 * Produces a stable key for a page: lowercases the host, drops tracking
 * parameters and the fragment (except SPA-style `#/` and `#!` routes), and
 * sorts the remaining query parameters.
 */
export function normalizeUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  const kept = [...url.searchParams.entries()].filter(([k]) => !isTrackingParam(k));
  kept.sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  url.search = '';
  for (const [k, v] of kept) url.searchParams.append(k, v);
  const hash = url.hash;
  url.hash = hash.startsWith('#/') || hash.startsWith('#!') ? hash : '';
  let out = url.toString();
  if (url.pathname !== '/' && out.endsWith('/') && !url.search && !url.hash) out = out.slice(0, -1);
  return out;
}

/**
 * The address to show and link to: tracking parameters and plain anchors removed,
 * otherwise exactly as the site serves it (unlike `normalizeUrl`, which is a lookup key).
 */
export function cleanUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return input;
  }
  for (const k of [...url.searchParams.keys()]) if (isTrackingParam(k)) url.searchParams.delete(k);
  if (!url.hash.startsWith('#/') && !url.hash.startsWith('#!')) url.hash = '';
  return url.toString().replace(/\?$/, '');
}

/** A canonical URL is only trusted if it points somewhere more specific than a site's home page. */
export function usableCanonical(canonical: string | undefined, pageUrl: string): string | undefined {
  if (!canonical) return undefined;
  try {
    const c = new URL(canonical, pageUrl);
    if (c.protocol !== 'http:' && c.protocol !== 'https:') return undefined;
    if (c.pathname === '/' || c.pathname === '') return undefined;
    return normalizeUrl(c.toString());
  } catch {
    return undefined;
  }
}

export function normalizeDoi(doi: string | undefined): string | undefined {
  if (!doi) return undefined;
  const m = doi.trim().match(/10\.\d{4,9}\/\S+/);
  return m ? m[0].toLowerCase() : undefined;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
