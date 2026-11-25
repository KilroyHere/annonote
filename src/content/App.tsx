import { useEffect, useLayoutEffect, useReducer, useRef } from 'preact/hooks';
import { byPosition, type Annotation } from '../shared/types';
import {
  AnnotationEditor,
  AutosaveTags,
  AutosaveTextarea,
  ColorDots,
  ColorFilter,
  FolderPicker,
  NoteText,
  QuoteContent,
  TagChips,
} from '../shared/ui/components';
import { IconClose, IconCopy, IconDownload, IconEdit, IconLibrary, IconNote, IconSend, Logo } from '../shared/ui/icons';
import type { Controller, MediaButtonState, ToolbarState, ViewState } from './controller';

function useController(c: Controller): ViewState {
  const [, force] = useReducer((n: number, _action: void) => n + 1, 0);
  useLayoutEffect(() => c.subscribe(() => force()), [c]);
  return c.state;
}

export function App({ c, root }: { c: Controller; root: ShadowRoot }) {
  const s = useController(c);
  return (
    <>
      {s.media && !s.toolbar && <MediaButton c={c} m={s.media} />}
      {s.toolbar && <Toolbar c={c} pos={s.toolbar} />}
      {s.sidebarOpen && <Sidebar c={c} s={s} root={root} />}
      {s.toast && <ToastView c={c} s={s} />}
    </>
  );
}

function Toolbar({ c, pos }: { c: Controller; pos: ToolbarState }) {
  // preventDefault on press keeps the page selection alive while clicking the toolbar.
  const keep = (e: Event) => e.preventDefault();
  return (
    <div
      class={`g-toolbar is-${pos.placement}`}
      style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
      role="toolbar"
      aria-label="Highlight the selected text"
      onMouseDown={keep}
      onPointerDown={keep}
    >
      <ColorDots onPick={(color) => void c.createFromSelection(color, false)} label="Highlight in color" />
      <span class="g-sep" aria-hidden="true" />
      <button type="button" class="g-tool-btn" onClick={() => void c.createFromSelection('yellow', true)}>
        <IconNote size={15} />
        Note
      </button>
    </div>
  );
}

function MediaButton({ c, m }: { c: Controller; m: MediaButtonState }) {
  const keep = (e: Event) => e.preventDefault();
  return (
    <button
      type="button"
      class="g-media-btn"
      style={{ left: `${m.x}px`, top: `${m.y}px` }}
      title={m.existingId ? 'Open the note for this highlight' : m.kind === 'image' ? 'Highlight this image' : 'Highlight this equation'}
      onMouseDown={keep}
      onPointerDown={keep}
      onClick={() => c.selectMedia()}
    >
      <IconNote size={13} />
      {m.existingId ? 'Note' : 'Highlight'}
    </button>
  );
}

function Sidebar({ c, s, root }: { c: Controller; s: ViewState; root: ShadowRoot }) {
  const page = s.page;
  const annotations = page ? [...page.annotations].sort(byPosition) : [];
  const shown = s.colorFilter ? annotations.filter((a) => a.color === s.colorFilter) : annotations;
  const found = shown.filter((a) => !s.orphans.has(a.id));
  const missing = shown.filter((a) => s.orphans.has(a.id));
  const hasContent = annotations.length > 0 || !!page?.pageNote.trim();
  const count = annotations.length === 1 ? '1 highlight' : `${annotations.length} highlights`;

  return (
    <aside
      class="g-sidebar"
      aria-label="Annonote notes for this page"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !s.editingId) c.toggleSidebar(false);
      }}
    >
      <header class="g-side-head">
        <Logo size={22} />
        <div class="g-side-title">
          <strong>Annonote</strong>
          <span>{count}</span>
        </div>
        <button type="button" class="g-icon-btn" aria-label="Close sidebar" title="Close (Esc)" onClick={() => c.toggleSidebar(false)}>
          <IconClose />
        </button>
      </header>

      <div class="g-side-actions">
        <button type="button" class="g-btn" disabled={!hasContent} onClick={() => void c.copyMarkdown(root)}>
          <IconCopy size={14} />
          Copy Markdown
        </button>
        <button type="button" class="g-btn" disabled={!hasContent} onClick={() => c.downloadMarkdown(root)}>
          <IconDownload size={14} />
          .md
        </button>
        <button
          type="button"
          class="g-btn"
          disabled={!hasContent || s.busy === 'notion'}
          aria-busy={s.busy === 'notion'}
          title={s.settings.notionConfigured ? 'Send this page to your Notion database' : 'Connect Notion in the library settings'}
          onClick={() => void c.sendToNotion()}
        >
          <IconSend size={14} />
          {s.busy === 'notion' ? 'Sending…' : 'Notion'}
        </button>
      </div>

      <div class="g-side-body">
        <section class="g-section">
          <h2 class="g-label">Page note</h2>
          <AutosaveTextarea
            value={page?.pageNote ?? ''}
            label="Page note"
            placeholder="Thoughts about this page as a whole…"
            onSave={(pageNote) => void c.updatePage({ pageNote })}
          />
          <AutosaveTags tags={page?.tags ?? []} label="Page tags" onSave={(tags) => void c.updatePage({ tags })} />
          <FolderPicker value={page?.folder} folders={s.folders} label="Folder for this page" onChange={(folder) => void c.updatePage({ folder })} />
        </section>

        <section class="g-section">
          <div class="g-section-head">
            <h2 class="g-label">Highlights</h2>
            <ColorFilter annotations={annotations} value={s.colorFilter} onChange={(color) => c.setColorFilter(color)} />
          </div>
          {found.length ? (
            <ol class="g-cards">
              {found.map((a) => (
                <Card key={a.id} a={a} c={c} s={s} orphan={false} />
              ))}
            </ol>
          ) : s.colorFilter && annotations.length ? (
            <p class="g-muted">No highlights in this color.</p>
          ) : (
            <div class="g-empty">
              <p>
                <strong>Select text on the page</strong> to highlight it.
              </p>
              <p class="g-muted">
                Pick a color, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>. Add a note with <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>.
              </p>
            </div>
          )}
        </section>

        {missing.length > 0 && (
          <section class="g-section g-orphans">
            <h2 class="g-label">Not found on this page · {missing.length}</h2>
            <p class="g-muted">The page changed since you highlighted these. The quotes and your notes are kept.</p>
            <ol class="g-cards">
              {missing.map((a) => (
                <Card key={a.id} a={a} c={c} s={s} orphan />
              ))}
            </ol>
          </section>
        )}
      </div>

      <footer class="g-side-foot">
        <button type="button" class="g-link-btn" onClick={() => c.openLibrary()}>
          <IconLibrary size={14} />
          Open library
        </button>
      </footer>
    </aside>
  );
}

function Card({ a, c, s, orphan }: { a: Annotation; c: Controller; s: ViewState; orphan: boolean }) {
  const editing = s.editingId === a.id;
  const focused = s.focusId === a.id;
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focused]);

  return (
    <li ref={ref} class={`g-card g-card-${a.color}${focused ? ' is-focused' : ''}${orphan ? ' is-orphan' : ''}`}>
      {orphan ? (
        <blockquote class="g-quote">
          <QuoteContent a={a} />
        </blockquote>
      ) : (
        <button type="button" class="g-quote" title="Show on page" onClick={() => c.reveal(a.id)}>
          <QuoteContent a={a} />
        </button>
      )}
      {editing ? (
        <AnnotationEditor
          note={a.note}
          tags={a.tags}
          color={a.color}
          onSave={(patch) => {
            c.setEditing(null);
            void c.updateAnnotation(a.id, patch);
          }}
          onCancel={() => c.setEditing(null)}
          onDelete={() => void c.deleteAnnotation(a.id)}
        />
      ) : (
        <>
          {a.note.trim() && (
            <p class="g-note">
              <NoteText note={a.note} />
            </p>
          )}
          <TagChips tags={a.tags} />
          <div class="g-card-actions">
            <button type="button" class="g-link-btn" onClick={() => c.setEditing(a.id)}>
              <IconEdit size={13} />
              {a.note.trim() || a.tags.length ? 'Edit' : 'Add note'}
            </button>
          </div>
        </>
      )}
    </li>
  );
}

function ToastView({ c, s }: { c: Controller; s: ViewState }) {
  const t = s.toast!;
  return (
    <div class={`g-toast is-${t.kind}${s.sidebarOpen ? ' with-sidebar' : ''}`} role={t.kind === 'error' ? 'alert' : 'status'}>
      <span>{t.text}</span>
      {t.action === 'settings' && (
        <button type="button" class="g-link-btn" onClick={() => c.openSettings()}>
          Open settings
        </button>
      )}
      {t.href && (
        <a href={t.href} target="_blank" rel="noopener noreferrer">
          {t.linkText ?? 'Open'}
        </a>
      )}
      <button type="button" class="g-icon-btn" aria-label="Dismiss" onClick={() => c.dismissToast()}>
        <IconClose size={14} />
      </button>
    </div>
  );
}
