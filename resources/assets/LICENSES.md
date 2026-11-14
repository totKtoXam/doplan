# Asset licences and credits

Everything under `resources/assets` (and everything downloadable on demand through `catalog.json`) is CC0 or CC-BY.
Machine-readable per-entry licence/author fields are in `catalog.json`.

## Poly Haven (https://polyhaven.com)
- Models, PBR textures and HDRIs. Licence: **CC0 1.0** (public domain). No attribution required.
- Credit anyway (good practice, and required by the Poly Haven API terms when browsing the live API): "Powered by Poly Haven".
- Files are fetched with a unique User-Agent (`doplan-asset-fetcher/0.1`) as the API terms ask.

## ambientCG (https://ambientcg.com)
- PBR materials (1K-JPG sets: Color, NormalGL, Roughness, AmbientOcclusion, Metalness). Licence: **CC0 1.0**.
- No attribution required; credit: "Textures from ambientCG.com (CC0)".

## Khronos glTF-Sample-Assets (https://github.com/KhronosGroup/glTF-Sample-Assets)
- Per-model licences. The script only accepts CC0 and CC-BY-4.0.
- **CC0** (bundled): SheenChair, GlassVaseFlowers.
- **CC-BY-4.0** (on-demand only, attribution REQUIRED when downloaded and used; author is stored in the catalog `author` field):
  GlamVelvetSofa, SheenWoodLeatherSofa, ChairDamaskPurplegold, CommercialRefrigerator, AnisotropyBarnLamp,
  IridescenceLamp, GlassHurricaneCandleHolder, DiffuseTransmissionPlant, LightsPunctualLamp.
  The app must list them in its credits screen with owner and artist (see `author`).

## KayKit Furniture Bits (https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0)
- Licence: **CC0 1.0**. Stylised low-poly, on-demand only.

## Not fetched by the script
- Quaternius "Ultimate House Interior Pack" and Kenney "Furniture Pack" (CC0, OpenGameArt) are listed in the manifest
  but need an offline OBJ/FBX to glTF conversion, so they are not part of the catalog.
