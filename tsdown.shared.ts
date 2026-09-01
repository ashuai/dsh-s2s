import type { UserConfig } from 'tsdown'

/**
 * Build a Node-side plugin from JavaScript emitted by TypeScript. The
 * browser bundle helpers (clientBundle + the CSS-modules pipeline) were
 * removed with the browser package this fork trims; re-add them only if a
 * browser surface ever returns.
 */
export function hostBundle(name: string): UserConfig {
  return {
    name,
    entry: ['lib/types/index.js', 'lib/types/invariant.js'],
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    dts: false,
    clean: false,
    outputOptions: {
      entryFileNames: '[name].js',
    },
  }
}
