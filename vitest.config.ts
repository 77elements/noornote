import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default: pure logic (no DOM). DOM-heavy tests opt in per file with:
    //   // @vitest-environment jsdom
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
