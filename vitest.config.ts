import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = fileURLToPath(new URL('.', import.meta.url))

// Same aliases as tsconfig/electron.vite.config.ts. Bare `three` stays the classic build here:
// tests run in Node, where only geometry/scene-graph code (no renderer) is exercised.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@core$/, replacement: resolve(root, 'src/core/index.ts') },
      { find: /^@core\/(.*)$/, replacement: resolve(root, 'src/core') + '/$1' },
      { find: /^@shared\/(.*)$/, replacement: resolve(root, 'src/shared') + '/$1' },
      { find: /^@\/(.*)$/, replacement: resolve(root, 'src/renderer/src') + '/$1' },
    ],
  },
  test: {
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'out/**', 'tools/assets/.cache/**'],
    environment: 'node',
  },
})
