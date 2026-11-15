import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

const root = fileURLToPath(new URL('.', import.meta.url))

/** `git describe` of the source tree, shown as the app version tooltip ('' outside a git checkout) */
function gitDescribe(): string {
  try {
    return execFileSync('git', ['describe', '--tags', '--always', '--dirty'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim()
  } catch {
    return ''
  }
}

const sharedAlias = [
  { find: /^@core$/, replacement: resolve(root, 'src/core/index.ts') },
  { find: /^@core\/(.*)$/, replacement: resolve(root, 'src/core') + '/$1' },
  { find: /^@shared\/(.*)$/, replacement: resolve(root, 'src/shared') + '/$1' },
]

/**
 * The CSP in index.html is strict for production. In dev the React refresh preamble is an inline
 * script and Vite HMR talks over ws://localhost, so relax the policy only when serving.
 */
function devCsp(): Plugin {
  return {
    name: 'doplan-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(/(<meta\s+http-equiv="Content-Security-Policy"\s+content=")([^"]*)(")/i, (_m, a: string, csp: string, c: string) => {
        const relaxed = csp
          .replace(/script-src ([^;]*)/, "script-src $1 'unsafe-inline' http://localhost:* http://127.0.0.1:*")
          .replace(/connect-src ([^;]*)/, 'connect-src $1 ws://localhost:* ws://127.0.0.1:* http://localhost:* http://127.0.0.1:*')
          .replace(/style-src ([^;]*)/, 'style-src $1 http://localhost:* http://127.0.0.1:*')
          .replace(/img-src ([^;]*)/, 'img-src $1 http://localhost:* http://127.0.0.1:*')
          .replace(/font-src ([^;]*)/, 'font-src $1 http://localhost:* http://127.0.0.1:*')
          .replace(/worker-src ([^;]*)/, 'worker-src $1 http://localhost:* http://127.0.0.1:*')
        return a + relaxed + c
      })
    },
  }
}

export default defineConfig({
  main: {
    resolve: {
      alias: [
        ...sharedAlias,
        // fflate's node build declares its own `require`, which collides with electron-vite's ESM shim.
        // Main only uses the synchronous API, so the dependency-free browser ESM build is equivalent.
        { find: /^fflate$/, replacement: resolve(root, 'node_modules/fflate/esm/browser.js') },
      ],
    },
    build: {
      outDir: 'out/main',
      target: 'node24',
      sourcemap: true,
      rolldownOptions: {
        input: { index: resolve(root, 'src/main/index.ts') },
        output: { format: 'es', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    resolve: { alias: sharedAlias },
    build: {
      outDir: 'out/preload',
      // sandboxed preloads can only require('electron'): bundle everything else, emit one CJS file
      externalizeDeps: false,
      sourcemap: 'inline',
      rolldownOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
        external: ['electron'],
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
          codeSplitting: false,
        },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer'),
    resolve: {
      alias: [
        ...sharedAlias,
        { find: /^@\/(.*)$/, replacement: resolve(root, 'src/renderer/src') + '/$1' },
        // bare `three` → WebGPU build; `three/webgpu`, `three/tsl`, `three/addons/*` stay untouched
        { find: /^three$/, replacement: 'three/webgpu' },
      ],
      dedupe: ['three', 'react', 'react-dom'],
    },
    define: { __APP_GIT__: JSON.stringify(gitDescribe()) },
    plugins: [react(), tailwindcss(), devCsp()],
    worker: {
      format: 'es',
    },
    optimizeDeps: {
      exclude: ['xatlas-web'],
    },
    build: {
      outDir: 'out/renderer',
      target: 'chrome140',
      sourcemap: true,
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 4000,
      rolldownOptions: {
        input: { index: resolve(root, 'src/renderer/index.html') },
        output: {
          codeSplitting: {
            groups: [
              {
                name: 'pathtracer',
                test: /[\\/]node_modules[\\/](three-gpu-pathtracer|three-mesh-bvh|xatlas-web)[\\/]/,
                priority: 30,
              },
              {
                name: 'engine3d',
                test: /[\\/]node_modules[\\/]three[\\/]|[\\/]src[\\/]renderer[\\/]src[\\/]view3d[\\/]/,
                priority: 20,
              },
              {
                name: 'pixi',
                test: /[\\/]node_modules[\\/](pixi\.js|@pixi)[\\/]/,
                priority: 10,
              },
              {
                name: 'react',
                test: /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/,
                priority: 10,
              },
            ],
          },
        },
      },
    },
  },
})
