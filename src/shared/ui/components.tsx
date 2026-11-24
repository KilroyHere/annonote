import { useEffect, useRef, useState } from 'preact/hooks';
import { COLORS, parseTags, type Color } from '../types';
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

/** Note + tags + color editor for one highlight. Ctrl/⌘+Enter saves, Esc cancels. */
export function AnnotationEditor({
  note,
  tags,
  color,
  autoFocus = true,
  onSave,
  onCancel,
  onDelete,
}: {
  note: string;
  tags: string[];
  color: Color;
  autoFocus?: boolean;
  onSave: (patch: { note: string; tags: string[]; color: Color }) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(note);
  const [tagText, setTagText] = useState(tags.join(', '));
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

  const save = () => onSave({ note: draft, tags: parseTags(tagText), color: draftColor });
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
      <input
        aria-label="Tags"
        class="g-input"
        placeholder="Tags, separated by commas"
        value={tagText}
        onInput={(e) => setTagText(e.currentTarget.value)}
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
export function AutosaveTags({ tags, onSave, label = 'Tags' }: { tags: string[]; onSave: (t: string[]) => void; label?: string }) {
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
      placeholder="Page tags, separated by commas"
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
