/**
 * Bundle config for `dsh-task-progress`.
 *
 * Two independent artifacts, deliberately shaped like every other DSH plugin:
 *
 * - the **host half** (`lib/index.js`, ESM, Node) is imported by the cordis
 *   tree; it touches only Node built-ins, so nothing is external and nothing
 *   needs installing.
 * - the **client half** (`lib/client.js`, CommonJS factory) is claimed by the
 *   Web shell's module loader (`window.__ModuleLoader__.load`). Only the
 *   platform words the shell seeds into its frozen module table stay external —
 *   everything this package owns is bundled in, so the plugin has no runtime
 *   dependency of its own.
 *
 * There is no CSS toolchain: the stylesheet is a string this package injects
 * itself (see `src/client/styles.ts`), which is also what keeps the plugin
 * buildable with no dependency on a CSS bundler.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
]

const host = {
  tsconfig: 'tsconfig.json',
  entry: { index: 'src/host/index.ts' },
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  fixedExtension: false,
  dts: false,
  clean: true,
}

const client = {
  tsconfig: 'tsconfig.json',
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: CLIENT_EXTERNALS,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  noExternal: (id: string) => CLIENT_EXTERNALS.includes(id) ? undefined : true,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-task-progress", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [host, client]
