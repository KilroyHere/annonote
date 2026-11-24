import { render } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { parseImport } from '../shared/backup';
import { pageToMarkdown } from '../shared/markdown';
import { send } from '../shared/messages';
import { NotionClient, ensureSchema, parseDatabaseId, syncPageToNotion, testConnection } from '../shared/notion';
import { displayQuote } from '../shared/quote';
import { textFragmentUrl } from '../shared/textFragment';
import { COLORS, DEFAULT_SETTINGS, allTags, byPosition, type Annotation, type Color, type Page, type Settings } from '../shared/types';
import { AnnotationEditor, COLOR_LABELS, TagChips } from '../shared/ui/components';
import componentsCss from '../shared/ui/components.css';
import {
  IconCopy,
  IconDownload,
  IconEdit,
  IconExternal,
  IconSearch,
  IconSend,
  IconSettings,
  IconTrash,
  IconUpload,
  Logo,
} from '../shared/ui/icons';
import { hostOf } from '../shared/url';
import { exportBackup, exportMarkdownFile, exportMarkdownZip, fetchHypothesis } from './exporters';
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

/** Every word of the query must appear somewhere in the text. */
function matches(haystack: string, words: string[]): boolean {
  const h = haystack.toLowerCase();
  return words.every((w) => h.includes(w));
}

interface Filtered {
  page: Page;
  annotations: Annotation[];
}

function filterPages(pages: Page[], query: string, tag: string | null, color: Color | null): Filtered[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: Filtered[] = [];
  for (const page of pages) {
    const sorted = [...page.annotations].sort(byPosition);
    const pageText = `${page.title} ${page.url} ${page.pageNote} ${page.tags.join(' ')}`;
    const pageMatchesQuery = words.length > 0 && matches(pageText, words);
    const pageHasTag = !!tag && page.tags.includes(tag);
    const annMatches = (a: Annotation) =>
      (!color || a.color === color) &&
      (!tag || pageHasTag || a.tags.includes(tag)) &&
      (!words.length || pageMatchesQuery || matches(`${displayQuote(a)} ${a.note} ${a.tags.join(' ')}`, words));
    const anns = sorted.filter(annMatches);
    const filtering = words.length > 0 || !!tag || !!color;
    if (!filtering) out.push({ page, annotations: sorted });
    else if (anns.length) out.push({ page, annotations: anns });
    else if (!color && (pageMatchesQuery || pageHasTag) && (!tag || pageHasTag) && (!words.length || pageMatchesQuery)) {
      out.push({ page, annotations: [] });
    }
  }
  return out;
}

function App() {
  const [pages, setPages] = useState<Page[] | null>(null);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [color, setColor] = useState<Color | null>(null);
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
    setPages(await send({ type: 'pages:list' }));
  }, []);

  useEffect(() => {
    void reload();
    void loadSettings().then(setSettings);
    let timer: number | undefined;
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if (changes.settings) void loadSettings().then(setSettings);
      if (Object.keys(changes).some((k) => k.startsWith('page:'))) {
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

  const filtered = useMemo(() => filterPages(pages ?? [], query, tag, color), [pages, query, tag, color]);
  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of pages ?? []) for (const t of allTags(p)) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [pages]);
  const totalHighlights = (pages ?? []).reduce((n, p) => n + p.annotations.length, 0);
  const notionReady = !!(settings.notionToken && parseDatabaseId(settings.notionDatabaseId));

  const onImportFile = async (file: File) => {
    try {
      const { source, pages: incoming } = parseImport(JSON.parse(await file.text()));
      const r = await send({ type: 'pages:import', pages: incoming });
      showToast({
        kind: 'info',
        text: `Imported from ${source === 'gloss' ? 'backup' : 'Hypothesis'}: ${plural(r.added, 'new highlight')}, ${r.updated} updated, ${plural(r.pages, 'page')} changed.`,
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
            <span>Gloss</span>
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
            <button type="button" class="g-btn" disabled={!pages?.length} onClick={() => pages && exportMarkdownZip(pages, settings.highlightLinks)}>
              <IconDownload size={14} />
              Markdown (.zip)
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
            <h2 class="g-label">Colors</h2>
            <div class="l-color-filter">
              {COLORS.map((c) => (
                <button
                  type="button"
                  key={c}
                  class={`g-dot g-dot-${c}`}
                  aria-label={`Only ${COLOR_LABELS[c].toLowerCase()} highlights`}
                  title={COLOR_LABELS[c]}
                  aria-pressed={color === c}
                  onClick={() => setColor(color === c ? null : c)}
                />
              ))}
            </div>
            <h2 class="g-label">Tags</h2>
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
              <p class="g-muted l-small">Tags you add to highlights show up here.</p>
            )}
          </aside>

          <main class="l-main">
            {(tag || color || query) && (
              <div class="l-filter-bar">
                <span>
                  Showing {plural(filtered.length, 'page')}
                  {tag && <> tagged <strong>#{tag}</strong></>}
                  {color && <> with {COLOR_LABELS[color].toLowerCase()} highlights</>}
                  {query && <> matching “{query}”</>}
                </span>
                <button
                  type="button"
                  class="g-link-btn"
                  onClick={() => {
                    setTag(null);
                    setColor(null);
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
              <p class="l-none">Nothing matches.</p>
            ) : (
              filtered.map(({ page, annotations }) => (
                <PageCard
                  key={page.key}
                  page={page}
                  annotations={annotations}
                  settings={settings}
                  notionReady={notionReady}
                  busy={!!busy}
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
  onTag: (t: string) => void;
  onCopy: () => void;
  onDownload: () => void;
  onNotion: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const hidden = page.annotations.length - annotations.length;
  const site = page.siteName || hostOf(page.url);

  const remove = async () => {
    if (!confirm(`Delete “${page.title || page.url}” and its ${plural(page.annotations.length, 'highlight')}?`)) return;
    await send({ type: 'page:delete', pageKey: page.key });
  };

  return (
    <article class="l-page" data-page-key={page.key}>
      <header class="l-page-head">
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

      {(page.pageNote.trim() || page.tags.length > 0) && (
        <div class="l-page-note">
          {page.pageNote.trim() && <p>{page.pageNote}</p>}
          <TagChips tags={page.tags} onTag={onTag} />
        </div>
      )}

      {annotations.length > 0 && (
        <ol class="l-anns">
          {annotations.map((a) => (
            <li key={a.id} class={`l-ann g-card-${a.color}`}>
              <blockquote class="l-quote">
                {displayQuote(a)}
                {settings.highlightLinks && (
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
                  tags={a.tags}
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
                  {a.note.trim() && <p class="l-note">{a.note}</p>}
                  <div class="l-ann-foot">
                    <TagChips tags={a.tags} onTag={onTag} />
                    <span class="g-spacer" />
                    <button type="button" class="g-link-btn" onClick={() => setEditing(a.id)}>
                      <IconEdit size={13} />
                      Edit
                    </button>
                  </div>
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
            The secret is stored only in this browser and sent only to api.notion.com. Gloss adds <em>URL</em>, <em>Tags</em> and{' '}
            <em>Saved</em> columns to the database if they're missing.
          </p>
        </form>
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
              Links like <code>page#:~:text=…</code> open the page scrolled to the passage in Chrome, Edge and Safari, even without Gloss.
            </span>
          </span>
        </label>
      </section>

      <section class="l-panel">
        <h2>Import from Hypothesis</h2>
        <p class="g-muted">
          Copies your Hypothesis annotations into Gloss. Public annotations only need your username; for private and group annotations,
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
