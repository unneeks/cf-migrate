// esbuild config — bundles the extension and all @cf-migrate/* workspace packages
// into a single dist/extension.js for distribution. The `vscode` module is
// always external (provided by the host).

import { build } from 'esbuild';

const isWatch = process.argv.includes('--watch');

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
