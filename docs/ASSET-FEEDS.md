# Asset feeds

The installer bundles only a small set of models, materials and HDRIs (the ones in `catalog.json` without
`remote: true`). Everything else in the catalog is **on demand**: the catalog lists it, and the app downloads it the
first time it is used (Library → download button, or opening a project that uses it).

Where it is downloaded from is a list of **feeds**, like NuGet package sources:

- an ordered list (Settings → Asset sources), each feed can be switched off and moved up or down;
- for an entry, the feeds are tried top to bottom and the first enabled feed that has the entry wins. A feed that
  does not have the entry is skipped; a feed that is unreachable or returns bad data is skipped too, with its error
  shown if no later feed succeeds.

Built-in feeds (cannot be removed or edited):

| id | what | URL |
| --- | --- | --- |
| `doplan` | doplan's own mirror: every on-demand entry as one zip, textures already re-encoded. Removes the dependence on third-party sites. | `https://github.com/totKtoXam/doplan-assets/releases/download/feed-1/` (`DOPLAN_FEED_URL` in `src/shared/feeds.ts`) |
| `upstream` | each entry's original source as written in its `download` block in `catalog.json` (Poly Haven, ambientCG, Khronos samples, the Objaverse mirror of Sketchfab) | — |

Users can add their own feeds: an `https://` base URL or an absolute local folder (`D:\doplan-feed`,
`\\server\share\doplan-feed`), e.g. an office share for machines without internet. `http://`, URLs with credentials,
`file://` and relative paths are refused.

## Feed layout

A feed is a flat folder (or URL prefix):

```
index.json
asset_ph_armchair_01.zip
mat_ph_diagonal_parquet.zip
hdri_ph_studio_small_09.zip
…
```

`index.json`:

```json
{
  "format": "doplan-feed",
  "version": 1,
  "entries": {
    "asset_ph_armchair_01": { "file": "asset_ph_armchair_01.zip", "sha256": "ffcc…", "bytes": 716489 }
  }
}
```

- keys are catalog entry ids; `file` is a plain file name next to `index.json`;
- each zip contains the entry's files under the **library paths** the catalog names in its `download` block
  (`models/armchair_01/ArmChair_01_1k.gltf`, `materials/diagonal_parquet/color.jpg`, `hdris/studio_small_09_1k.hdr`);
- a feed may hold any subset of the entries.

Feed content is untrusted (`src/main/feeds.ts`): the index is validated (safe ids and file names, hex sha256, positive
size), a zip must match its `sha256` and `bytes`, and only the paths the catalog expects for that entry are taken from
it (anything else in the zip is ignored; a missing expected file fails the feed). `index.json` is cached for 10 minutes
(1 minute after a failure).

## Building a feed

```bash
pnpm assets:mirror [--out=DIR] [--only=id,id,…] [--kind=assets|materials|hdris] [--limit=N] [--force] [--no-optimize]
```

For every on-demand entry it downloads exactly what the app would download from upstream, re-encodes the JPEG textures
like `pnpm assets:optimize`, and writes `DIR/<id>.zip` (deterministic: the same files give the same sha256) plus
`DIR/index.json` (default `DIR`: `release/asset-feed/`). `index.json` is rewritten after every entry, so an interrupted
run resumes; entries already present with a matching zip are skipped unless `--force`. Failed entries are listed at the
end; re-run to retry them.

The same folder works as a custom feed as it is (point a local feed at it), or can be served over https.

## Publishing the doplan feed

The `doplan` feed is release `feed-1` of the separate repository `totKtoXam/doplan-assets` (release assets, not git
content: ~330 files, nothing large in git history). It is a manual step:

```bash
pnpm assets:mirror                                   # the whole catalog into release/asset-feed/
gh repo create totKtoXam/doplan-assets --public --description "On-demand CC0 assets for doplan"   # once
gh release create feed-1 --repo totKtoXam/doplan-assets --title "doplan asset feed 1" --notes "On-demand assets for doplan" --latest=false   # once
gh release upload feed-1 --repo totKtoXam/doplan-assets --clobber release/asset-feed/*.zip
gh release upload feed-1 --repo totKtoXam/doplan-assets --clobber release/asset-feed/index.json
```

Upload the zips first and `index.json` last, so the index never names a file that is not there yet.
When the catalog gains new on-demand entries, run `pnpm assets:mirror` again (only the new ones are built) and upload
again with `--clobber`. If an entry's files change in a way that breaks old app versions, publish a new release
(`feed-2`) and bump `DOPLAN_FEED_URL`, so old versions keep reading `feed-1`.

Until the feed is published, the `doplan` feed fails with an `index.json` error and the app falls through to
`upstream`, so downloads keep working.
