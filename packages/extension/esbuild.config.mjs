// esbuild config — bundles the extension and all @cf-migrate/* workspace packages
// into a single dist/extension.js for distribution. The `vscode` module is
// always external (provided by the host).
//
// Also copies runtime assets (kb-default, prompt-templates) from the monorepo
// root into this package so vsce includes them in the VSIX.

import { build } from 'esbuild';
import { cpSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const isWatch = process.argv.includes('--watch');
const root = resolve('..', '..');

const opts = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  external: ['vscode'],
  logLevel: 'info',
  minify: false,
};

await build(opts);

// Copy runtime asset directories from the monorepo root if they exist there
// (they are the authoritative source; the copies here are VSIX-packaging artefacts).
for (const dir of ['kb-default', 'prompt-templates']) {
  const src = join(root, dir);
  const dest = join('.', dir);
  if (existsSync(src)) {
    cpSync(src, dest, { recursive: true });
  }
}
