import { render, type ComponentChildren } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseImport } from '../shared/backup';
import { pageToMarkdown } from '../shared/markdown';
import { send } from '../shared/messages';
import { NotionClient, ensureSchema, parseDatabaseId, syncPageToNotion, testConnection } from '../shared/notion';
import { displayQuote } from '../shared/quote';
import { hasTextFragment, textFragmentUrl } from '../shared/textFragment';
import { DEFAULT_SETTINGS, THEMES, normalizeFolder, type Annotation, type Color, type Page, type Settings, type Theme } from '../shared/types';
import { AnnotationEditor, ColorFilter, FolderPicker, NoteText, QuoteContent, TagChips, folderLabel } from '../shared/ui/components';
import componentsCss from '../shared/ui/components.css';
import {
  IconCopy,
  IconDownload,
  IconEdit,
  IconExternal,
  IconFolder,
  IconInbox,
  IconMoon,
  IconPlus,
  IconSearch,
  IconSend,
  IconSettings,
  IconStack,
  IconSun,
  IconTrash,
  IconUpload,
  Logo,
} from '../shared/ui/icons';
import { applyPageTheme, isDark } from '../shared/ui/theme';
import { hostOf } from '../shared/url';
import { exportBackup, exportMarkdownFile, exportMarkdownZip, fetchHypothesis } from './exporters';
import { UNFILED, filterPages, folderCounts, pagesInFolder, tagCounts as countTags } from './filter';
import libraryCss from './library.css';

type Toast = { text: string; kind: 'info' | 'error'; href?: string; linkText?: string } | null;

async function loadSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}

async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** MIME type for dragging page cards onto folders. */
const PAGE_DRAG_TYPE = 'application/x-annonote-page';
const THEME_LABELS: Record<Theme, string> = { system: 'Match system', light: 'Light', dark: 'Night' };

function App() {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  /** Selected folder: null for all pages, UNFILED for pages without a folder. */
  const [folder, setFolder] = useState<string | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [view, setView] = useState<'notes' | 'settings'>(location.hash === '#settings' ? 'settings' : 'notes');
  const [toast, setToast] = useState<Toast>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const fileInput = useRef<HTMLInputElement>(null);

  const showToast = useCallback((t: Toast) => {
    window.clearTimeout(toastTimer.current);
    setToast(t);
    if (t) toastTimer.current = window.setTimeout(() => setToast(null), t.kind === 'error' ? 8000 : 5000);
  }, []);

  const reload = useCallback(async () => {
    const [p, f] = await Promise.all([send({ type: 'pages:list' }), send({ type: 'folders:list' })]);
    setPages(p);
    setFolders(f);
  }, []);

  useEffect(() => {
    void reload();
    void loadSettings().then(setSettings);
    let timer: number | undefined;
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes.settings) void loadSettings().then(setSettings);
      if (changes.folders || Object.keys(changes).some((k) => k.startsWith('page:'))) {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void reload(), 150);
      }
    };
    chrome.storage.onChanged.addListener(onChange);
    const onHash = () => setView(location.hash === '#settings' ? 'settings' : 'notes');
    window.addEventListener('hashchange', onHash);
    return () => {
      chrome.storage.onChanged.removeListener(onChange);
      window.removeEventListener('hashchange', onHash);
    };
  }, [reload]);

  // Scroll to a page linked from the sidebar (#page=<key>).
  useEffect(() => {
    if (!pages || view !== 'notes') return;
    const m = location.hash.match(/^#page=(.+)$/);
    if (!m) return;
    const el = document.querySelector<HTMLElement>(`[data-page-key="${CSS.escape(decodeURIComponent(m[1]!))}"]`);
    el?.scrollIntoView({ block: 'start' });
    el?.classList.add('is-target');
  }, [pages, view]);

  const go = (v: 'notes' | 'settings') => {
    history.replaceState(null, '', v === 'settings' ? '#settings' : location.pathname);
    setView(v);
  };

  useEffect(() => applyPageTheme(document.getElementById('app')!, settings.theme), [settings.theme]);
  // Follow the system's light/dark switch while the theme is "Match system".
  const [, setSystemDark] = useState(isDark('system'));
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const dark = isDark(settings.theme);
  const toggleTheme = async () => setSettings(await saveSettings({ theme: dark ? 'light' : 'dark' }));

  // A folder that no longer exists (renamed or deleted elsewhere) falls back to all pages.
  useEffect(() => {
    if (folder && folder !== UNFILED && !folders.includes(folder)) setFolder(null);
  }, [folder, folders]);

  const filtered = useMemo(() => filterPages(pages ?? [], query, tag, folder), [pages, query, tag, folder]);
  const inFolderPages = useMemo(() => pagesInFolder(pages ?? [], folder), [pages, folder]);
  // Tags are counted within the selected folder, so the list shows what is useful there.
  const tagCounts = useMemo(() => countTags(inFolderPages), [inFolderPages]);
  const counts = useMemo(() => folderCounts(pages ?? [], folders), [pages, folders]);
  const unfiledCount = (pages ?? []).filter((p) => !p.folder).length;
  const shownPages = filtered.map((f) => f.page);
  const filteringPages = folder !== null || !!tag || !!query;

  const movePages = async (keys: string[], to: string) => {
    try {
      await send({ type: 'pages:move', pageKeys: keys, folder: to });
      showToast({ kind: 'info', text: to ? `Moved to ${to.replace(/\//g, ' › ')}.` : 'Removed from its folder.' });
    } catch (err) {
      showToast({ kind: 'error', text: `Couldn't move: ${(err as Error).message}` });
    }
  };

  const folderAction = async (action: () => Promise<string[]>, done?: () => void) => {
    try {
      setFolders(await action());
      done?.();
    } catch (err) {
      showToast({ kind: 'error', text: (err as Error).message });
    }
  };
  const totalHighlights = (pages ?? []).reduce((n, p) => n + p.annotations.length, 0);
  const notionReady = !!(settings.notionToken && parseDatabaseId(settings.notionDatabaseId));

  const onImportFile = async (file: File) => {
    try {
      const { source, pages: incoming } = parseImport(JSON.parse(await file.text()));
      const r = await send({ type: 'pages:import', pages: incoming });
      showToast({
        kind: 'info',
        text: `Imported from ${source === 'annonote' ? 'backup' : 'Hypothesis'}: ${plural(r.added, 'new highlight')}, ${r.updated} updated, ${plural(r.pages, 'page')} changed.`,
      });
    } catch (err) {
      showToast({ kind: 'error', text: `Import failed: ${(err as Error).message}` });
    }
  };

  const syncToNotion = async (targets: Page[]) => {
    const databaseId = parseDatabaseId(settings.notionDatabaseId);
    if (!settings.notionToken || !databaseId) {
      go('settings');
      return;
    }
    const client = new NotionClient(settings.notionToken);
    let done = 0;
    let lastUrl: string | undefined;
    try {
      setBusy(`notion:0/${targets.length}`);
      const schema = await ensureSchema(client, databaseId);
      for (const page of targets) {
        const notion = await syncPageToNotion(client, databaseId, page, { highlightLinks: settings.highlightLinks }, schema);
        await send({ type: 'page:setNotion', pageKey: page.key, notion });
        lastUrl = notion.url;
        setBusy(`notion:${++done}/${targets.length}`);
      }
      showToast({
        kind: 'info',
        text: targets.length === 1 ? 'Sent to Notion.' : `Sent ${plural(done, 'page')} to Notion.`,
        href: targets.length === 1 ? lastUrl : undefined,
        linkText: 'Open in Notion',
      });
    } catch (err) {
      showToast({ kind: 'error', text: `Notion: ${(err as Error).message}${done ? ` (${done} of ${targets.length} sent)` : ''}` });
    } finally {
      setBusy(null);
    }
  };

  const copyMarkdown = async (page: Page) => {
    await navigator.clipboard.writeText(pageToMarkdown(page, { highlightLinks: settings.highlightLinks }));
    showToast({ kind: 'info', text: 'Markdown copied.' });
  };

  const notionProgress = busy?.startsWith('notion:') ? busy.slice(7) : null;

  return (
    <>
      <header class="l-header">
        <div class="l-header-inner">
          <button type="button" class="l-brand" onClick={() => go('notes')}>
            <Logo size={28} />
            <span>Annonote</span>
          </button>
          {view === 'notes' && (
            <label class="l-search">
              <IconSearch size={16} />
              <input
                type="search"
                placeholder="Search highlights, notes, tags, pages…"
                aria-label="Search"
                value={query}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
            </label>
          )}
          <span class="g-spacer" />
          <nav class="l-actions" aria-label="Library actions">
            <button type="button" class="g-btn" onClick={() => fileInput.current?.click()}>
              <IconUpload size={14} />
              Import
            </button>
            <button
              type="button"
              class="g-btn"
              disabled={!shownPages.length}
              title={filteringPages ? 'Download the pages shown as Markdown files' : 'Download every page as Markdown files, one subfolder per folder'}
              onClick={() => exportMarkdownZip(shownPages, settings.highlightLinks)}
            >
              <IconDownload size={14} />
              Markdown (.zip){filteringPages && shownPages.length ? ` · ${shownPages.length}` : ''}
            </button>
            <button type="button" class="g-btn" disabled={!pages?.length} onClick={() => pages && exportBackup(pages)}>
              <IconDownload size={14} />
              Backup (.json)
            </button>
            {notionReady && (
              <button type="button" class="g-btn" disabled={!pages?.length || !!busy} onClick={() => pages && void syncToNotion(pages)}>
                <IconSend size={14} />
                {notionProgress ? `Sending ${notionProgress}…` : 'Send all to Notion'}
              </button>
            )}
            <button
              type="button"
              class="g-icon-btn"
              aria-label={dark ? 'Switch to light mode' : 'Switch to night mode'}
              title={dark ? 'Light mode' : 'Night mode'}
              onClick={() => void toggleTheme()}
            >
              {dark ? <IconSun size={18} /> : <IconMoon size={18} />}
            </button>
            <button
              type="button"
              class={`g-icon-btn${view === 'settings' ? ' is-active' : ''}`}
              aria-label="Settings"
              title="Settings"
              aria-pressed={view === 'settings'}
              onClick={() => go(view === 'settings' ? 'notes' : 'settings')}
            >
              <IconSettings size={18} />
            </button>
          </nav>
          <input
            ref={fileInput}
            type="file"
            accept=".json,.jsonld,application/json"
            hidden
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (f) void onImportFile(f);
            }}
          />
        </div>
      </header>

      {view === 'settings' ? (
        <SettingsView settings={settings} onSaved={setSettings} showToast={showToast} onDone={() => go('notes')} />
      ) : (
        <div class="l-layout">
          <aside class="l-filters" aria-label="Filters">
            <p class="l-stats">
              {plural(pages?.length ?? 0, 'page')} · {plural(totalHighlights, 'highlight')}
            </p>
            <FolderList
              folders={folders}
              counts={counts}
              total={pages?.length ?? 0}
              unfiled={unfiledCount}
              selected={folder}
              onSelect={(f) => {
                setFolder(f);
                setTag(null);
              }}
              onAdd={(path, done) => void folderAction(() => send({ type: 'folder:add', path }), done)}
              onRename={(from, to, done) =>
                void folderAction(
                  () => send({ type: 'folder:rename', from, to }),
                  () => {
                    if (folder && (folder === from || folder.startsWith(`${from}/`))) setFolder(normalizeFolder(to + folder.slice(from.length)));
                    done();
                  },
                )
              }
              onDelete={(path) => {
                const n = counts.get(path) ?? 0;
                const msg = n
                  ? `Delete the folder “${path}”? Its ${plural(n, 'page')} will be kept and moved up a level.`
                  : `Delete the folder “${path}”?`;
                if (confirm(msg)) void folderAction(() => send({ type: 'folder:delete', path }));
              }}
              onDropPages={(keys, to) => void movePages(keys, to)}
            />
            <h2 class="g-label">{folder === null ? 'Tags' : 'Tags in this folder'}</h2>
            {tagCounts.length ? (
              <ul class="l-tag-list">
                {tagCounts.map(([t, n]) => (
                  <li key={t}>
                    <button type="button" class={`l-tag-filter${tag === t ? ' is-active' : ''}`} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                      <span>#{t}</span>
                      <span class="g-muted">{n}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="g-muted l-small">{folder === null ? 'Tags you add to pages show up here.' : 'No tags in this folder yet.'}</p>
            )}
          </aside>

          <main class="l-main">
            {filteringPages && (
              <div class="l-filter-bar">
                <span>
                  Showing {plural(filtered.length, 'page')}
                  {folder === UNFILED && <> not in a folder</>}
                  {folder !== null && folder !== UNFILED && (
                    <>
                      {' '}in <strong>{folder.replace(/\//g, ' › ')}</strong>
                    </>
                  )}
                  {tag && <> tagged <strong>#{tag}</strong></>}
                  {query && <> matching “{query}”</>}
                </span>
                <button
                  type="button"
                  class="g-link-btn"
                  onClick={() => {
                    setTag(null);
                    setFolder(null);
                    setQuery('');
                  }}
                >
                  Clear filters
                </button>
              </div>
            )}
            {pages === null ? null : pages.length === 0 ? (
              <EmptyLibrary onImport={() => fileInput.current?.click()} />
            ) : filtered.length === 0 ? (
              <p class="l-none">
                {folder !== null && !tag && !query
                  ? 'No pages here yet. Drag a page onto this folder, or pick the folder in a page’s menu or in the sidebar on the page itself.'
                  : 'Nothing matches.'}
              </p>
            ) : (
              filtered.map(({ page, annotations }) => (
                <PageCard
                  key={page.key}
                  page={page}
                  annotations={annotations}
                  settings={settings}
                  notionReady={notionReady}
                  busy={!!busy}
                  folders={folders}
                  onMove={(to) => void movePages([page.key], to)}
                  onTag={setTag}
                  onCopy={() => void copyMarkdown(page)}
                  onDownload={() => exportMarkdownFile(page, settings.highlightLinks)}
                  onNotion={() => void syncToNotion([page])}
                />
              ))
            )}
          </main>
        </div>
      )}

      {toast && (
        <div class={`l-toast is-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'}>
          <span>{toast.text}</span>
          {toast.href && (
            <a href={toast.href} target="_blank" rel="noopener noreferrer">
              {toast.linkText ?? 'Open'}
            </a>
          )}
          <button type="button" class="g-link-btn" onClick={() => showToast(null)}>
            Dismiss
          </button>
        </div>
      )}
    </>
  );
}

/** Text input used to name or rename a folder. Enter saves, Esc cancels. */
function FolderNameInput({ initial, placeholder, onSave, onCancel }: { initial: string; placeholder: string; onSave: (name: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <form
      class="l-folder-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (normalizeFolder(draft)) onSave(draft);
        else onCancel();
      }}
    >
      <input
        ref={ref}
        class="g-input"
        aria-label="Folder name"
        placeholder={placeholder}
        value={draft}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
        onBlur={() => (normalizeFolder(draft) && normalizeFolder(draft) !== normalizeFolder(initial) ? onSave(draft) : onCancel())}
      />
    </form>
  );
}

function FolderList({
  folders,
  counts,
  total,
  unfiled,
  selected,
  onSelect,
  onAdd,
  onRename,
  onDelete,
  onDropPages,
}: {
  folders: string[];
  counts: Map<string, number>;
  total: number;
  unfiled: number;
  selected: string | null;
  onSelect: (folder: string | null) => void;
  onAdd: (path: string, done: () => void) => void;
  onRename: (from: string, to: string, done: () => void) => void;
  onDelete: (path: string) => void;
  onDropPages: (keys: string[], folder: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  /** Drag-and-drop handlers that move a dragged page card into `folder` ("" = out of any folder). */
  const dropProps = (folder: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes(PAGE_DRAG_TYPE)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropTarget(folder);
    },
    onDragLeave: () => setDropTarget((t) => (t === folder ? null : t)),
    onDrop: (e: DragEvent) => {
      const key = e.dataTransfer?.getData(PAGE_DRAG_TYPE);
      setDropTarget(null);
      if (!key) return;
      e.preventDefault();
      onDropPages([key], folder);
    },
  });

  const row = (key: string | null, icon: ComponentChildren, label: string, count: number, depth = 0, drop?: string) => (
    <button
      type="button"
      class={`l-folder${selected === key ? ' is-active' : ''}${drop !== undefined && dropTarget === drop ? ' is-drop' : ''}`}
      style={{ paddingLeft: `${8 + depth * 14}px` }}
      aria-pressed={selected === key}
      onClick={() => onSelect(selected === key && key !== null ? null : key)}
      {...(drop !== undefined ? dropProps(drop) : {})}
    >
      {icon}
      <span class="l-folder-name">{label}</span>
      <span class="g-muted">{count}</span>
    </button>
  );

  return (
    <>
      <div class="l-label-row">
        <h2 class="g-label">Folders</h2>
        <button type="button" class="g-icon-btn l-mini" title="New folder" aria-label="New folder" onClick={() => setAdding(true)}>
          <IconPlus size={14} />
        </button>
      </div>
      <ul class="l-folder-list">
        <li>{row(null, <IconStack size={14} />, 'All pages', total)}</li>
        <li>{row(UNFILED, <IconInbox size={14} />, 'Not in a folder', unfiled, 0, '')}</li>
        {folders.map((f) => {
          const depth = f.split('/').length - 1;
          return (
            <li key={f} class="l-folder-item">
              {renaming === f ? (
                <FolderNameInput
                  initial={f}
                  placeholder="Folder name"
                  onSave={(to) => onRename(f, to, () => setRenaming(null))}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <>
                  {row(f, <IconFolder size={14} />, folderLabel(f).trim(), counts.get(f) ?? 0, depth, f)}
                  <span class="l-folder-actions">
                    <button type="button" class="g-icon-btn l-mini" title="Rename folder" aria-label={`Rename folder ${f}`} onClick={() => setRenaming(f)}>
                      <IconEdit size={12} />
                    </button>
                    <button type="button" class="g-icon-btn l-mini" title="Delete folder" aria-label={`Delete folder ${f}`} onClick={() => onDelete(f)}>
                      <IconTrash size={12} />
                    </button>
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {adding ? (
        <FolderNameInput
          initial={selected && selected !== UNFILED ? `${selected}/` : ''}
          placeholder="Name (use / for subfolders)"
          onSave={(path) => onAdd(path, () => setAdding(false))}
          onCancel={() => setAdding(false)}
        />
      ) : (
        !folders.length && <p class="g-muted l-small">Make folders to group pages, then drag pages onto them.</p>
      )}
    </>
  );
}

function EmptyLibrary({ onImport }: { onImport: () => void }) {
  return (
    <div class="l-empty">
      <Logo size={44} />
      <h1>Your highlights will show up here</h1>
      <ol>
        <li>Open any article and select some text.</li>
        <li>Pick a color in the little toolbar, or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>.</li>
        <li>
          Add notes in the sidebar (<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd>).
        </li>
      </ol>
      <p class="g-muted">
        Coming from Hypothesis or restoring a backup?{' '}
        <button type="button" class="g-link-btn l-inline" onClick={onImport}>
          Import a file
        </button>{' '}
        or use <a href="#settings">Settings → Import from Hypothesis</a>.
      </p>
    </div>
  );
}

function PageCard({
  page,
  annotations,
  settings,
  notionReady,
  busy,
  folders,
  onMove,
  onTag,
  onCopy,
  onDownload,
  onNotion,
}: {
  page: Page;
  annotations: Annotation[];
  settings: Settings;
  notionReady: boolean;
  busy: boolean;
  folders: string[];
  onMove: (folder: string) => void;
  onTag: (t: string) => void;
  onCopy: () => void;
  onDownload: () => void;
  onNotion: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [color, setColor] = useState<Color | null>(null);
  const visible = color ? annotations.filter((a) => a.color === color) : annotations;
  const hidden = page.annotations.length - visible.length;
  const site = page.siteName || hostOf(page.url);

  const remove = async () => {
    if (!confirm(`Delete “${page.title || page.url}” and its ${plural(page.annotations.length, 'highlight')}?`)) return;
    await send({ type: 'page:delete', pageKey: page.key });
  };

  return (
    <article class="l-page" data-page-key={page.key}>
      <header
        class="l-page-head"
        draggable
        title="Drag onto a folder to move this page"
        onDragStart={(e) => {
          e.dataTransfer?.setData(PAGE_DRAG_TYPE, page.key);
          e.dataTransfer?.setData('text/uri-list', page.url);
          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        }}
      >
        <div class="l-page-title">
          <h2>
            <a href={page.url} target="_blank" rel="noopener noreferrer">
              {page.title || page.url}
            </a>
          </h2>
          <p class="g-muted">
            {site} · saved {formatDate(page.created)} · {plural(page.annotations.length, 'highlight')}
            {page.notion?.url && (
              <>
                {' · '}
                <a href={page.notion.url} target="_blank" rel="noopener noreferrer">
                  in Notion
                </a>
              </>
            )}
          </p>
          <div class="l-page-tools">
            <label class="l-folder-pick" title="Folder">
              <IconFolder size={13} />
              <FolderPicker value={page.folder} folders={folders} label="Folder for this page" onChange={onMove} />
            </label>
            <TagChips tags={page.tags} onTag={onTag} />
            <ColorFilter annotations={annotations} value={color} onChange={setColor} />
          </div>
        </div>
        <div class="l-page-actions">
          <button type="button" class="g-icon-btn" title="Copy as Markdown" aria-label="Copy as Markdown" onClick={onCopy}>
            <IconCopy />
          </button>
          <button type="button" class="g-icon-btn" title="Download .md" aria-label="Download Markdown file" onClick={onDownload}>
            <IconDownload />
          </button>
          {notionReady && (
            <button type="button" class="g-icon-btn" title="Send to Notion" aria-label="Send to Notion" disabled={busy} onClick={onNotion}>
              <IconSend />
            </button>
          )}
          <button type="button" class="g-icon-btn" title="Delete page" aria-label="Delete page and its highlights" onClick={() => void remove()}>
            <IconTrash />
          </button>
        </div>
      </header>

      {page.pageNote.trim() && (
        // Page notes are no longer added, but ones saved earlier (or imported) are kept and shown.
        <div class="l-page-note">
          <p>{page.pageNote}</p>
          <button
            type="button"
            class="g-link-btn l-small"
            onClick={() => void send({ type: 'page:update', pageKey: page.key, patch: { pageNote: '' } })}
          >
            Remove page note
          </button>
        </div>
      )}

      {visible.length > 0 && (
        <ol class="l-anns">
          {visible.map((a) => (
            <li key={a.id} class={`l-ann g-card-${a.color}${editing === a.id ? ' is-editing' : ''}`}>
              <blockquote class="l-quote">
                <QuoteContent a={a} />
                {settings.highlightLinks && hasTextFragment(displayQuote(a)) && (
                  <a
                    class="l-jump"
                    href={textFragmentUrl(page.url, displayQuote(a))}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Open the page at this highlight"
                    aria-label="Open the page at this highlight"
                  >
                    <IconExternal size={13} />
                  </a>
                )}
              </blockquote>
              {editing === a.id ? (
                <AnnotationEditor
                  note={a.note}
                  color={a.color}
                  onSave={(patch) => {
                    setEditing(null);
                    void send({ type: 'annotation:update', pageKey: page.key, id: a.id, patch });
                  }}
                  onCancel={() => setEditing(null)}
                  onDelete={() => void send({ type: 'annotation:delete', pageKey: page.key, id: a.id })}
                />
              ) : (
                <>
                  {a.note.trim() && (
                    <p class="l-note">
                      <NoteText note={a.note} />
                    </p>
                  )}
                  <button type="button" class="g-link-btn l-ann-edit" onClick={() => setEditing(a.id)}>
                    <IconEdit size={13} />
                    Edit
                  </button>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
      {hidden > 0 && <p class="l-hidden g-muted">{plural(hidden, 'more highlight')} on this page not shown by the current filter.</p>}
    </article>
  );
}

function SettingsView({
  settings,
  onSaved,
  showToast,
  onDone,
}: {
  settings: Settings;
  onSaved: (s: Settings) => void;
  showToast: (t: Toast) => void;
  onDone: () => void;
}) {
  const [token, setToken] = useState(settings.notionToken);
  const [db, setDb] = useState(settings.notionDatabaseId);
  const [testing, setTesting] = useState(false);
  const [hUser, setHUser] = useState('');
  const [hToken, setHToken] = useState('');
  const [hProgress, setHProgress] = useState<string | null>(null);

  useEffect(() => {
    setToken(settings.notionToken);
    setDb(settings.notionDatabaseId);
  }, [settings.notionToken, settings.notionDatabaseId]);

  const connectNotion = async (e: Event) => {
    e.preventDefault();
    const databaseId = parseDatabaseId(db);
    if (!token.trim() || !databaseId) {
      showToast({ kind: 'error', text: 'Enter the integration secret and a database link or ID.' });
      return;
    }
    setTesting(true);
    try {
      const title = await testConnection(new NotionClient(token.trim()), databaseId);
      onSaved(await saveSettings({ notionToken: token.trim(), notionDatabaseId: db.trim() }));
      showToast({ kind: 'info', text: `Connected to the Notion database “${title}”.` });
    } catch (err) {
      showToast({ kind: 'error', text: `Couldn't reach that database: ${(err as Error).message}` });
    } finally {
      setTesting(false);
    }
  };

  const disconnect = async () => {
    onSaved(await saveSettings({ notionToken: '', notionDatabaseId: '' }));
    setToken('');
    setDb('');
    showToast({ kind: 'info', text: 'Notion disconnected.' });
  };

  const importHypothesis = async (e: Event) => {
    e.preventDefault();
    if (!hUser.trim()) return;
    setHProgress('Starting…');
    try {
      const rows = await fetchHypothesis(hUser, hToken, (n, total) => setHProgress(`Downloaded ${n} of ${total}…`));
      const { pages } = parseImport(rows);
      const r = await send({ type: 'pages:import', pages });
      showToast({ kind: 'info', text: `Imported ${plural(r.added, 'highlight')} from Hypothesis (${r.updated} updated).` });
      setHToken('');
    } catch (err) {
      showToast({ kind: 'error', text: `Hypothesis import failed: ${(err as Error).message}` });
    } finally {
      setHProgress(null);
    }
  };

  const connected = !!(settings.notionToken && parseDatabaseId(settings.notionDatabaseId));

  return (
    <main class="l-settings">
      <div class="l-settings-head">
        <h1>Settings</h1>
        <button type="button" class="g-btn" onClick={onDone}>
          Back to notes
        </button>
      </div>

      <section class="l-panel">
        <h2>Notion</h2>
        <p class="g-muted">
          Each web page becomes a page in a Notion database, with its highlights as colored quotes and your notes beneath them.
          Sending a page again updates it in place.
        </p>
        <ol class="l-steps">
          <li>
            Create an internal integration at{' '}
            <a href="https://www.notion.so/my-integrations" target="_blank" rel="noopener noreferrer">
              notion.so/my-integrations
            </a>{' '}
            and copy its <em>Internal Integration Secret</em>.
          </li>
          <li>
            In Notion, open (or create) the database you want to use, then <em>••• → Connections</em> and add your integration.
          </li>
          <li>Copy the database's link (<em>••• → Copy link</em>) and paste both below.</li>
        </ol>
        <form class="l-form" onSubmit={connectNotion}>
          <label>
            <span>Integration secret</span>
            <input
              class="g-input"
              type="password"
              autoComplete="off"
              spellcheck={false}
              placeholder="ntn_…"
              value={token}
              onInput={(e) => setToken(e.currentTarget.value)}
            />
          </label>
          <label>
            <span>Database link or ID</span>
            <input
              class="g-input"
              spellcheck={false}
              placeholder="https://www.notion.so/…"
              value={db}
              onInput={(e) => setDb(e.currentTarget.value)}
            />
          </label>
          <div class="l-form-row">
            <button type="submit" class="g-btn g-btn-primary" disabled={testing}>
              {testing ? 'Checking…' : connected ? 'Test & update' : 'Connect'}
            </button>
            {connected && (
              <button type="button" class="g-btn" onClick={() => void disconnect()}>
                Disconnect
              </button>
            )}
            {connected && <span class="l-ok">Connected</span>}
          </div>
          <p class="g-muted l-small">
            The secret is stored only in this browser and sent only to api.notion.com. Annonote adds <em>URL</em>, <em>Tags</em> and{' '}
            <em>Saved</em> columns to the database if they're missing.
          </p>
        </form>
      </section>

      <section class="l-panel">
        <h2>Appearance</h2>
        <div class="l-theme-choice" role="radiogroup" aria-label="Appearance">
          {THEMES.map((t) => (
            <label key={t} class={`l-theme-option${settings.theme === t ? ' is-active' : ''}`}>
              <input type="radio" name="theme" value={t} checked={settings.theme === t} onChange={async () => onSaved(await saveSettings({ theme: t }))} />
              {t === 'dark' ? <IconMoon size={15} /> : t === 'light' ? <IconSun size={15} /> : <IconSettings size={15} />}
              {THEME_LABELS[t]}
            </label>
          ))}
        </div>
        <p class="g-muted l-small">Applies to the sidebar on pages, the library and the toolbar popup.</p>
      </section>

      <section class="l-panel">
        <h2>Exports</h2>
        <label class="l-check">
          <input
            type="checkbox"
            checked={settings.highlightLinks}
            onChange={async (e) => onSaved(await saveSettings({ highlightLinks: e.currentTarget.checked }))}
          />
          <span>
            Add “jump to highlight” links
            <span class="g-muted l-small l-block">
              Links like <code>page#:~:text=…</code> open the page scrolled to the passage in Chrome, Edge and Safari, even without Annonote.
            </span>
          </span>
        </label>
      </section>

      <section class="l-panel">
        <h2>Import from Hypothesis</h2>
        <p class="g-muted">
          Copies your Hypothesis annotations into Annonote. Public annotations only need your username; for private and group annotations,
          add an API token from{' '}
          <a href="https://hypothes.is/account/developer" target="_blank" rel="noopener noreferrer">
            hypothes.is/account/developer
          </a>
          . Importing again won't create duplicates.
        </p>
        <form class="l-form" onSubmit={importHypothesis}>
          <div class="l-form-grid">
            <label>
              <span>Username</span>
              <input class="g-input" spellcheck={false} value={hUser} onInput={(e) => setHUser(e.currentTarget.value)} />
            </label>
            <label>
              <span>API token (optional)</span>
              <input class="g-input" type="password" autoComplete="off" value={hToken} onInput={(e) => setHToken(e.currentTarget.value)} />
            </label>
          </div>
          <div class="l-form-row">
            <button type="submit" class="g-btn g-btn-primary" disabled={!hUser.trim() || !!hProgress}>
              {hProgress ?? 'Import'}
            </button>
          </div>
        </form>
      </section>

      <section class="l-panel">
        <h2>Keyboard shortcuts</h2>
        <ul class="l-shortcuts">
          <li>
            <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> Highlight the selection
          </li>
          <li>
            <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd> Highlight and add a note
          </li>
          <li>
            <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> Show or hide the sidebar
          </li>
        </ul>
        <button type="button" class="g-btn" onClick={() => void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' })}>
          Change shortcuts
        </button>
      </section>
    </main>
  );
}

const style = document.createElement('style');
style.textContent = componentsCss + libraryCss;
document.head.appendChild(style);
render(<App />, document.getElementById('app')!);
