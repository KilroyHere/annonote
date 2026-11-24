export const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'] as const;
export type Color = (typeof COLORS)[number];

/** W3C Web Annotation TextQuoteSelector. */
export interface TextQuoteSelector {
  type: 'TextQuoteSelector';
  exact: string;
  prefix: string;
  suffix: string;
}

/** W3C Web Annotation TextPositionSelector (offsets into the page's text). */
export interface TextPositionSelector {
  type: 'TextPositionSelector';
  start: number;
  end: number;
}

export type Selector = TextQuoteSelector | TextPositionSelector;

export interface Annotation {
  id: string;
  created: string;
  updated: string;
  color: Color;
  /** Free text, may contain Markdown. */
  note: string;
  tags: string[];
  /** Always contains a TextQuoteSelector; usually a TextPositionSelector too. */
  selectors: Selector[];
  /** The quote as rendered when it was highlighted (keeps paragraph breaks). */
  text?: string;
}

/** Descriptive data read from the page itself. */
export interface PageMeta {
  url: string;
  title: string;
  canonical?: string;
  doi?: string;
  siteName?: string;
  author?: string;
  published?: string;
}

export interface NotionBlockRef {
  id: string;
  hash: string;
}

export interface NotionState {
  pageId: string;
  url?: string;
  /** Top-level Notion block for each synced item, keyed by annotation id (or a reserved key). */
  blocks: Record<string, NotionBlockRef>;
  syncedAt: string;
}

export interface Page extends PageMeta {
  /** Normalized URL; the storage key. */
  key: string;
  created: string;
  updated: string;
  pageNote: string;
  tags: string[];
  annotations: Annotation[];
  notion?: NotionState;
}

export interface Settings {
  notionToken: string;
  notionDatabaseId: string;
  /** Add "jump to highlight" links (URL text fragments) in exports. */
  highlightLinks: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  notionToken: '',
  notionDatabaseId: '',
  highlightLinks: true,
};

export function quoteOf(a: Annotation): TextQuoteSelector {
  const q = a.selectors.find((s): s is TextQuoteSelector => s.type === 'TextQuoteSelector');
  if (!q) throw new Error(`Annotation ${a.id} has no quote`);
  return q;
}

export function positionOf(a: Annotation): TextPositionSelector | undefined {
  return a.selectors.find((s): s is TextPositionSelector => s.type === 'TextPositionSelector');
}

/** Sorts annotations by where they appear in the page. */
export function byPosition(a: Annotation, b: Annotation): number {
  const pa = positionOf(a)?.start ?? Number.MAX_SAFE_INTEGER;
  const pb = positionOf(b)?.start ?? Number.MAX_SAFE_INTEGER;
  return pa - pb || a.created.localeCompare(b.created);
}

export function allTags(page: Page): string[] {
  const tags = new Set(page.tags);
  for (const a of page.annotations) for (const t of a.tags) tags.add(t);
  return [...tags].sort((x, y) => x.localeCompare(y));
}

export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  for (const raw of input.split(/[,\n]/)) {
    const tag = raw.trim().replace(/^#/, '').replace(/\s+/g, '-');
    if (tag) seen.add(tag);
  }
  return [...seen];
}

export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
