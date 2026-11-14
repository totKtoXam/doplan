# doplan: Electron 45 optimisation, security and architecture (research, 2026-11-12)

Scope: how to build an Electron 45 app with heavy WebGL content that is fast, small, secure and maintainable on Windows (dev box: Intel Arc iGPU, 32 GB RAM). Facts marked **[V]** were verified today against npm or official docs. Items marked **[J]** are engineering judgement. Items marked **[T]** are unverified and must be tested early in the project.

---

## 0. Findings that change decisions

1. **Node on the dev machine is 23.3.0 (nvm). Vitest 5.1.0 requires `^22.12 || ^24 || >=26` [V], so Node 23 is outside its range.** Install Node 24 (even LTS; Electron 45 itself embeds Node 24.22.2 [V]) and pin it in `.nvmrc` and `engines`.
2. **Electron 45.3.1 = Chromium 156.0.8078.96, Node 24.22.2, V8 15.6.75.50 [V].** Electron 45 makes sandboxed preloads leaner. `Buffer`, `setImmediate` and the `events`/`timers`/`url` shims are gone, and `require` only resolves `electron`, `electron/renderer` and `electron/common` [V]. The preload must therefore be a single self-contained bundle with no Node built-ins.
3. **Electron 42+ no longer downloads the binary in `postinstall` [V].** The binary is fetched on first run and `ELECTRON_SKIP_BINARY_DOWNLOAD` is unsupported. A `pnpm install` on CI therefore does not guarantee a binary. Add an explicit `install-electron` step in CI. Check the exact command in the Electron 42 docs when wiring CI.
4. **TypeScript 7.0.2 is the latest [V], but `typescript-eslint@8.72.2` only supports `typescript <6.1.0` [V].** Do not use typescript-eslint. Type-check with `tsc` 7, and lint and format with Biome (no TS compiler API needed).
5. **electron-builder 26 on Windows with pnpm has an open regression [V]** (issue #9580). It affects aliased dependencies in hoisted mode on 26.3.1 through 26.7.0, and I did not confirm it is fixed. Mitigation in section 1.
6. **`@vitejs/plugin-react@6.3.0` is built for Vite 8 (Oxc/Rolldown) [V]** and Babel is opt-in via `@rolldown/plugin-babel`. Do not depend on Babel plugins for the renderer.
7. **WebGPU needs no flag on Windows in Chromium 156 [J].** Check `navigator.gpu.requestAdapter()` at runtime. WebGPU's fallback adapter on Windows is SwiftShader over Vulkan [V]. A packaging bug that killed the GPU process in MSIX builds was fixed in Electron 42.11 / 43.5 / 44.1 and the fix is in 45 [V, PR 53174]. We ship NSIS, not MSIX, so this does not apply. See section 7.

---

## 1. Build tooling and packaging

### Decision: **electron-vite 6.0.0 + electron-builder 26.18.0 + electron-updater 6.8.11**

| Option | Verdict |
|---|---|
| **electron-vite 6.0.0** (Vite 8.3.8 / Rolldown 1.2) | **Chosen.** Peer `vite ^6 || ^7 || ^8`, Node `^20.19 || >=22.12` [V]. It gives one config for main/preload/renderer, HMR for the renderer, restart for main/preload, `?modulePath` / `?nodeWorker` imports for `utilityProcess` and worker_threads, and Rolldown speed. 6.0.0 shipped 14 Oct 2026 with Vite 8 support and accepts both `rollupOptions` and `rolldownOptions` [V]. |
| Electron Forge 8.0.1 + `plugin-vite` | Rejected. Forge's packaging crawler does not handle symlinked deps, so with pnpm it needs `node-linker=hoisted` [V]. It has no NSIS differential-update story comparable to electron-builder. |
| electron-builder 26.18.0 | **Chosen for packaging.** Dist-tags: `latest` 26.18.0, `v26` 26.18.1, `next` 27.0.0-alpha.14 [V]. NSIS installer, blockmap differential updates via electron-updater, `azureSignOptions`, `electronFuses`. Pin exact 26.x and avoid v27 alpha. |

### pnpm on Windows: required settings

`.npmrc`:

```ini
node-linker=hoisted        # electron-builder docs: pnpm needs hoisted / public-hoist-pattern=* / shamefully-hoist [V]
strict-peer-dependencies=false
```

- Hoisting is needed only by the packager. Because everything in `renderer`, `preload` and `main` is bundled by Rolldown, **put almost all packages in `devDependencies`**. Only `electron-updater` (and `electron-log` if used) belong in `dependencies`. This keeps `node_modules` in the package tiny and sidesteps the #9580 aliased-dependency bug.
- Do not use `npm:`-aliased or tarball dependencies.
- If a native module is ever needed (for example `sharp` 0.35.5), add it to `dependencies`, list it in `asarUnpack`, and keep it out of the bundle via `externalizeDeps`. Prefer no native modules (section 2): the renderer-side `createImageBitmap` + OffscreenCanvas path replaces sharp for thumbnails.
- Pin `"packageManager": "pnpm@<exact>"` (latest on npm is 12.18.0 [V]; the dev box has pnpm 10, so choose one and pin it with Corepack). Pin Node with `.nvmrc` = 24.
- pnpm 10+ blocks dependency lifecycle scripts by default. List allowed ones in `pnpm.onlyBuiltDependencies`. With Electron 42+ not needing postinstall, this list should be nearly empty.

### Packaging settings (electron-builder)

- Target: `nsis` (per-user install, `oneClick: false`, `perMachine: false`, `allowToChangeInstallationDirectory: true`) plus an optional `portable` zip target for testers.
- `asar: true`. Electron 45 reads ASAR files faster directly from the archive [V]. Put large static assets (built-in model libraries, HDRIs, textures) in `extraResources` (outside asar) so they stream straight from disk through the asset protocol with range support (section 5).
- `compression: "normal"`. Asset packs are already compressed (KTX2, meshopt GLB), and `maximum` only slows the build.
- **Fuses** (apply with electron-builder's `electronFuses` or `@electron/fuses` 2.1.3 in an `afterPack` hook) [V list of fuses]:
  - `RunAsNode: false`
  - `EnableNodeOptionsEnvironmentVariable: false`
  - `EnableNodeCliInspectArguments: false` **for release builds only** (see testing, section 14)
  - `EnableEmbeddedAsarIntegrityValidation: true` (Windows supported from Electron 30 [V])
  - `OnlyLoadAppFromAsar: true`
  - `GrantFileProtocolExtraPrivileges: false` (we never load `file://`)
  - `EnableCookieEncryption`: irrelevant (no cookies).
- **Do not use `electron-vite-plugin-bytecode` / electron-vite's built-in bytecode option.** It requires `sandbox: false` for preload scripts [V], and it is tied to V8 version and CPU arch. We keep the sandbox on, so it is incompatible. Use Node's compile cache instead (section 6).
- Code signing: Windows needs it for a clean SmartScreen experience. Electron docs describe Azure Artifact Signing (formerly Trusted Signing) as the cheapest option, available only to developers in certain countries [V]. electron-builder reads `win.azureSignOptions` (publisherName, endpoint, codeSigningAccountName, certificateProfileName) [V]. Verify exact field names in the v26 docs. If it is unavailable, an OV/EV certificate is the alternative, and unsigned builds are acceptable only for private testing.

---

## 2. Process model

```
main (thin, Node 24)            owns windows, protocol handlers, IPC router, updater, menus, settings, crash handling
 ├─ preload (sandboxed, CJS)    ~100 lines: contextBridge API + MessagePort relay. No logic.
 ├─ renderer (Chromium)         React UI + R3F canvas on main thread
 │    ├─ worker: geometry      Comlink; room detection, wall mitering, triangulation, snapping index
 │    ├─ worker: texture/thumb createImageBitmap, OffscreenCanvas thumbnails, KTX2 transcode, mesh decode
 │    └─ (optional) worker: render-thumbs  OffscreenCanvas + its own WebGLRenderer for asset thumbnails
 └─ utilityProcess "io-worker"  project zip/unzip, asset download, hash, gltf-transform pipeline, library indexing
```

Rules:

1. **Main stays thin.** Main never does CPU-heavy work, never uses sync IPC, and never uses `@electron/remote` [V, Electron performance guide].
2. **Heavy IO goes to `utilityProcess`, not `worker_threads`.** A utility process is launched via the Chromium Services API, is crash-isolated, appears in `app.getAppMetrics()` by `serviceName`, can talk to renderers over `MessagePort`, and a crash is reported through `child-process-gone` [V]. Use `fork(modulePath, [], { serviceName: 'doplan-io', stdio: 'pipe' })` with the path from electron-vite's `?modulePath` import [V]. Utility process stdin must be `ignore` [V].
3. **Renderer CPU work goes to Web Workers** (geometry, decoding). Libraries: Comlink 4.4.2 [V] with `Comlink.transfer(buf, [buf])` for zero-copy. Keep workers pure (no DOM, no three scene objects), exchanging typed arrays and plain data.
4. **Never run user-supplied or downloaded model parsing in main.** Parsing runs in the renderer worker (sandboxed by Chromium) or in the utility process.
5. `BrowserWindow` options: `webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, spellcheck: false, backgroundThrottling: true }`. Do not enable `experimentalFeatures`, `enableBlinkFeatures` or `allowRunningInsecureContent` [V checklist].
6. One window for the editor (2D and 3D are two views inside the same renderer, so GPU memory is shared). Secondary windows (export preview) only if needed.

---

## 3. IPC design

**Principle: small typed surface, validated on both sides, binary data never goes through `invoke`.**

- A single `src/shared/ipc-contract.ts` defines channels as a TypeScript map: `{ 'project:open': { req: OpenReq; res: OpenRes } }`, with Zod 4.6.7 [V] schemas for runtime validation of every request in main.
- Preload exposes `window.doplan` with one function per capability (`project.open()`, `assets.import()`, `settings.get()`), not a generic `invoke(channel)` (Electron checklist: do not expose raw IPC to the page [V]).
- Main registers handlers through a wrapper that (a) validates `event.senderFrame.url` has origin `app://` (checklist item "validate the sender of all IPC messages" [V]), (b) parses the payload with Zod, (c) catches errors into a typed `Result`.
- ~80 lines of own code beats `electron-trpc` and similar (stale-risk dependencies, extra bundle).
- **Binary / large data**:
  - `ipcRenderer.invoke` and `send` use structured clone and copy; transfer lists work only through `postMessage` with `MessagePort` [V: ports can be transferred only via `ipcRenderer.postMessage` and `WebContents.postMessage`].
  - Pattern: main creates `new MessageChannelMain()`, sends `port1` to the utility process with `child.postMessage(msg, [port1])` and `port2` to the renderer via `webContents.postMessage('io-port', null, [port2])`. The preload receives it and forwards to the page's main world with `window.postMessage('io-port', '*', event.ports)` (required with contextIsolation, and the docs say to wait for the page to register its listener first) [V]. After that, renderer and utility process exchange `ArrayBuffer`s directly with transfer lists, **bypassing main entirely**.
  - Reply streams (progress of a download or export) use a per-request channel that is closed at the end [V].
  - Reading assets for rendering does not use IPC at all. It uses the custom protocol (section 5).

---

## 4. Security baseline (checklist items from Electron docs [V])

- contextIsolation on, sandbox on, nodeIntegration off, webSecurity on.
- **CSP** delivered as a response header from the `app://` protocol handler (and mirrored in `<meta>`):
  ```
  default-src 'none';
  script-src 'self' 'wasm-unsafe-eval';          # wasm for basis/draco/meshopt/path tracer
  style-src 'self' 'unsafe-inline';              # Radix/floating-ui inline positioning styles
  img-src 'self' data: blob: doplan-asset:;
  media-src 'self' blob: doplan-asset:;
  font-src 'self';
  connect-src 'self' doplan-asset: blob:;
  worker-src 'self' blob:;
  object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  ```
  No remote origins at runtime. Online asset download happens in the utility process, not the renderer, so the renderer never needs `connect-src https:`.
- Navigation: `webContents.on('will-navigate')` blocks anything outside `app://`; `setWindowOpenHandler(() => ({ action: 'deny' }))`; `shell.openExternal` only for allow-listed `https:` URLs.
- `session.setPermissionRequestHandler(() => false)` and `setPermissionCheckHandler(() => false)` (no camera or geolocation needed; if photo-to-plan capture is added later, allow `media` explicitly).
- Fuses as in section 1.
- Single instance lock via `app.requestSingleInstanceLock()` [V]. Open `.doplan` files passed to the second instance through the `second-instance` event.
- Windows: `app.setAppUserModelId('com.doplan.app')` [V] and register the `.doplan` file association in the NSIS config.
- Downloaded assets are untrusted: verify the licence and hash metadata, decode them in a worker or the utility process, enforce size and triangle-count limits, and never `eval` anything from a model file.
- Validate project files on load with Zod before they reach state, and cap array lengths and string sizes. A `.doplan` file is untrusted input.

---

## 5. Custom privileged protocols (instead of `file://`)

Electron docs recommend serving local content through custom protocols rather than `file://` [V], and the `GrantFileProtocolExtraPrivileges` fuse can then be off.

Register before `ready`, once [V]:

```ts
protocol.registerSchemesAsPrivileged([
  // UI bundle: standard+secure so relative URLs, storage, workers and service APIs behave like https; codeCache for V8 code cache of bundles
  { scheme: 'app',          privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  // User/library assets: streaming for <video>/range, fetch for loaders. Deliberately NO bypassCSP.
  { scheme: 'doplan-asset', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
])
```

Page URLs: `app://ui/index.html`, assets `doplan-asset://lib/<assetId>/<file>` and `doplan-asset://proj/<projectSessionId>/<hash>.<ext>`. Resolve by **IDs through a registry**, not raw filesystem paths. Reject `..` and absolute paths, and compare `path.relative` from the resolved root as in the docs example [V]. Use `realpath` to defeat junctions or symlinks. Use `request.initiatorOrigin` (not `referrer`) for access decisions [V].

Handler skeleton:

```ts
protocol.handle('doplan-asset', async (req) => {
  const file = resolveAsset(new URL(req.url));                 // registry lookup + containment check, else 404
  const st = await fs.promises.stat(file.path);
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304 });
  const range = parseRange(req.headers.get('range'), st.size); // single range only
  const base = { 'content-type': mime(file.path), 'accept-ranges': 'bytes', etag,
                 'cache-control': file.immutable ? 'public, max-age=31536000, immutable' : 'no-cache' };
  if (!range) return new Response(Readable.toWeb(fs.createReadStream(file.path)) as any,
                                  { status: 200, headers: { ...base, 'content-length': String(st.size) } });
  return new Response(Readable.toWeb(fs.createReadStream(file.path, range)) as any, {
    status: 206,
    headers: { ...base, 'content-range': `bytes ${range.start}-${range.end}/${st.size}`,
               'content-length': String(range.end - range.start + 1) } });
});
```

Notes:
- `net.fetch(pathToFileURL(...))` is the documented way to forward to a file [V], but the docs do not describe `Range` behaviour. **[T]** Test whether it handles `Range` for large GLB/HDR/video. The explicit stream above is deterministic, so prefer it for the asset scheme and use `net.fetch(file://)` for the small `app://` bundle.
- **Content-addressed immutable URLs** (`/<sha256>.glb`) get `immutable` caching, so reopening a project does not re-read or re-decode unchanged files. Library assets are versioned by pack hash.
- Loaders (`GLTFLoader`, `KTX2Loader`, `RGBELoader`) fetch these URLs directly. Textures decode in workers via `ImageBitmapLoader` + `createImageBitmap`.
- Stream backpressure: `Readable.toWeb` handles it. Always destroy the stream on request abort (`req.signal`).
- `app://` handler also sets the CSP and `Cross-Origin-Opener-Policy: same-origin` / `Cross-Origin-Embedder-Policy: require-corp` headers **only if** we later need `SharedArrayBuffer` for worker-shared geometry or wasm threads. COEP then requires `Cross-Origin-Resource-Policy` on `doplan-asset://` responses. **[J]** Leave off until needed.
- `protocol.registerSource()` is listed in the Electron 45 notes via a summarising fetch, but I could not confirm it in the protocol API docs (search found nothing). Do not rely on it **[T]**.

---

## 6. Startup performance

Targets (to be enforced in CI): window visible with UI shell < 600 ms on warm start, 3D chunk interactive < 1.5 s after, on the Arc iGPU box.

1. **Main process**
   - Single bundled ESM or CJS file. Prefer **CJS** for main and preload unless top-level await is needed. ESM in main loads async and only static imports run before `ready` [V]. If ESM is chosen, an ESM preload must be `.mjs`, and a sandboxed preload cannot use ESM imports at all [V], so the preload stays CJS regardless.
   - Enable Node's compile cache at the very top of main: `require('node:module').enableCompileCache?.(path.join(app.getPath('userData'), 'v8-cache'))` **[T]** (available in Node 22.1+, and Electron 45 ships Node 24.22). Measure the actual gain.
   - `Menu.setApplicationMenu(null)` before `ready` if the custom UI replaces menus [V]. Otherwise build the menu lazily.
   - Lazy `require`/`import()` for `electron-updater`, `electron-log`, `zod` schemas used only in rare handlers [V lazy-loading advice].
   - Defer the updater check until about 10 to 20 s after first paint.
2. **Window**: create with `show: false`, `backgroundColor` matching the theme, and call `show()` on `ready-to-show` so there is no white flash. The shell (toolbar, empty canvas) must paint before the 3D chunk loads.
3. **Renderer bundles** (Rolldown `manualChunks` / `advancedChunks`):
   - `shell` (React, UI kit, 2D editor, state): loaded eagerly.
   - `three-core` (three + R3F): lazy via `React.lazy(() => import('./view3d'))` when the user first opens 3D. Preload it with `requestIdleCallback` after first paint so it is usually ready.
   - `pathtracer` (three-gpu-pathtracer, BVH, wasm): lazy only when "Render" is pressed.
   - Library/asset browser, exporters (DXF/PDF/SVG), i18n catalogs: lazy per route/locale.
   - Import `three` by named exports only (tree-shaking), copy KTX2/Draco/meshopt decoders into `public/` and serve over `app://`.
4. **V8 code cache for the renderer**: the `app` scheme has `codeCache: true` [V: option exists, "supports V8 code cache"]. Keep `v8CacheOptions` at default. Hashed filenames make the cache effective **[T]** (verify with DevTools "Coverage"/performance trace).
5. **V8 snapshots**: not worth it. Skip for this app (renderer bootstrap is dominated by three.js and React, which a snapshot cannot capture in Electron's current tooling) **[J]**.
6. Electron 45 itself brings faster sandboxed renderer startup and faster ASAR reads [V]. Another reason to stay on the sandbox and on 45.x patches.
7. Measure continuously: `performance.mark` at `app-ready`, `window-created`, `first-paint`, `3d-ready`, and write them to the log. Add `rollup-plugin-visualizer` 7.1.3 to the build for bundle-size budgets [V].

---

## 7. GPU, rendering and Chromium flags (Intel Arc iGPU, Windows)

Reality check: on a single-GPU Windows machine, "force the discrete GPU" does nothing. The Arc iGPU **is** the GPU. Both switches exist and are documented: `--force_high_performance_gpu` ("force using discrete GPU when there are multiple GPUs") and `--force_low_power_gpu` [V]. They must be applied with `app.commandLine.appendSwitch` before `ready` **[T]**.

Recommended defaults, set in main before `ready`:

```ts
app.commandLine.appendSwitch('force_high_performance_gpu');   // harmless on iGPU-only machines, picks dGPU on hybrid laptops
// Do NOT set by default: ignore-gpu-blocklist, disable-gpu-vsync, disable-frame-rate-limit, in-process-gpu
```

- **ANGLE**: Windows default is the D3D11 backend and it is the most tested. Do not override. In Electron 44+ ANGLE is statically linked, so `libEGL`/`libGLESv2` are no longer shipped [V]. Do not try to swap them. Expose "Graphics backend" only as a hidden troubleshooting option (`--use-angle=d3d11|gl|vulkan|swiftshader`) read from settings **[J]**.
- **Renderer API**: ship the editor on `THREE.WebGLRenderer` (WebGL2). three-gpu-pathtracer 0.0.28 is built on WebGL render targets **[T]**, so WebGL2 is mandatory for the photoreal path anyway. WebGPU (`navigator.gpu`, no flag needed on Windows **[J]**) is an optional future track. Use `--enable-unsafe-webgpu` only for experiments, and always check the adapter backend **[V: reports D3D11/D3D12]**. Mixed WebGPU compute + WebGL pathtracer is not planned.
- **Frame rate**: keep vsync and Chromium's frame limit. `--disable-frame-rate-limit` / `--disable-gpu-vsync` are for a benchmark mode only (they make an iGPU hot and noisy and give tearing). Cap interaction to display refresh, and use dynamic resolution (pixelRatio scale 0.5 to 1.0) while orbiting/dragging, full resolution when idle.
- **On-demand rendering**: R3F `frameloop="demand"` + `invalidate()` on state changes. Switch to continuous only during camera damping, animations and path tracing. The 2D editor is plain Canvas2D/SVG/PixiJS-free and does not touch the GPU when idle.
- **Background throttling**: keep `backgroundThrottling: true` so a minimised or hidden window stops rendering. During an active path-traced render, call `win.webContents.setBackgroundThrottling(false)` and restore afterwards, or pause rendering with a "paused in background" toast. `--disable-renderer-backgrounding` applies to every renderer, so do not use it globally [V].
- **Memory** (iGPU shares system RAM, but WDDM still limits GPU allocations):
  - A `TextureBudget` manager with an LRU: default budget 1.5 GB of decoded texture memory (`width*height*4*1.33` per mipmapped texture, or the compressed size for KTX2). Evict by `texture.dispose()` and reload on demand from the asset protocol.
  - Always dispose geometries, materials, textures and render targets when removing objects. Watch `renderer.info.memory` (geometries/textures) in a dev overlay and assert counts in e2e.
  - Share materials by id (one material instance per catalogue finish, parameterised through uniforms or instanced attributes) instead of cloning per object. Use `InstancedMesh` / `BatchedMesh` for repeated tiles, planks and chairs.
  - **KTX2 / Basis Universal** for library textures: GPU-compressed formats cut VRAM by 4 to 8x and decode off-thread. Import pipeline in the utility process: `@gltf-transform/core|functions` 4.5.1 + `meshoptimizer` 1.3.0 for meshes; `basis_universal` / `toktx` for textures **[T]** (choose the encoder tool during the asset-pipeline task; `ktx-parse` 2.0.0 for inspection). At runtime: three's `KTX2Loader` with the transcoder served from `app://`.
  - Cap texture resolution: 2048 default, 4096 only for "hero" surfaces (floor, main wall), per-material user override. Generate mipmaps and anisotropy 8.
  - Decode images with `createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none', resizeWidth, resizeHeight, resizeQuality: 'high' })` inside a worker, then upload via `ImageBitmapLoader` (set `flipY` as appropriate). Never keep both the `Blob` and the decoded bitmap alive. Call `bitmap.close()` only if the texture is guaranteed reloadable on context restore (see below).
  - Shadows and the path tracer need separate budgets: the path tracer's BVH and accumulation targets are the largest GPU consumers. Allocate them lazily and free them on leaving render mode.
- **Context loss and GPU crash recovery**:
  - Listen to `webglcontextlost` (call `preventDefault()`) and `webglcontextrestored` on the canvas. On restore, flag all textures `needsUpdate`, rebuild render targets and the path tracer, and re-run the `TextureBudget` loader for any texture whose source was released. Keep a reloader closure per texture, not just the decoded image.
  - Main process: `app.on('child-process-gone', (_, d) => ...)` with `d.type === 'GPU'` logs the reason (`crashed`, `oom`, `launch-failed` etc.) [V]. Chromium restarts the GPU process itself. After repeated crashes it falls back to software, so tell the user ("Rendering fell back to software") and offer **Safe mode**: persist `{ hardwareAcceleration: false }` and relaunch with `app.disableHardwareAcceleration()` (must be called before `ready`) [V].
  - `webContents.on('render-process-gone')` (reasons incl. `crashed`, `oom`) → reload the window and offer restore from the autosave recovery file. `unresponsive` → prompt and optionally `forcefullyCrashRenderer()` + `reload()` [V].
  - Use `app.getGPUInfo('basic')` and listen to `gpu-info-update` before reading `getGPUFeatureStatus()` [V] to show renderer, driver and WebGL2 status in an "About / diagnostics" panel and to choose quality presets automatically (for example, iGPU → medium).
  - Ship a "Copy diagnostics" button (GPU info, versions, settings, last logs).

---

## 8. Auto-update

- **electron-updater 6.8.11 [V]** with the NSIS target: differential updates via blockmaps, staged rollouts, channels (`latest`, `beta`), providers GitHub Releases / S3 / generic [V general feature list].
- Rejected: Electron's built-in `autoUpdater` + `update.electronjs.org` (Squirrel.Windows) — needs a public GitHub repo, a `RELEASES`/`.nupkg` pipeline, no blockmap diffs [V]. Fine for tiny apps but wasteful for a 150+ MB app.
- Settings: `autoDownload: false`, `autoInstallOnAppQuit: true`, check 15 s after the window is shown and every 6 h, prompt in-app with release notes. Never update during a path-traced render or an unsaved edit session (check dirty flag, flush autosave first).
- **Separate data from the app**: user projects, imported assets, downloaded packs and caches live in `app.getPath('userData')` (and the user's documents folder for projects), never in the install directory. **Built-in asset packs are versioned separately** (manifest with sha256 per pack, fetched by the utility process) so a texture-library update does not require a 150 MB app update.
- Code signing is required for a trustworthy Windows updater (section 1). Electron docs state signing is required only on macOS for `update.electronjs.org` [V], but for SmartScreen and for updater signature validation on Windows, sign anyway.

---

## 9. Project file format `.doplan`

**Container: a ZIP (store + deflate), written and read in the utility process.** Library: **fflate 0.8.3 [V]** (tiny, streaming `Zip`/`Unzip`, no native deps). `@zip.js/zip.js` 2.24.0 [V] is the alternative if random access to multi-GB archives becomes necessary. For expected sizes (< 500 MB) fflate is enough.

```
project.doplan (zip)
├─ manifest.json         { format: "doplan", formatVersion: 3, appVersion, createdAt, modifiedAt, unitSystem, locale,
│                          assets: [{ id, path, sha256, size, mime, source: "embedded"|"library", licence }] }
├─ scene.json            versioned document (walls, rooms, openings, objects, materials, lights, cameras, layers)
├─ thumbs/preview.webp   project thumbnail (256..512 px) for file dialogs/recent list
└─ assets/<sha256>.<ext> content-addressed user-imported assets actually used by the scene (glb, ktx2, jpg, png, hdr)
```

- Already-compressed files (glb with meshopt, ktx2, jpg, webp) are stored (level 0). Only JSON is deflated (level 6).
- **Built-in library assets are referenced by id@pack-version + sha256, not embedded**, so files stay small. "Export portable" embeds everything.
- Units: store geometry in **integer millimetres** (or float mm), Y-up, right-handed (three.js convention). Never store derived data (meshes, triangulation). Store only the minimal model and recompute.
- Schema: Zod schemas per `formatVersion`; a chain of pure `migrate_vN_to_vN+1` functions with golden-file tests. Reject files with `formatVersion` newer than the app and show a clear message.
- **Atomic save**: write to `<name>.doplan.tmp-<rand>` in the same directory, `fsync`, then `rename` over the target (retry with backoff on `EBUSY`/`EPERM`, common on Windows with antivirus/indexers). Keep one `.bak` of the previous version. Never write in place.
- **Open**: unzip `manifest.json` + `scene.json` immediately and stream/extract assets lazily to `userData/cache/projects/<projectId>/` (served by `doplan-asset://proj/...`). The editor is usable before all assets are extracted.
- **Autosave / recovery**: debounce 20 to 30 s while dirty plus on blur. Write only `scene.json` (+ new assets) to `userData/recovery/<projectId>/` using the same atomic procedure. Hold a `lock` file with pid; on startup a stale lock plus recovery data triggers "Restore unsaved changes?". Delete recovery after a clean save or explicit discard.
- Export formats (PNG/SVG/PDF/DXF/glTF) are separate writers in the utility process or renderer worker, not part of the container.

---

## 10. State management for the editor

### Decision: **zustand 5.1.0 + mutative 2.0.2 (patches) with a custom history stack**

Versions verified: zustand 5.1.0, mutative 2.0.2, zustand-mutative 2.0.0, immer 11.2.10, valtio 2.3.2, yjs 13.6.33, zundo 2.3.0 [V].

| Option | Verdict |
|---|---|
| **zustand + mutative/immer patches** | **Chosen.** Plain immutable data (trivially serialisable to `scene.json`), selector-based subscriptions, works outside React (`store.getState()`/`subscribe`) which R3F and workers need. `produceWithPatches` gives `patches` + `inversePatches` per transaction → undo/redo, autosave journal, future collaboration. mutative produces immer-compatible patches and is designed as a faster drop-in **[J: benchmark with a 5k-entity scene before committing; immer 11.2.10 is the fallback with identical API]**. |
| zundo 2.3.0 | Snapshot-based temporal middleware (stores whole-state snapshots; structural sharing keeps it cheap), no inverse patches for journaling. Acceptable, but our own ~100-line patch history is simpler to coalesce and persist. Not chosen. |
| valtio 2.3.2 | Mutable proxy API makes transaction boundaries, patches, and non-React consumers (workers, R3F frame loop) harder. Not chosen. |
| yjs 13.6.33 | CRDT is the right tool only for real-time multi-user editing. It brings memory/CPU overhead and awkward typing for geometry. Not chosen for v1. Keep the document patch-serialisable so a Yjs binding can be added later. |

Structure:

- **Three stores**: `documentStore` (undoable scene, normalised: `entities: Record<Id, Wall|Room|Opening|Item|...>` + order arrays), `uiStore` (tool, selection, panels, not undoable but persisted to settings where useful), `viewportStore` (vanilla, transient: hover, drag preview, camera. Never causes React renders; read in the R3F frame loop).
- **Transactions**: `doc.transact('move-wall', draft => {...}, { coalesceKey: 'drag:wallId' })`. Dragging coalesces into one history entry; commit on pointer-up. Ephemeral drag state lives in `viewportStore` and is committed once.
- **Selectors**: per-entity components `useDoc(s => s.entities[id])` so only the changed entity re-renders. Use `useShallow` for lists, and memoised derived data (room polygons, areas, wall joins) computed in the geometry worker and cached by entity version.
- History bounded by count (500) and size. Redo is cleared on new transaction.
- Undo scope: only `documentStore`. Selection changes are not undoable but are restored with the entry (store `selectionBefore/After` in the entry).

---

## 11. UI kit

### Decision: **Tailwind CSS 4.3.5 (`@tailwindcss/vite`) + Radix primitives (`radix-ui` 1.8.1) in the shadcn "own the components" pattern**

Supporting libraries [V versions]: `class-variance-authority` 0.7.1, `clsx` 2.1.1, `tailwind-merge` 3.7.0, `lucide-react` 1.72.0, `cmdk` 1.1.1, `sonner` 2.0.8, `react-resizable-panels` 4.21.0, `@tanstack/react-virtual` 3.14.26 (virtualised asset grids with thousands of items).

Why: a dense pro tool needs full control of density (28 px controls, compact inspectors, dockable panels), keyboard accessibility and a theming system with CSS variables (light/dark, accent). Radix gives unstyled accessible primitives (dialog, popover, tooltip, context menu, tabs, slider, toggle group), copied into `src/renderer/ui/` and owned by us.

Alternatives considered: **Base UI** `@base-ui/react` 1.9.0 (now stable, a credible Radix successor; acceptable swap later), **Mantine** 9.8.0 (heavy, opinionated look, harder to make as dense), **React Aria Components** 1.22.1 (best a11y, verbose styling). None gives a better dense-editor fit than owned Radix components.

Tailwind v4 notes: use CSS-first config (`@theme`), design tokens as CSS variables, and the Vite plugin (peer Vite ^8 supported [V]). No runtime CSS-in-JS (keeps main-thread time free for WebGL).

React 19.3.1 + react-dom 19.3.1 [V]. Keep the React tree out of the render loop: the canvas must not re-render on UI state changes unrelated to the scene.

---

## 12. i18n (Russian + English)

### Decision: **Lingui 6.12.0** (`@lingui/core`, `@lingui/react`, `@lingui/cli`, `@lingui/vite-plugin`)

- ICU MessageFormat with proper Russian plurals (one/few/many/other), compile-time macros, tiny runtime, catalogs as `.po` (translator-friendly) compiled to JS modules, lazy-loaded per locale.
- **Verified**: the Vite plugin's native `macroTransform: true` handles macros without a separate Babel/SWC plugin, and it works with `@vitejs/plugin-react` and Vite 8 / Rolldown [V]. `lingui extract` still uses Babel internally [V], which is acceptable (CLI only).
- Fallback if friction appears: `i18next` 27.1.1 + `react-i18next` 18.0.1 (both support TS 7 [V]) with JSON catalogs and typed keys.
- Main-process strings (menus, dialogs, tray) use the same Lingui core in Node with catalogs shared from `src/shared/locales`. Locale detection: `app.getPreferredSystemLanguages()`, user override in settings. Default `ru` if the system language is Russian, otherwise `en`.
- Units and numbers: `Intl.NumberFormat` with locale. Unit system (mm/cm/m, ft-in) is a document setting, separate from the UI language.
- CI check: `lingui extract` fails if untranslated `ru` strings exist in release branches.

---

## 13. Folder structure (single package, enforced layering)

Single package, not a monorepo. A workspace adds hoisting/packager risk with pnpm on Windows for little gain. Layering is enforced by path aliases and Biome's `noRestrictedImports` (or `dependency-cruiser`).

```
doplan/
├─ package.json  pnpm-lock.yaml  .npmrc  .nvmrc(24)  electron.vite.config.ts  electron-builder.yml
├─ tsconfig.json  tsconfig.node.json  tsconfig.web.json  biome.json  lingui.config.ts  vitest.config.ts  playwright.config.ts
├─ build/                  icons, NSIS include, fuse config, file association
├─ resources/              extraResources: built-in asset packs (not in asar), HDRIs, decoders (basis/draco/meshopt wasm)
├─ docs/research/
├─ src/
│  ├─ shared/              pure TS, no Node/DOM: ipc-contract.ts, schemas (zod), constants, types, locales
│  ├─ core/                pure domain logic, 100% unit-testable in Node: geometry (polygons, offsets, mitering),
│  │                       floorplan model, room detection, snapping, units, document ops, patches/history, migrations
│  ├─ main/                index.ts, window.ts, protocols/{app,asset}.ts, ipc/*.ts, updater.ts, settings.ts, crash.ts, menu.ts, utility/io-worker.ts
│  ├─ preload/             index.ts (contextBridge API + MessagePort relay)
│  ├─ renderer/
│  │  ├─ index.html  main.tsx  app/ (shell, routes)  ui/ (owned Radix+Tailwind components)
│  │  ├─ stores/           document, ui, viewport
│  │  ├─ editor2d/         canvas tools, snapping UI, dimension overlays
│  │  ├─ view3d/           (lazy chunk) R3F scene, materials, textures budget, lights, camera, context-loss handling
│  │  ├─ render/           (lazy chunk) path tracer integration, export of images
│  │  ├─ library/          asset browser, import dialogs, material editor
│  │  ├─ i18n/  styles/
│  │  └─ workers/          geometry.worker.ts, texture.worker.ts, thumbs.worker.ts (Comlink)
│  └─ tools/               (dev only) photo-to-plan helper scripts, asset import CLI
├─ scripts/                build helpers: pack-assets, hash manifests, verify-fuses
├─ tests/                  e2e (playwright), fixtures (.doplan files), golden images
└─ assets-src/             source asset licences/manifests (large binaries not committed; use git-lfs or fetch scripts)
```

Dependency rules: `core` and `shared` import nothing from Electron/DOM/React. `renderer` may import `core`, `shared`. `main` may import `core`, `shared`. `renderer` never imports `main` or `electron`. `preload` imports only `shared` types.

---

## 14. Testing

- **Vitest 5.1.0 [V]** (requires Node 22.12+/24, see section 0). Projects: `unit` (Node env: `core`, `shared`, migrations, history, protocol range parser), `renderer` (jsdom/happy-dom for UI logic). Browser mode (`@vitest/browser` 5.1.0 [V]) only where real WebGL is needed, for example for context-loss/dispose tests.
- **Playwright 1.65.0 [V]** `_electron.launch({ args: ['out/main/index.js'] })`. The Electron API is **experimental**, supports Electron 21+ [V]. Native `dialog` calls are not intercepted, so stub them in main through `electronApp.evaluate()` [V]. **The `EnableNodeCliInspectArguments` fuse must not be false in the build under test, or launch times out [V]**, so flip fuses only in the release packaging step. Run e2e against `electron-vite build` output, and run a separate smoke test on the packaged installer that reads the fuse state with `npx @electron/fuses read`.
- **Visual regression**: render fixed scenes headlessly with software GL (`--use-angle=swiftshader` + `--enable-unsafe-swiftshader`) at fixed size and seed. Compare with tolerance (pixelmatch). Photoreal path-traced output is compared by SSIM at N samples. Do not compare across GPUs.
- **Perf/regression gates in CI**: bundle size budget per chunk (visualizer), startup marks (section 6), `renderer.info.memory` after open/close project x10 must return to baseline (leak test), autosave/recovery test (kill -9 mid-save, reopen).
- **Property tests** (fast-check) for geometry: polygon offset, room detection, wall miter. Golden fixtures for project migrations.
- Lint/format: **Biome 2.6.7 [V]** (not typescript-eslint, see section 0). Optionally ESLint 10.14.0 [V] with only `eslint-plugin-react-hooks` 7.1.1 [V] if the hooks rules are wanted. Type-check: `tsc --noEmit` with TypeScript 7.0.2 [V].

---

## 15. Dependency list (versions verified on npm 2026-11-12)

**dependencies (runtime, shipped in `node_modules` of the package)**
- `electron-updater` 6.8.11
- (optional) `electron-log` 5.4.4

**devDependencies, bundled into out/ by electron-vite**
- Platform/build: `electron` 45.3.1, `electron-vite` 6.0.0, `vite` 8.3.8, `electron-builder` 26.18.0, `@electron/fuses` 2.1.3, `typescript` 7.0.2, `@vitejs/plugin-react` 6.3.0, `@tailwindcss/vite` 4.3.5, `tailwindcss` 4.3.5, `rollup-plugin-visualizer` 7.1.3, `@biomejs/biome` 2.6.7
- UI: `react` 19.3.1, `react-dom` 19.3.1, `radix-ui` 1.8.1, `class-variance-authority` 0.7.1, `clsx` 2.1.1, `tailwind-merge` 3.7.0, `lucide-react` 1.72.0, `cmdk` 1.1.1, `sonner` 2.0.8, `react-resizable-panels` 4.21.0, `@tanstack/react-virtual` 3.14.26
- 3D: `three` 0.187.0, `@types/three` 0.187.0, `@react-three/fiber` 9.8.2, `@react-three/drei` 10.7.9, `three-gpu-pathtracer` 0.0.28, `three-mesh-bvh` 0.9.18, `three-stdlib` 2.36.1 (only if drei does not suffice), `@gltf-transform/core` + `@gltf-transform/functions` 4.5.1, `meshoptimizer` 1.3.0, `ktx-parse` 2.0.0
- State/data: `zustand` 5.1.0, `mutative` 2.0.2 (or `immer` 11.2.10), `zod` 4.6.7, `comlink` 4.4.2, `fflate` 0.8.3
- i18n: `@lingui/core` / `@lingui/react` / `@lingui/vite-plugin` / `@lingui/cli` 6.12.0
- Test: `vitest` 5.1.0, `@playwright/test` 1.65.0 (and `playwright` 1.65.0), `@vitest/browser` 5.1.0 (optional)

Version caveat: `electron-builder` `v26` dist-tag is 26.18.1 and `latest` is 26.18.0 [V]. Pin exactly after the first successful Windows build. Avoid `native` modules (`better-sqlite3` 13.1.1, `sharp` 0.35.5) unless a concrete need appears. They force `asarUnpack` and rebuilds.

---

## 16. Implementation order (what to do first in the repo)

1. Install Node 24, set `.nvmrc`/`engines`, `.npmrc` (`node-linker=hoisted`), scaffold electron-vite 6 (main/preload/renderer, ESM or CJS main, CJS sandbox preload, `externalizeDeps` so only `electron-updater` stays external, preload built as a single bundle).
2. Implement `app://` and `doplan-asset://` protocols with CSP, then the typed IPC contract with sender validation.
3. Window bootstrap (`show:false`, `ready-to-show`), single-instance lock, crash handlers (`render-process-gone`, `child-process-gone`, safe mode), startup marks.
4. R3F canvas in a lazy chunk with `frameloop="demand"`, context-loss handling and a diagnostics panel (`getGPUInfo`, `renderer.info`). Test early on the Arc iGPU, including `navigator.gpu.requestAdapter()` output.
5. utility process `io-worker` + MessagePort bridge; `.doplan` read/write with atomic save, autosave/recovery.
6. First packaged build (NSIS, fuses, asar integrity), smoke test, Playwright e2e against the unpackaged build.
7. Spike tasks marked **[T]** above: `net.fetch(file://)` Range behaviour, `module.enableCompileCache` gain, `force_high_performance_gpu` effect, KTX2 encoder choice, mutative vs immer benchmark, pathtracer WebGL requirement.

---

## Sources (consulted 2026-11-12)

- Electron: security checklist, protocol API, process model, utilityProcess, MessagePorts, ESM, fuses, performance, command-line switches, app API, breaking changes (42 to 45), Electron 45.0 release post, release v45.3.1, updates tutorial, PR #53174 (https://www.electronjs.org/docs/latest/, https://releases.electronjs.org/)
- electron-vite docs and releases (https://electron-vite.org/guide/, https://github.com/alex8088/electron-vite/releases): dev guide (?modulePath), source-code protection (bytecode), isolated build
- electron-builder docs (https://www.electron.build/), issue #9580, code-signing-win page
- Playwright Electron API (https://playwright.dev/docs/api/class-electron)
- Lingui Vite plugin (https://lingui.dev/ref/vite-plugin)
- npm registry metadata for all versions and peer/engine fields listed above
