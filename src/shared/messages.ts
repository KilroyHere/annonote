import type { Annotation, NotionState, Page, PageMeta, Theme } from './types';

/** Requests handled by the background service worker. */
export type Request =
  | { type: 'page:find'; meta: PageMeta }
  | { type: 'annotation:save'; meta: PageMeta; pageKey?: string; annotation: Annotation }
  | { type: 'annotation:update'; pageKey: string; id: string; patch: AnnotationPatch }
  | { type: 'annotation:delete'; pageKey: string; id: string }
  | { type: 'page:update'; pageKey?: string; meta?: PageMeta; patch: PagePatch }
  | { type: 'page:delete'; pageKey: string }
  | { type: 'page:setNotion'; pageKey: string; notion: NotionState | null }
  | { type: 'pages:list' }
  | { type: 'pages:import'; pages: Page[] }
  | { type: 'folders:list' }
  | { type: 'folder:add'; path: string }
  | { type: 'folder:rename'; from: string; to: string }
  | { type: 'folder:delete'; path: string }
  | { type: 'pages:move'; pageKeys: string[]; folder: string }
  | { type: 'notion:sync'; pageKey: string }
  | { type: 'settings:public' }
  | { type: 'library:open'; pageKey?: string; view?: 'settings' }
  | { type: 'badge'; count: number };

/** Highlights have a note and a color; tags live on the page. */
export type AnnotationPatch = Partial<Pick<Annotation, 'note' | 'color'>>;
/** `folder: ''` takes the page out of its folder. */
export type PagePatch = Partial<Pick<Page, 'pageNote' | 'tags' | 'title' | 'folder'>>;

export interface ImportResult {
  pages: number;
  added: number;
  updated: number;
}

export interface PublicSettings {
  highlightLinks: boolean;
  notionConfigured: boolean;
  theme: Theme;
}

export interface ResponseMap {
  'page:find': Page | null;
  'annotation:save': Page;
  'annotation:update': Page | null;
  'annotation:delete': Page | null;
  'page:update': Page | null;
  'page:delete': null;
  'page:setNotion': Page | null;
  'pages:list': Page[];
  'pages:import': ImportResult;
  'folders:list': string[];
  'folder:add': string[];
  'folder:rename': string[];
  'folder:delete': string[];
  'pages:move': null;
  'notion:sync': { url?: string };
  'settings:public': PublicSettings;
  'library:open': null;
  badge: null;
}

export type Response<T> = { ok: true; data: T } | { ok: false; error: string };

/** Messages the background or popup send to a tab's content script. */
export type TabMessage =
  | { type: 'command'; name: 'highlight-selection' | 'annotate-selection' | 'toggle-sidebar' }
  | { type: 'sidebar:open' }
  | { type: 'status' };

export interface TabStatus {
  title: string;
  count: number;
  orphans: number;
}

/** Sends a request to the background worker and unwraps the response. */
export async function send<R extends Request>(req: R): Promise<ResponseMap[R['type']]> {
  let res: Response<ResponseMap[R['type']]> | undefined;
  try {
    res = await chrome.runtime.sendMessage(req);
  } catch (err) {
    // A tab opened before Annonote was updated or reloaded is still running the old script.
    if (/context invalidated/i.test(String(err))) throw new Error('Annonote was updated. Reload this page to keep using it.');
    throw err;
  }
  if (!res) throw new Error('No response from Annonote background worker');
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
