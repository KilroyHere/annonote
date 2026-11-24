import { render } from 'preact';
import componentsCss from '../shared/ui/components.css';
import { App } from './App';
import { Controller } from './controller';
import sidebarCss from './ui.css';

declare global {
  interface Window {
    __glossLoaded?: boolean;
  }
}

/**
 * Content script entry. The UI lives in a closed shadow root attached outside
 * <body>, so page styles can't reach it and page scripts can't read your notes.
 * It is only created once something needs to be shown.
 */
function main() {
  if (window.__glossLoaded) return;
  // Only ordinary HTML pages (not SVG/XML documents or image views).
  if (!(document.documentElement instanceof HTMLHtmlElement) || !document.body) return;
  window.__glossLoaded = true;

  let host: HTMLElement | null = null;
  const controller = new Controller((e) => !!host && e.composedPath().includes(host));

  const mount = () => {
    if (host) return;
    host = document.createElement('gloss-root');
    host.setAttribute(
      'style',
      'all: initial !important; position: fixed !important; inset: 0 auto auto 0 !important; width: 0 !important; height: 0 !important; z-index: 2147483647 !important; display: block !important;',
    );
    const shadow = host.attachShadow({ mode: typeof __E2E__ !== 'undefined' && __E2E__ ? 'open' : 'closed' });
    const style = document.createElement('style');
    style.textContent = componentsCss + sidebarCss;
    shadow.appendChild(style);
    const container = document.createElement('div');
    container.className = 'g-root';
    shadow.appendChild(container);
    document.documentElement.appendChild(host);
    render(<App c={controller} root={shadow} />, container);
  };

  controller.subscribe(() => {
    const s = controller.state;
    if (!host && (s.toolbar || s.sidebarOpen || s.toast)) mount();
  });

  controller.start().catch((err: unknown) => {
    // The extension was reloaded or updated while this page stayed open.
    console.debug('[Gloss] could not start:', err);
  });
}

main();
