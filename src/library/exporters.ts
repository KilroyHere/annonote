import { toBackup } from '../shared/backup';
import { markdownFilenames, pageToMarkdown } from '../shared/markdown';
import type { Page } from '../shared/types';
import { createZip } from '../shared/zip';

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function exportMarkdownZip(pages: Page[], highlightLinks: boolean): void {
  const names = markdownFilenames(pages);
  const zip = createZip(
    pages.map((p) => ({
      name: names.get(p.key)!,
      data: pageToMarkdown(p, { highlightLinks }),
      date: new Date(p.updated),
    })),
  );
  downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), `gloss-markdown-${stamp()}.zip`);
}

export function exportMarkdownFile(page: Page, highlightLinks: boolean): void {
  const name = markdownFilenames([page]).get(page.key)!;
  downloadBlob(new Blob([pageToMarkdown(page, { highlightLinks })], { type: 'text/markdown;charset=utf-8' }), name);
}

export function exportBackup(pages: Page[]): void {
  const json = JSON.stringify(toBackup(pages), null, 2);
  downloadBlob(new Blob([json], { type: 'application/ld+json' }), `gloss-backup-${stamp()}.json`);
}

/** Downloads all of a user's annotations from the Hypothesis API. */
export async function fetchHypothesis(
  username: string,
  token: string,
  onProgress: (loaded: number, total: number) => void,
): Promise<unknown[]> {
  const name = username.trim().replace(/^@/, '');
  const acct = name.startsWith('acct:') ? name : `acct:${name}@hypothes.is`;
  const rows: unknown[] = [];
  let searchAfter: string | undefined;
  for (;;) {
    const params = new URLSearchParams({ user: acct, limit: '200', sort: 'updated', order: 'asc' });
    if (searchAfter) params.set('search_after', searchAfter);
    const res = await fetch(`https://api.hypothes.is/api/search?${params}`, {
      headers: {
        Accept: 'application/vnd.hypothesis.v1+json',
        ...(token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {}),
      },
    });
    if (res.status === 401 || res.status === 403) throw new Error('Hypothesis rejected the API token.');
    if (!res.ok) throw new Error(`Hypothesis returned an error (${res.status}).`);
    const json = (await res.json()) as { rows?: { updated?: string }[]; total?: number };
    const batch = json.rows ?? [];
    rows.push(...batch);
    onProgress(rows.length, json.total ?? rows.length);
    const last = batch[batch.length - 1];
    if (batch.length < 200 || !last?.updated) break;
    searchAfter = last.updated;
  }
  return rows;
}
