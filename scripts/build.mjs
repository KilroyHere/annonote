// Bundles the extension into dist/. Usage: node scripts/build.mjs [--watch]
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');
// --e2e opens the content script's shadow root so Playwright can reach the UI.
const e2e = process.argv.includes('--e2e');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function copyStatic() {
  mkdirSync(dist, { recursive: true });
  cpSync(join(src, 'static'), dist, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(src, 'manifest.json'), 'utf8'));
  manifest.version = pkg.version;
  writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
}

rmSync(dist, { recursive: true, force: true });
copyStatic();

const options = {
  entryPoints: {
    background: join(src, 'background/index.ts'),
    content: join(src, 'content/index.tsx'),
    library: join(src, 'library/index.tsx'),
    popup: join(src, 'popup/index.tsx'),
  },
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.css': 'text' },
  define: { __VERSION__: JSON.stringify(pkg.version), __E2E__: JSON.stringify(e2e) },
  sourcemap: watch ? 'inline' : false,
  minify: false,
  legalComments: 'none',
  logLevel: 'info',
  plugins: [
    {
      name: 'static-files',
      setup(build) {
        build.onEnd(() => copyStatic());
      },
    },
  ],
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log('Watching for changes…');
} else {
  await esbuild.build(options);
}
