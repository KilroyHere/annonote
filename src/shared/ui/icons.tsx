import type { JSX } from 'preact';

type IconProps = { size?: number };

function svg(path: JSX.Element, { size = 16 }: IconProps, viewBox = '0 0 24 24') {
  return (
    <svg
      width={size}
      height={size}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {path}
    </svg>
  );
}

export const IconClose = (p: IconProps) => svg(<path d="M18 6 6 18M6 6l12 12" />, p);
export const IconEdit = (p: IconProps) => svg(<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />, p);
export const IconTrash = (p: IconProps) =>
  svg(<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6" />, p);
export const IconCopy = (p: IconProps) =>
  svg(
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>,
    p,
  );
export const IconDownload = (p: IconProps) => svg(<path d="M12 3v12M7 10l5 5 5-5M5 21h14" />, p);
export const IconExternal = (p: IconProps) => svg(<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />, p);
export const IconLibrary = (p: IconProps) => svg(<path d="M4 4h4v16H4zM10 4h4v16h-4zM16 5l4 1-3 14-4-1z" />, p);
export const IconNote = (p: IconProps) => svg(<path d="M4 4h16v12l-4 4H4zM16 20v-4h4M8 9h8M8 13h5" />, p);
export const IconSend = (p: IconProps) => svg(<path d="M22 2 11 13M22 2l-7 20-4-9-9-4Z" />, p);
export const IconSearch = (p: IconProps) =>
  svg(
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>,
    p,
  );
export const IconSettings = (p: IconProps) =>
  svg(
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
    </>,
    p,
  );
export const IconUpload = (p: IconProps) => svg(<path d="M12 21V9M7 14l5-5 5 5M5 3h14" />, p);

/** The Annonote mark: a highlighter stroke under a line of text. */
export function Logo({ size = 20 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#26262e" />
      <rect x="6" y="15" width="20" height="8" rx="2" fill="#ffd60a" />
      <rect x="6" y="9" width="14" height="3" rx="1.5" fill="#ffffff" opacity="0.9" />
      <rect x="9" y="17.5" width="14" height="3" rx="1.5" fill="#26262e" />
    </svg>
  );
}
