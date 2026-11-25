import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { send, type TabMessage, type TabStatus } from '../shared/messages';
import componentsCss from '../shared/ui/components.css';
import { IconLibrary, IconNote, Logo } from '../shared/ui/icons';
import popupCss from './popup.css';

type State = { kind: 'loading' } | { kind: 'ready'; tabId: number; status: TabStatus } | { kind: 'unsupported' };

function Popup() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) return setState({ kind: 'unsupported' });
      try {
        const status = (await chrome.tabs.sendMessage(tab.id, { type: 'status' } satisfies TabMessage)) as TabStatus | undefined;
        setState(status ? { kind: 'ready', tabId: tab.id, status } : { kind: 'unsupported' });
      } catch {
        setState({ kind: 'unsupported' });
      }
    })();
  }, []);

  const openSidebar = async () => {
    if (state.kind !== 'ready') return;
    await chrome.tabs.sendMessage(state.tabId, { type: 'sidebar:open' } satisfies TabMessage);
    window.close();
  };

  const openLibrary = async () => {
    await send({ type: 'library:open' });
    window.close();
  };

  return (
    <div class="p-wrap">
      <header class="p-head">
        <Logo size={24} />
        <strong>Annonote</strong>
      </header>
      {state.kind === 'ready' && (
        <p class="p-status">
          {state.status.count === 0
            ? 'No highlights on this page yet. Select text to start.'
            : `${state.status.count} highlight${state.status.count === 1 ? '' : 's'} on this page${
                state.status.orphans ? ` (${state.status.orphans} not found)` : ''
              }.`}
        </p>
      )}
      {state.kind === 'unsupported' && (
        <p class="p-status g-muted">
          Annonote can't run on this page. Browser pages, the Chrome Web Store and PDFs aren't supported yet. If you just installed Annonote,
          reload the page.
        </p>
      )}
      <div class="p-actions">
        <button type="button" class="g-btn" disabled={state.kind !== 'ready'} onClick={() => void openSidebar()}>
          <IconNote size={15} />
          Open sidebar
        </button>
        <button type="button" class="g-btn" onClick={() => void openLibrary()}>
          <IconLibrary size={15} />
          Library
        </button>
      </div>
      <p class="p-hint g-hint">
        <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> highlight · <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> sidebar
      </p>
    </div>
  );
}

const style = document.createElement('style');
style.textContent = componentsCss + popupCss;
document.head.appendChild(style);
render(<Popup />, document.getElementById('app')!);
