import { markdownFilenames, pageToMarkdown } from '../shared/markdown';
import { send, type AnnotationPatch, type PublicSettings, type TabMessage, type TabStatus } from '../shared/messages';
import { cleanQuote } from '../shared/quote';
import { newId, nowIso, type Annotation, type Color, type Page, type PageMeta } from '../shared/types';
import { cleanUrl, normalizeUrl } from '../shared/url';
import { anchor, buildTextMap, describe, rangeFromSpan } from './anchoring';
import { Highlighter } from './highlighter';
import { readPageMeta } from './meta';

export interface ToolbarState {
  x: number;
  y: number;
  placement: 'above' | 'below';
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
  href?: string;
  linkText?: string;
  action?: 'settings';
}

export interface ViewState {
  page: Page | null;
  orphans: ReadonlySet<string>;
  sidebarOpen: boolean;
  editingId: string | null;
  focusId: string | null;
  toolbar: ToolbarState | null;
  settings: PublicSettings;
  toast: Toast | null;
  busy: 'notion' | null;
}

const REANCHOR_DELAY = 700;
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';
const INTERACTIVE = 'a, button, input, textarea, select, label, summary, [contenteditable], [role="button"], [role="link"]';

export class Controller {
  state: ViewState = {
    page: null,
    orphans: new Set(),
    sidebarOpen: false,
    editingId: null,
    focusId: null,
    toolbar: null,
    settings: { highlightLinks: true, notionConfigured: false },
    toast: null,
    busy: null,
  };

  private readonly listeners = new Set<() => void>();
  private readonly hl = new Highlighter();
  /** Text each highlight covered when anchored, to notice when the page rewrites it. */
  private readonly anchoredText = new Map<string, string>();
  private meta: PageMeta = readPageMeta();
  /** Key of the stored page record, once one exists. */
  private storedKey: string | undefined;
  private urlKey = normalizeUrl(location.href);
  private selectionRange: Range | null = null;
  private observer: MutationObserver | null = null;
  private reanchorTimer: number | undefined;
  private lookupTimer: number | undefined;
  private toastTimer: number | undefined;
  private toastSeq = 0;
  private generation = 0;

  constructor(private readonly isOwnEvent: (e: Event) => boolean) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private update(patch: Partial<ViewState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  async start(): Promise<void> {
    document.addEventListener('pointerup', this.onPointerUp, true);
    document.addEventListener('keyup', this.onKeyUp, true);
    document.addEventListener('click', this.onClick, true);
    document.addEventListener('selectionchange', this.onSelectionChange);
    window.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    window.addEventListener('resize', this.onScroll, { passive: true });
    chrome.runtime.onMessage.addListener(this.onMessage);
    chrome.storage.onChanged.addListener(this.onStorageChanged);
    window.setInterval(this.checkUrl, 1000);
    await this.load();
  }

  private async load(): Promise<void> {
    const generation = ++this.generation;
    this.meta = readPageMeta();
    const [page, settings] = await Promise.all([
      send({ type: 'page:find', meta: this.meta }),
      send({ type: 'settings:public' }),
    ]);
    if (generation !== this.generation) return; // the URL changed while loading
    this.update({ settings });
    this.setPage(page);
  }

  private readonly checkUrl = () => {
    const key = normalizeUrl(location.href);
    if (key === this.urlKey) return;
    this.urlKey = key;
    // Single-page app navigation: start over for the new URL.
    this.hl.clear();
    this.hl.render();
    this.anchoredText.clear();
    this.storedKey = undefined;
    this.update({ page: null, orphans: new Set(), editingId: null, focusId: null, toolbar: null });
    void this.load().catch(() => undefined);
  };

  /** Replaces the page record and anchors any annotations not yet on the page. */
  private setPage(page: Page | null): void {
    this.storedKey = page?.key;
    const ids = new Set(page?.annotations.map((a) => a.id));
    for (const id of [...this.anchoredText.keys()]) {
      if (!ids.has(id)) {
        this.hl.delete(id);
        this.anchoredText.delete(id);
      }
    }
    const orphans = new Set([...this.state.orphans].filter((id) => ids.has(id)));
    const pending = page?.annotations.filter((a) => !this.hl.has(a.id) && !orphans.has(a.id)) ?? [];
    if (pending.length) {
      const map = buildTextMap(document.body);
      for (const a of pending) {
        const range = anchor(map, a.selectors);
        if (range && !range.collapsed) {
          this.hl.set(a.id, range, a.color);
          this.anchoredText.set(a.id, range.toString());
        } else {
          orphans.add(a.id);
        }
      }
    }
    for (const a of page?.annotations ?? []) this.hl.setColor(a.id, a.color);
    this.hl.render();
    const editingId = this.state.editingId && ids.has(this.state.editingId) ? this.state.editingId : null;
    this.update({ page, orphans, editingId });
    this.observeMutations();
    void send({ type: 'badge', count: page?.annotations.length ?? 0 }).catch(() => undefined);
  }

  private observeMutations(): void {
    const needed = !!this.state.page?.annotations.length;
    if (needed && !this.observer) {
      this.observer = new MutationObserver(this.scheduleReanchor);
      this.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    } else if (!needed && this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
  }

  private readonly scheduleReanchor = () => {
    window.clearTimeout(this.reanchorTimer);
    this.reanchorTimer = window.setTimeout(() => this.reanchor(), REANCHOR_DELAY);
  };

  /** Re-finds highlights the page has re-rendered or that were missing (content loaded late). */
  private reanchor(): void {
    const page = this.state.page;
    if (!page) return;
    const stale = page.annotations.filter((a) => {
      if (this.state.orphans.has(a.id)) return true;
      const range = this.hl.range(a.id);
      return !range || range.collapsed || range.toString() !== this.anchoredText.get(a.id);
    });
    if (!stale.length) return;
    const map = buildTextMap(document.body);
    const orphans = new Set(this.state.orphans);
    for (const a of stale) {
      const range = anchor(map, a.selectors);
      if (range && !range.collapsed) {
        this.hl.set(a.id, range, a.color);
        this.anchoredText.set(a.id, range.toString());
        orphans.delete(a.id);
      } else {
        this.hl.delete(a.id);
        this.anchoredText.delete(a.id);
        orphans.add(a.id);
      }
    }
    this.hl.render();
    this.update({ orphans });
  }

  // -------------------------------------------------------------------------
  // Selection toolbar

  private readonly onPointerUp = (e: Event) => {
    if (this.isOwnEvent(e)) return;
    window.setTimeout(() => this.refreshToolbar(), 0);
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    if (this.isOwnEvent(e)) return;
    if (e.shiftKey || e.key === 'Shift' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')) this.refreshToolbar();
  };

  private readonly onSelectionChange = () => {
    if (this.state.toolbar && (document.getSelection()?.isCollapsed ?? true)) {
      this.selectionRange = null;
      this.update({ toolbar: null });
    }
  };

  private readonly onScroll = () => {
    if (this.state.toolbar && this.selectionRange) this.update({ toolbar: this.toolbarPosition(this.selectionRange) });
  };

  /** The current page selection, if it is something we can highlight. */
  private usableSelection(): Range | null {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.toString().trim()) return null;
    const range = sel.getRangeAt(0);
    if (!document.body.contains(range.commonAncestorContainer)) return null;
    const node = range.commonAncestorContainer;
    const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (!el || el.closest(EDITABLE)) return null;
    const active = document.activeElement;
    if (active && active !== document.body && active.matches(EDITABLE)) return null;
    return range;
  }

  private toolbarPosition(range: Range): ToolbarState {
    const rect = range.getBoundingClientRect();
    const x = Math.min(Math.max(rect.left + rect.width / 2, 120), window.innerWidth - 120);
    return rect.top > 56
      ? { x, y: rect.top - 10, placement: 'above' }
      : { x, y: Math.min(rect.bottom + 10, window.innerHeight - 50), placement: 'below' };
  }

  private refreshToolbar(): void {
    const range = this.usableSelection();
    this.selectionRange = range?.cloneRange() ?? null;
    this.update({ toolbar: range ? this.toolbarPosition(range) : null });
  }

  // -------------------------------------------------------------------------
  // Clicking an existing highlight

  private readonly onClick = (e: MouseEvent) => {
    if (this.isOwnEvent(e) || e.button !== 0) return;
    if (!(document.getSelection()?.isCollapsed ?? true)) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest(INTERACTIVE)) return;
    const id = this.hl.hitTest(e.clientX, e.clientY);
    if (id) this.focus(id, false);
  };

  /** Opens the sidebar on an annotation and marks it on the page. */
  focus(id: string, scrollPage: boolean): void {
    this.hl.flash(id);
    if (scrollPage) {
      const range = this.hl.range(id);
      const el = range?.startContainer.parentElement;
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    this.update({ sidebarOpen: true, focusId: id });
  }

  // -------------------------------------------------------------------------
  // Messages from the background worker / popup

  private readonly onMessage = (msg: TabMessage, _sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
    switch (msg.type) {
      case 'command':
        if (msg.name === 'toggle-sidebar') this.toggleSidebar();
        else void this.createFromSelection('yellow', msg.name === 'annotate-selection');
        break;
      case 'sidebar:open':
        this.update({ sidebarOpen: true });
        break;
      case 'status': {
        const status: TabStatus = {
          title: this.meta.title,
          count: this.state.page?.annotations.length ?? 0,
          orphans: this.state.orphans.size,
        };
        sendResponse(status);
        return;
      }
    }
    sendResponse(null);
  };

  private readonly onStorageChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    if (changes.settings) void send({ type: 'settings:public' }).then((settings) => this.update({ settings }));
    const key = this.storedKey;
    if (key) {
      if (changes[`page:${key}`]) this.setPage((changes[`page:${key}`]!.newValue as Page | undefined) ?? null);
      return;
    }
    // Nothing stored for this tab yet: a record may have just appeared for it
    // (restored from a backup, imported, or created in another tab).
    const added = Object.entries(changes).some(([k, c]) => k.startsWith('page:') && c.newValue && !c.oldValue);
    if (added && !this.state.page?.annotations.length) {
      window.clearTimeout(this.lookupTimer);
      this.lookupTimer = window.setTimeout(() => void this.load().catch(() => undefined), 200);
    }
  };

  // -------------------------------------------------------------------------
  // Editing

  toggleSidebar(open = !this.state.sidebarOpen): void {
    this.update({ sidebarOpen: open, focusId: null });
  }

  setEditing(id: string | null): void {
    this.update({ editingId: id, focusId: id });
  }

  async createFromSelection(color: Color, withNote: boolean): Promise<void> {
    const range = this.usableSelection() ?? this.selectionRange;
    if (!range) {
      if (withNote) this.toggleSidebar(true);
      return;
    }
    const map = buildTextMap(document.body);
    const desc = describe(map, range);
    if (!desc) return;
    const selectedText = cleanQuote(document.getSelection()?.toString() ?? '');
    const now = nowIso();
    const annotation: Annotation = {
      id: newId(),
      created: now,
      updated: now,
      color,
      note: '',
      tags: [],
      selectors: [desc.quote, desc.position],
      ...(selectedText ? { text: selectedText } : {}),
    };
    const highlightRange = rangeFromSpan(map, desc.position.start, desc.position.end);
    if (highlightRange) {
      this.hl.set(annotation.id, highlightRange, color);
      this.anchoredText.set(annotation.id, highlightRange.toString());
      this.hl.render();
    }
    document.getSelection()?.removeAllRanges();
    this.selectionRange = null;

    // Show it straight away; the stored copy replaces this when the save completes.
    const base = this.state.page ?? this.provisionalPage();
    this.update({
      page: { ...base, annotations: [...base.annotations, annotation] },
      toolbar: null,
      ...(withNote ? { sidebarOpen: true, editingId: annotation.id, focusId: annotation.id } : {}),
    });
    try {
      const saved = await send({ type: 'annotation:save', meta: this.meta, pageKey: this.storedKey, annotation });
      this.setPage(saved);
    } catch (err) {
      this.hl.delete(annotation.id);
      this.anchoredText.delete(annotation.id);
      this.hl.render();
      const current = this.state.page;
      const remaining = current?.annotations.filter((a) => a.id !== annotation.id) ?? [];
      this.update({ page: this.storedKey && current ? { ...current, annotations: remaining } : null, editingId: null });
      this.showToast(`Couldn't save the highlight: ${(err as Error).message}`, 'error');
    }
  }

  private provisionalPage(): Page {
    const now = nowIso();
    return { ...this.meta, url: cleanUrl(this.meta.url), key: normalizeUrl(this.meta.url), created: now, updated: now, pageNote: '', tags: [], annotations: [] };
  }

  async updateAnnotation(id: string, patch: AnnotationPatch): Promise<void> {
    const page = this.state.page;
    if (!page || !this.storedKey) return;
    if (patch.color) {
      this.hl.setColor(id, patch.color);
      this.hl.render();
    }
    this.update({ page: { ...page, annotations: page.annotations.map((a) => (a.id === id ? { ...a, ...patch } : a)) } });
    try {
      const saved = await send({ type: 'annotation:update', pageKey: this.storedKey, id, patch });
      if (saved) this.setPage(saved);
    } catch (err) {
      this.showToast(`Couldn't save: ${(err as Error).message}`, 'error');
    }
  }

  async deleteAnnotation(id: string): Promise<void> {
    if (!this.storedKey) return;
    this.hl.delete(id);
    this.anchoredText.delete(id);
    this.hl.render();
    try {
      const saved = await send({ type: 'annotation:delete', pageKey: this.storedKey, id });
      this.setPage(saved);
    } catch (err) {
      this.showToast(`Couldn't delete: ${(err as Error).message}`, 'error');
    }
  }

  async updatePage(patch: { pageNote?: string; tags?: string[] }): Promise<void> {
    try {
      const saved = await send({ type: 'page:update', pageKey: this.storedKey, meta: this.meta, patch });
      this.setPage(saved);
    } catch (err) {
      this.showToast(`Couldn't save: ${(err as Error).message}`, 'error');
    }
  }

  // -------------------------------------------------------------------------
  // Export

  private markdown(): { name: string; text: string } | null {
    const page = this.state.page;
    if (!page) return null;
    return {
      name: markdownFilenames([page]).get(page.key) ?? 'notes.md',
      text: pageToMarkdown(page, { highlightLinks: this.state.settings.highlightLinks }),
    };
  }

  async copyMarkdown(fallbackHost: HTMLElement | ShadowRoot): Promise<void> {
    const md = this.markdown();
    if (!md) return;
    try {
      await navigator.clipboard.writeText(md.text);
    } catch {
      // Clipboard API unavailable (e.g. http: pages): copy through a temporary textarea.
      const ta = document.createElement('textarea');
      ta.value = md.text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      fallbackHost.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (!ok) {
        this.showToast("Couldn't copy to the clipboard.", 'error');
        return;
      }
    }
    this.showToast('Markdown copied. Paste it into Notion, Obsidian or any editor.');
  }

  downloadMarkdown(host: HTMLElement | ShadowRoot): void {
    const md = this.markdown();
    if (!md) return;
    const url = URL.createObjectURL(new Blob([md.text], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = md.name;
    host.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async sendToNotion(): Promise<void> {
    if (!this.storedKey || this.state.busy) return;
    if (!this.state.settings.notionConfigured) {
      this.update({ toast: { id: ++this.toastSeq, text: 'Connect Notion in the library settings first.', kind: 'error', action: 'settings' } });
      return;
    }
    this.update({ busy: 'notion' });
    try {
      const { url } = await send({ type: 'notion:sync', pageKey: this.storedKey });
      this.showToast('Sent to Notion.', 'info', url, 'Open in Notion');
    } catch (err) {
      this.showToast(`Notion: ${(err as Error).message}`, 'error');
    } finally {
      this.update({ busy: null });
    }
  }

  openLibrary(): void {
    void send({ type: 'library:open', pageKey: this.storedKey }).catch(() => undefined);
  }

  openSettings(): void {
    this.dismissToast();
    void send({ type: 'library:open', view: 'settings' }).catch(() => undefined);
  }

  showToast(text: string, kind: Toast['kind'] = 'info', href?: string, linkText?: string): void {
    window.clearTimeout(this.toastTimer);
    this.update({ toast: { id: ++this.toastSeq, text, kind, href, linkText } });
    this.toastTimer = window.setTimeout(() => this.update({ toast: null }), kind === 'error' ? 7000 : 4500);
  }

  dismissToast(): void {
    window.clearTimeout(this.toastTimer);
    this.update({ toast: null });
  }

  /** Scrolls the page to a highlight and briefly marks it. */
  reveal(id: string): void {
    this.focus(id, true);
  }
}
