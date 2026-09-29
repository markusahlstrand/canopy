/**
 * Two test projects, because this package has two runtimes in it.
 *
 * The worker's tests run in `node` and must NOT get a DOM — a module that reaches for
 * `document` in a Worker is a bug, and an ambient jsdom would hide it. The SPA's tests
 * need one, plus the React transform, which `vite.config.ts` already supplies for the
 * build. Vitest's `projects` is what keeps both true in one `pnpm test`.
 *
 * Deliberately not `environmentMatchGlobs`: it is deprecated, and it cannot give one half
 * a plugin the other half does not need.
 */
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'worker',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'app',
          include: ['app/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          // jsdom lacks ResizeObserver, which cmdk needs to render at all.
          setupFiles: ['app/src/test-setup.ts'],
        },
      },
    ],
  },
});
