// Zips dist/ into release/annonote-<version>.zip (for "Load unpacked" or the Chrome Web Store).
import * as esbuild from 'esbuild';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

// Reuse the extension's own ZIP writer.
const { code } = await esbuild.transform(readFileSync(join(root, 'src/shared/zip.ts'), 'utf8'), { loader: 'ts', format: 'esm' });
const { createZip } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const entries = walk(dist)
  .sort()
  .map((file) => ({ name: relative(dist, file).split('\\').join('/'), data: new Uint8Array(readFileSync(file)) }));
mkdirSync(join(root, 'release'), { recursive: true });
const out = join(root, 'release', `annonote-${version}.zip`);
writeFileSync(out, createZip(entries));
console.log(`Wrote ${relative(root, out)} (${entries.length} files)`);
