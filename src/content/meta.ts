import type { PageMeta } from '../shared/types';

function metaContent(...selectors: string[]): string | undefined {
  for (const sel of selectors) {
    const el = document.querySelector<HTMLMetaElement>(sel);
    const value = el?.content?.trim();
    if (value) return value;
  }
  return undefined;
}

/** Reads title, canonical URL, DOI and other citation data from the current page. */
export function readPageMeta(): PageMeta {
  const canonicalHref = document.querySelector<HTMLLinkElement>('link[rel~="canonical"]')?.href;
  const doi =
    metaContent('meta[name="citation_doi"]', 'meta[name="dc.identifier" i]', 'meta[name="DC.Identifier"]', 'meta[name="doi"]', 'meta[property="citation_doi"]') ??
    undefined;
  return {
    url: location.href,
    title: (metaContent('meta[property="og:title"]', 'meta[name="citation_title"]') ?? document.title ?? '').trim() || location.href,
    canonical: canonicalHref || undefined,
    doi: doi && /10\.\d{4,9}\//.test(doi) ? doi : undefined,
    siteName: metaContent('meta[property="og:site_name"]', 'meta[name="application-name"]'),
    author: metaContent('meta[name="author"]', 'meta[property="article:author"]', 'meta[name="citation_author"]'),
    published: metaContent(
      'meta[property="article:published_time"]',
      'meta[name="citation_publication_date"]',
      'meta[name="date"]',
      'meta[name="dc.date" i]',
    ),
  };
}
