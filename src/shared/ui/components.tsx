import { Fragment } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { displayQuote, splitMath } from '../quote';
import { COLORS, normalizeFolder, parseTags, type Annotation, type Color } from '../types';
import { IconTrash } from './icons';

export const COLOR_LABELS: Record<Color, string> = {
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue',
  pink: 'Pink',
  purple: 'Purple',
};

export function ColorDots({
  value,
  onPick,
  label = 'Highlight color',
}: {
  value?: Color;
  onPick: (c: Color) => void;
  label?: string;
}) {
  return (
    <div class="g-dots" role="group" aria-label={label}>
      {COLORS.map((c) => (
        <button
          type="button"
          key={c}
          class={`g-dot g-dot-${c}`}
          aria-label={COLOR_LABELS[c]}
          title={COLOR_LABELS[c]}
          aria-pressed={value === undefined ? undefined : value === c}
          onClick={() => onPick(c)}
        />
      ))}
    </div>
  );
}

export function TagChips({ tags, onTag }: { tags: string[]; onTag?: (t: string) => void }) {
  if (!tags.length) return null;
  return (
    <ul class="g-tags" aria-label="Tags">
      {tags.map((t) => (
        <li key={t}>
          {onTag ? (
            <button type="button" class="g-tag" onClick={() => onTag(t)}>
              #{t}
            </button>
          ) : (
            <span class="g-tag">#{t}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Note + color editor for one highlight (tags belong to the page). Ctrl/⌘+Enter saves, Esc cancels. */
export function AnnotationEditor({
  note,
  color,
  autoFocus = true,
  onSave,
  onCancel,
  onDelete,
}: {
  note: string;
  color: Color;
  autoFocus?: boolean;
  onSave: (patch: { note: string; color: Color }) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(note);
  const [draftColor, setDraftColor] = useState<Color>(color);
  const [confirming, setConfirming] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) {
      const ta = textRef.current;
      ta?.focus({ preventScroll: true });
      ta?.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, [autoFocus]);

  const save = () => onSave({ note: draft, color: draftColor });
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation(); // keep the page's own keyboard shortcuts out of the editor
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div class="g-editor" onKeyDown={onKeyDown} onKeyUp={(e) => e.stopPropagation()} onKeyPress={(e) => e.stopPropagation()}>
      <textarea
        aria-label="Note"
        ref={textRef}
        class="g-input g-textarea"
        rows={4}
        placeholder="Add a note…"
        value={draft}
        onInput={(e) => setDraft(e.currentTarget.value)}
      />
      <div class="g-editor-row">
        <ColorDots value={draftColor} onPick={setDraftColor} />
        <span class="g-spacer" />
        {confirming ? (
          <button type="button" class="g-btn g-btn-danger" onClick={onDelete}>
            Delete highlight
          </button>
        ) : (
          <button type="button" class="g-icon-btn" aria-label="Delete highlight" title="Delete highlight" onClick={() => setConfirming(true)}>
            <IconTrash />
          </button>
        )}
      </div>
      <div class="g-editor-row g-editor-actions">
        <span class="g-hint">Ctrl+Enter to save</span>
        <span class="g-spacer" />
        <button type="button" class="g-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" class="g-btn g-btn-primary" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

/** A textarea that saves when it loses focus (used for page notes). */
export function AutosaveTextarea({
  value,
  placeholder,
  label,
  onSave,
  rows = 2,
}: {
  value: string;
  placeholder: string;
  label: string;
  onSave: (v: string) => void;
  rows?: number;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  return (
    <textarea
      class="g-input g-textarea"
      aria-label={label}
      rows={rows}
      placeholder={placeholder}
      value={draft}
      onFocus={() => setFocused(true)}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onKeyDown={(e) => e.stopPropagation()}
      onKeyUp={(e) => e.stopPropagation()}
      onBlur={() => {
        setFocused(false);
        if (draft !== value) onSave(draft);
      }}
    />
  );
}

/** A tags input that saves when it loses focus or on Enter. */
export function AutosaveTags({
  tags,
  onSave,
  label = 'Tags',
  placeholder = 'Page tags, separated by commas',
}: {
  tags: string[];
  onSave: (t: string[]) => void;
  label?: string;
  placeholder?: string;
}) {
  const joined = tags.join(', ');
  const [draft, setDraft] = useState(joined);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(joined);
  }, [joined, focused]);
  const commit = () => {
    const next = parseTags(draft);
    if (next.join(',') !== tags.join(',')) onSave(next);
  };
  return (
    <input
      class="g-input"
      aria-label={label}
      placeholder={placeholder}
      value={draft}
      onFocus={() => setFocused(true)}
      onInput={(e) => setDraft(e.currentTarget.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
      onKeyUp={(e) => e.stopPropagation()}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
    />
  );
}

/** A highlight's quote: text with math set apart (as TeX) and thumbnails for images. */
export function QuoteContent({ a }: { a: Annotation }) {
  const quote = displayQuote(a);
  // Display equations are blocks, so the line breaks around them would only add blank lines.
  const parts = splitMath(quote)
    .map((part, i, all) => {
      if (part.math) return part;
      let text = part.text;
      if (i === 0 || all[i - 1]!.display) text = text.replace(/^\s+/, '');
      if (i === all.length - 1 || all[i + 1]!.display) text = text.replace(/\s+$/, '');
      return { ...part, text };
    })
    .filter((part) => part.math || part.text);
  return (
    <>
      {quote &&
        parts.map((part, i) =>
          part.math ? (
            <code key={i} class={`g-math${part.display ? ' is-display' : ''}`} title="TeX">
              {part.text}
            </code>
          ) : (
            <span key={i}>
              {part.text.split(/\n[ \t]*\n\s*/).map((para, j) => (
                <Fragment key={j}>
                  {j > 0 && <span class="g-para-break" />}
                  {para}
                </Fragment>
              ))}
            </span>
          ),
        )}
      {!!a.images?.length && (
        <span class="g-thumbs">
          {a.images.map((img, i) =>
            img.src ? (
              <img key={i} class="g-thumb" src={img.src} alt={img.alt} title={img.alt || undefined} loading="lazy" referrerpolicy="no-referrer" />
            ) : (
              <span key={i} class="g-thumb is-missing">
                {img.alt || 'Image'}
              </span>
            ),
          )}
        </span>
      )}
    </>
  );
}

/** Note text with paragraph breaks shown as a small gap rather than a full blank line. */
export function NoteText({ note }: { note: string }) {
  return (
    <>
      {note
        .trim()
        .split(/\n[ \t]*\n\s*/)
        .map((para, i) => (
          <Fragment key={i}>
            {i > 0 && <span class="g-para-break" />}
            {para}
          </Fragment>
        ))}
    </>
  );
}

/** Dots that show only one color of highlight; only the colors in use are offered. */
export function ColorFilter({
  annotations,
  value,
  onChange,
}: {
  annotations: Annotation[];
  value: Color | null;
  onChange: (c: Color | null) => void;
}) {
  const counts = new Map<Color, number>();
  for (const a of annotations) counts.set(a.color, (counts.get(a.color) ?? 0) + 1);
  const used = COLORS.filter((c) => counts.has(c));
  if (used.length < 2 && !value) return null;
  return (
    <div class="g-color-filter" role="group" aria-label="Show only one color">
      {used.map((c) => (
        <button
          type="button"
          key={c}
          class={`g-dot g-dot-${c}`}
          aria-label={`Only ${COLOR_LABELS[c].toLowerCase()} highlights (${counts.get(c)})`}
          title={`${COLOR_LABELS[c]} · ${counts.get(c)}`}
          aria-pressed={value === c}
          onClick={() => onChange(value === c ? null : c)}
        />
      ))}
      {value && (
        <button type="button" class="g-link-btn g-filter-clear" onClick={() => onChange(null)}>
          Show all
        </button>
      )}
    </div>
  );
}

/** Indented label for a folder path in a list: "Research/ML" → "   ML". */
export function folderLabel(path: string): string {
  const parts = path.split('/');
  return `${'\u00a0\u00a0\u00a0'.repeat(parts.length - 1)}${parts[parts.length - 1]}`;
}

const NEW_FOLDER = '\u0000new';

/** Choose a folder for a page, or type a new one ("/" makes subfolders). */
export function FolderPicker({
  value,
  folders,
  onChange,
  label = 'Folder',
}: {
  value: string | undefined;
  folders: string[];
  onChange: (folder: string) => void;
  label?: string;
}) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);
  const current = value ?? '';
  const options = current && !folders.includes(current) ? [...folders, current].sort() : folders;

  if (creating) {
    const commit = () => {
      const folder = normalizeFolder(draft);
      setCreating(false);
      setDraft('');
      if (folder) onChange(folder);
    };
    return (
      <div class="g-folder-new">
        <input
          ref={inputRef}
          class="g-input"
          aria-label="New folder name"
          placeholder="Folder name (use / for subfolders)"
          value={draft}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setCreating(false);
            }
          }}
          onKeyUp={(e) => e.stopPropagation()}
        />
        <button type="button" class="g-btn g-btn-primary" onClick={commit}>
          Add
        </button>
        <button type="button" class="g-btn" onClick={() => setCreating(false)}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <select
      class="g-input g-select"
      aria-label={label}
      value={current}
      onChange={(e) => {
        const v = e.currentTarget.value;
        if (v === NEW_FOLDER) {
          e.currentTarget.value = current;
          setDraft(current ? `${current}/` : '');
          setCreating(true);
        } else if (v !== current) {
          onChange(v);
        }
      }}
    >
      <option value="">No folder</option>
      {options.map((f) => (
        <option key={f} value={f}>
          {f.replace(/\//g, ' › ')}
        </option>
      ))}
      <option value={NEW_FOLDER}>New folder…</option>
    </select>
  );
}
