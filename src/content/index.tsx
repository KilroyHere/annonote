import { render } from 'preact';
import componentsCss from '../shared/ui/components.css';
import { App } from './App';
import { Controller } from './controller';
import sidebarCss from './ui.css';

declare global {
  interface Window {
    __annonoteLoaded?: boolean;
  }
}

/**
 * Content script entry. The UI lives in a closed shadow root attached outside
 * <body>, so page styles can't reach it and page scripts can't read your notes.
 * It is only created once something needs to be shown.
 */
function main() {
  if (window.__annonoteLoaded) return;
  // Only ordinary HTML pages (not SVG/XML documents or image views).
  if (!(document.documentElement instanceof HTMLHtmlElement) || !document.body) return;
  window.__annonoteLoaded = true;

  let host: HTMLElement | null = null;
  let overlays: HTMLElement | null = null;
  let container: HTMLElement | null = null;
  const controller = new Controller((e) => !!host && e.composedPath().includes(host));

  const applyTheme = () => {
    if (!container) return;
    const { theme } = controller.state.settings;
    if (theme === 'system') delete container.dataset.theme;
    else container.dataset.theme = theme;
  };

  const mount = () => {
    if (host) return;
    host = document.createElement('annonote-root');
    host.setAttribute(
      'style',
      'all: initial !important; position: fixed !important; inset: 0 auto auto 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important;',
    );
    const shadow = host.attachShadow({ mode: typeof __E2E__ !== 'undefined' && __E2E__ ? 'open' : 'closed' });
    const style = document.createElement('style');
    style.textContent = componentsCss + sidebarCss;
    shadow.appendChild(style);
    // Boxes over highlighted math and images sit under the toolbar and sidebar.
    overlays = document.createElement('div');
    overlays.className = 'g-overlays';
    shadow.appendChild(overlays);
    container = document.createElement('div');
    container.className = 'g-root';
    shadow.appendChild(container);
    applyTheme();
    document.documentElement.appendChild(host);
    render(<App c={controller} root={shadow} />, container);
  };

  controller.setOverlayLayer(() => {
    mount();
    return overlays!;
  });

  controller.subscribe(() => {
    const s = controller.state;
    if (!host && (s.toolbar || s.sidebarOpen || s.toast || s.media)) mount();
    applyTheme();
  });

  controller.start().catch((err: unknown) => {
    // The extension was reloaded or updated while this page stayed open.
    console.debug('[Annonote] could not start:', err);
  });
}

main();
