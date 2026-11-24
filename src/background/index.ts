import type { Request, Response, TabMessage } from '../shared/messages';
import { NotionClient, parseDatabaseId, syncPageToNotion } from '../shared/notion';
import * as db from './db';

/** Requests only the extension's own pages (library, popup) may make, never content scripts. */
const PRIVILEGED = new Set<Request['type']>(['pages:list', 'pages:import', 'page:delete', 'page:setNotion']);

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return !!sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
}

async function handle(req: Request, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (PRIVILEGED.has(req.type) && !isExtensionPage(sender)) throw new Error('Not allowed');
  switch (req.type) {
    case 'page:find':
      return (await db.findPage(req.meta)) ?? null;
    case 'annotation:save':
      return db.saveAnnotation(req.meta, req.pageKey, req.annotation);
    case 'annotation:update':
      return db.updateAnnotation(req.pageKey, req.id, req.patch);
    case 'annotation:delete':
      return db.deleteAnnotation(req.pageKey, req.id);
    case 'page:update':
      return db.updatePage(req.pageKey, req.meta, req.patch);
    case 'page:delete':
      await db.deletePage(req.pageKey);
      return null;
    case 'page:setNotion':
      return db.setNotionState(req.pageKey, req.notion);
    case 'pages:list':
      return db.listPages();
    case 'pages:import':
      return db.importPages(req.pages);
    case 'notion:sync':
      return syncToNotion(req.pageKey);
    case 'settings:public': {
      const s = await db.getSettings();
      return { highlightLinks: s.highlightLinks, notionConfigured: !!(s.notionToken && parseDatabaseId(s.notionDatabaseId)) };
    }
    case 'library:open': {
      const hash = req.view === 'settings' ? '#settings' : req.pageKey ? `#page=${encodeURIComponent(req.pageKey)}` : '';
      await chrome.tabs.create({ url: chrome.runtime.getURL(`library.html${hash}`) });
      return null;
    }
    case 'badge': {
      const tabId = sender.tab?.id;
      if (tabId !== undefined) {
        await chrome.action.setBadgeText({ tabId, text: req.count > 0 ? String(req.count) : '' });
      }
      return null;
    }
  }
}

async function syncToNotion(pageKey: string): Promise<{ url?: string }> {
  const settings = await db.getSettings();
  const databaseId = parseDatabaseId(settings.notionDatabaseId);
  if (!settings.notionToken || !databaseId) {
    throw new Error('Connect Notion first: open the Gloss library → Settings.');
  }
  const page = await db.getPage(pageKey);
  if (!page) throw new Error('Nothing saved for this page yet.');
  const client = new NotionClient(settings.notionToken);
  const notion = await syncPageToNotion(client, databaseId, page, { highlightLinks: settings.highlightLinks });
  await db.setNotionState(pageKey, notion);
  return { url: notion.url };
}

chrome.runtime.onMessage.addListener((req: Request, sender, sendResponse) => {
  handle(req, sender).then(
    (data) => sendResponse({ ok: true, data } satisfies Response<unknown>),
    (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies Response<unknown>),
  );
  return true; // keep the channel open for the async response
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (tab?.id === undefined) return;
  const msg: TabMessage = { type: 'command', name: command as Extract<TabMessage, { type: 'command' }>['name'] };
  chrome.tabs.sendMessage(tab.id, msg).catch(() => {
    /* no content script on this page (e.g. chrome:// pages) */
  });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: '#3b3b46' });
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
});
