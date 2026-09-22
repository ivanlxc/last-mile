# Market storefront / art sample v1

Created 2026-09-22 for LAST MILE. This is a real, editable Blender scene and neutral game environment. It contains no evidence text, authored incident truth, AI input or player data.

## Files and reproducibility

- `MarketSample.blend`: editable metre-scale models, world UVs, bevels, PBR materials, an eye-height storefront camera (the generator renders three inspection poses). Image references are relative to `textures/`; keep this directory alongside the file.
- `MarketSample.fbx`: selected, evaluated and batched mesh exchange; textures remain beside it. Unity still needs material setup and an actual Editor import test.
- `../../../client/public/assets/market/market-sample-v1.glb`: embedded textures, UVs, normals and tangent vectors for the game. Source lights and cameras excluded.
- `texture-sources.json`: original download URLs, resolution, license, MD5 and SHA-256 checksums. `build-manifest.json`: measured export counts/size.
- `storefront-eye.png`, `radio-close.png`, `reverse-eye.png`: **Blender Cycles** renders of this model. These are not Unity/game screenshots or performance evidence. The background intentionally has no full town.

From the repository root:

```bash
# Only needed to restore missing source images; prints Poly Haven attribution.
python3 scripts/art/fetch-market-textures.py
# Regenerate editable source + batched GLB, without expensive preview renders.
pnpm build:market-art
# Include FBX and the three reference renders.
pnpm build:market-art -- --fbx --render
```

Requires Blender 5.2 (verified on 5.2.1 LTS). Set `BLENDER_PATH` if it is elsewhere. Normal `pnpm build` uses the checked-in GLB and needs neither Blender nor access to an asset service. The generator does not open or overwrite the strategic-map `.blend` files.

## Asset license / provenance

The meshes and assembly script were created for this project. The following PBR texture sets come from **Poly Haven**, licensed **CC0-1.0**. They allow commercial use and redistribution; license checked 2026-09-22 at <https://polyhaven.com/license>. No purchased assets, borrowed character models, or third-party logos are included.

| Material | Source | Resolution / use |
| --- | --- | --- |
| Plaster | https://polyhaven.com/a/beige_wall_001 | 2K base color, OpenGL normal, roughness |
| Paving | https://polyhaven.com/a/cobblestone_floor_08 | 2K base color, OpenGL normal, roughness |
| Timber | https://polyhaven.com/a/wood_table_001 | 1K base color, OpenGL normal, roughness |
| Cloth | https://polyhaven.com/a/fabric_pattern_07 | 1K normal and roughness; neutral material color replaces pattern for this scene |

The restoration script uses Poly Haven's public API with an identifying User-Agent. The running game makes no calls to Poly Haven. Original texture files are preserved; the glTF exporter packs roughness in its PBR texture channels.

## Scope and limits

This first asset pass covers the western shop, Noah's awning/table, radio, case, notebook, flask, crates, chair, plant pots, balcony, trim and adjacent paving. The rest of the street and the people remain the earlier placeholders. No character rig/animation is contained here; do not present it as the completed commercial art target.

808 authoring objects are combined into 27 exported meshes, 60,892 triangles. The GLB is about 24.7 MiB. This is an asset budget check, **not** a measured frame-rate result. Later passes need stronger surface aging, character art/animation, improved indirect light, full scene dressing, texture/mesh compression and native-device profiling.
