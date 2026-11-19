/**
 * Build of the published plan viewer (GitHub Pages): a read-only 2D + 3D page from the same renderer
 * sources, relative URLs (`base: './'`) so one build works in any plan folder. Output: out/viewer,
 * copied next to plan.json by the publish step (src/main/pages.ts). `pnpm build` runs it after the app.
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  root: resolve(root, 'src/renderer'),
  base: './',
  publicDir: resolve(root, 'src/renderer/public'),
  resolve: {
    alias: [
      { find: /^@core$/, replacement: resolve(root, 'src/core/index.ts') },
      { find: /^@core\/(.*)$/, replacement: resolve(root, 'src/core') + '/$1' },
      { find: /^@shared\/(.*)$/, replacement: resolve(root, 'src/shared') + '/$1' },
      { find: /^@\/(.*)$/, replacement: resolve(root, 'src/renderer/src') + '/$1' },
      // bare `three` → WebGPU build (WebGL2 fallback inside), as in the app
      { find: /^three$/, replacement: 'three/webgpu' },
    ],
    dedupe: ['three', 'react', 'react-dom'],
  },
  define: { __APP_GIT__: JSON.stringify('') },
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['xatlas-web'] },
  build: {
    outDir: resolve(root, 'out/viewer'),
    emptyOutDir: true,
    target: 'es2022',
    // no source maps: they would double the size of every published plan
    sourcemap: false,
    assetsInlineLimit: 0,
    assetsDir: 'viewer',
    chunkSizeWarningLimit: 4000,
    rolldownOptions: {
      input: { index: resolve(root, 'src/renderer/viewer.html') },
      output: {
        codeSplitting: {
          groups: [
            // three, the 3D view and the path tracer have no group of their own: they load with the 3D
            // view and its path tracing (dynamic imports); the plan and its 2D come first
            { name: 'pixi', test: /[\\/]node_modules[\\/](pixi\.js|@pixi)[\\/]/, priority: 10 },
            { name: 'react', test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/, priority: 10 },
          ],
        },
      },
    },
  },
})
