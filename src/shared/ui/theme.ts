import type { Theme } from '../types';

/** True if the theme, resolved against the system setting, is dark. */
export function isDark(theme: Theme): boolean {
  if (theme !== 'system') return theme === 'dark';
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Applies a theme to an extension page (library, popup): the `.g-root` element picks
 * its colors from `data-theme`, and `color-scheme` styles scrollbars and form controls.
 */
export function applyPageTheme(root: HTMLElement, theme: Theme): void {
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme === 'system' ? 'light dark' : theme;
}
