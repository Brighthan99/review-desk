import * as esbuild from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

// A release build starts from an empty dist so no dev source maps get packaged.
if (production) rmSync('dist', { recursive: true, force: true });

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    external: ['vscode'],
  }),
  // The MCP server the Claude Code chat starts; it runs outside VS Code, so no vscode module.
  esbuild.context({
    ...common,
    entryPoints: ['src/mcp/main.ts'],
    outfile: 'dist/mcp.js',
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    define: { REVIEW_DESK_VERSION: JSON.stringify(pkg.version) },
  }),
  // Diagrams in summaries: its own file, loaded only when there is one to draw.
  esbuild.context({
    ...common,
    entryPoints: ['webview/mermaid.ts'],
    outdir: 'dist/webview',
    entryNames: 'mermaid',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    sourcemap: false,
    logLevel: 'warning',
  }),
  esbuild.context({
    ...common,
    entryPoints: ['webview/main.tsx'],
    outdir: 'dist/webview',
    entryNames: 'main',
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
  }),
]);

if (watch) {
  await Promise.all(contexts.map((c) => c.watch()));
} else {
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
}
