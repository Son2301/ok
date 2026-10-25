import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // Control plane: workspace packages bundled in, npm dependencies external.
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    outDir: 'dist',
    clean: false,
    sourcemap: true,
    noExternal: [/^@ok\//],
  },
  {
    // Agent runtime image: one self-contained file (no node_modules in the container).
    entry: { runtime: 'src/runtime/server.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    outDir: 'dist',
    clean: false,
    sourcemap: true,
    noExternal: [/.*/],
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  },
]);
