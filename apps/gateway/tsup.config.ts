import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  // Workspace packages ship TypeScript sources, so they are bundled in.
  // npm dependencies (listed in package.json) stay external and resolve from node_modules.
  noExternal: [/^@ok\//],
});
