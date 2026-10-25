import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file boots its own in-process PGlite database; give slow CI machines headroom.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
