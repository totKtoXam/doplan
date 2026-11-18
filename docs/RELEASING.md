# Releasing doplan

Releases build themselves: pushing a `vX.Y.Z` tag runs `.github/workflows/release.yml` on `windows-latest`, which
builds the NSIS installer and the portable exe and publishes the GitHub release that the built-in updater
(`src/main/updater.ts`, electron-updater, GitHub provider) reads.

## Cut a release

1. Bump the version in **both** places (CI refuses the tag otherwise):
   - `package.json` → `"version": "X.Y.Z"`
   - `src/renderer/src/store/api.ts` → `const WEB_VERSION = 'X.Y.Z-web'`
2. Commit on `main`: `git commit -am "doplan X.Y.Z"` (version-bump commits named like this are left out of the notes).
3. Tag and push:
   ```bash
   git tag -a vX.Y.Z -m "doplan X.Y.Z"
   git push origin main --tags
   ```
4. Watch the run under **Actions → release**. When it is green, the release `doplan X.Y.Z` is published (not a draft)
   with `doplan-setup-X.Y.Z.exe`, `doplan-setup-X.Y.Z.exe.blockmap`, `latest.yml` and `doplan-portable-X.Y.Z.exe`.
   Installed copies pick it up on their next check (≈10 s after start, then every 6 h).

What the workflow checks before it publishes: the tag is exactly `v` + `package.json` version, `WEB_VERSION` matches,
the tagged commit is on `main`, all bundled assets are present (`pnpm assets:check`), `pnpm typecheck`, `pnpm test`,
and that the build produced all four files with a `latest.yml` for this version.

**Release notes.** By default they are the first-parent commit subjects since the previous `v*` tag
(`Merge X` → `X`, `doplan X.Y.Z` bumps dropped) plus a compare link; preview them with `pnpm release:notes vX.Y.Z`
(after tagging locally). To write them by hand, put them in the annotated tag — everything after the first line
becomes the notes:

```bash
git tag -a vX.Y.Z -F notes.md   # first line "doplan X.Y.Z", blank line, then Markdown
```

You can always edit the notes on GitHub afterwards; the updater shows whatever the release body says.

**"Latest".** The workflow leaves "Latest" to GitHub (highest version), so tagging a hotfix for an older line
does not make it the update target.

**If a run fails** after the tag is pushed: fix the cause on `main`, then either re-run the job (if the tagged commit
itself is fine — a re-run replaces the files of an existing release), or delete the tag and re-tag the fixed commit:

```bash
git push origin :refs/tags/vX.Y.Z && git tag -d vX.Y.Z
```

Never re-use a version number that installed copies may already have downloaded; bump to the next patch instead.

**Local build** (no upload): `pnpm dist` → `release/X.Y.Z/`. It needs the heavy assets on disk (below).

## Heavy assets and the assets pack

`resources/assets/{models,materials,hdris}` (~70 MB of CC0 files) are gitignored; `catalog.json`, `thumbs/` and
`LICENSES.md` are tracked. Locally they come from `pnpm assets:fetch` (live Poly Haven / ambientCG APIs; it also
rewrites `catalog.json` and re-encodes the JPEG textures, see `pnpm assets:optimize` below). Everything else in the
catalog is on demand (`remote: true`) and is downloaded by the app from the asset feeds (docs/ASSET-FEEDS.md). CI must not depend on live APIs, so it restores them from a fixed **assets pack**:

- `tools/assets/pack.json` — the one place that names the pack: number `N`, the zip's `sha256`, size, file count.
- GitHub release `assets-N` (not a `v*` tag, **not marked Latest**, so electron-updater never sees it) holds
  `doplan-assets-N.zip`.
- CI downloads it with `gh release download assets-N`, checks the sha256 against `pack.json`, unpacks it
  (`pnpm assets:unpack`), and caches the unpacked folders under the key `doplan-assets-N-<sha256>`.

Scripts:

| command | what it does |
| --- | --- |
| `pnpm assets:check [--root=DIR]` | every bundled (`remote !== true`) `models/…`, `materials/…`, `hdris/…` path in `catalog.json` exists and is non-empty, every bundled `.gltf`'s buffers/images exist, and no unused file is lying in those folders (it would be shipped: e.g. a model left over after it became on demand). Run it before `pnpm dist`. |
| `pnpm assets:optimize [--dry]` | re-encodes the JPEG textures under `resources/assets` with mozjpeg (colour q88 4:2:0, normal maps q85 4:4:4, packed ORM/ARM q88 4:4:4, roughness/AO/metalness as 1-channel greyscale of the channel three.js reads). Each file gets a `doplan-optimized/1` JPEG comment, so re-runs skip it; a file that would not shrink by 5% is kept as is. `assets:fetch` runs it (unless `--no-optimize`). |
| `pnpm assets:pack [--pack=N] [--out=DIR]` | zips the three folders (deterministic: same files → same sha256) into `DIR/doplan-assets-N.zip` (default `release/assets-pack/`) and writes `tools/assets/pack.json`. Refuses if `assets:check` fails, or if the files changed but `N` was not bumped. |
| `pnpm assets:unpack <zip> [--dest=DIR]` | verifies the sha256 against `pack.json` and extracts into `resources/assets` (or `DIR`); only `models|materials|hdris/…` entries are accepted, and it refuses to write over existing folders. |

### Update the assets pack

Do this whenever the bundled assets change (a new `pnpm assets:fetch`, new/removed bundled models, …) — otherwise
the next tag fails at `assets:check`, or ships stale files.

```bash
pnpm assets:optimize              # no-op if assets:fetch already ran it
pnpm assets:check
pnpm assets:pack --pack=2          # next number; prints the upload command
gh release create assets-2 release/assets-pack/doplan-assets-2.zip -R totKtoXam/doplan --latest=false --title "doplan assets pack 2" --notes "CC0 models/materials/HDRIs for CI release builds (not an app release)."
git add tools/assets/pack.json resources/assets/catalog.json
git commit -m "Assets pack 2"
```

Upload the zip **before** pushing the next `v*` tag. Keep old `assets-N` releases: re-running the build of an old
tag needs the pack its `pack.json` names. Running `pnpm assets:pack` without `--pack` on unchanged files reproduces the
recorded zip byte for byte (handy if the uploaded file is lost).
