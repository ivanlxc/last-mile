# Campaign fields / Blender source

Created 2026-09-22 with Blender 5.2.1 LTS. Editable environment prototypes for the existing LAST MILE campaign; metres, glTF Y-up on export. These are original scene assemblies, not finished commercial environments.

| Source | Browser asset | Role |
| --- | --- | --- |
| `gate.blend` | `client/public/assets/fields/gate-v1.glb` | E1 west-gate registration and convoy assembly |
| `bridge.blend` | `client/public/assets/fields/bridge-v1.glb` | E3 west-bank staging area, bridge and river |
| `reception.blend` | `client/public/assets/fields/reception-v1.glb` | N07 terminal reception point |

From the repository root:

```bash
pnpm build:campaign-art
pnpm preview:campaign
```

The first command runs `scripts/art/create-campaign-fields.py` in Blender, saves the three sources, exports static GLBs and writes `manifest.json` with measured triangle/mesh/byte counts. It requires the existing source textures; normal application builds use checked-in GLBs and do not require Blender. Use `BLENDER_PATH` to select another executable. Generation overwrites these generated sources/exports; preserve manual artistic changes separately before regenerating.

## Materials and provenance

The `.blend` files reference `../market-sample-v1/textures` using relative paths. Keep that sibling folder when copying the editable sources. Browser GLBs embed their images and need no external texture requests.

Reused Poly Haven sets: `beige_wall_001` (base color and OpenGL normal), `wood_table_001` (base color and OpenGL normal). The prior [license and source record](../market-sample-v1/README.md#asset-license--provenance) and [download/checksum manifest](../market-sample-v1/texture-sources.json) apply: CC0-1.0. No new third-party downloads were needed for these scenes.

Geometry is bevelled and grouped by material for export. Textures, normals and tangents are included; authoring cameras/lights are excluded. Runtime lighting and collision are defined by the client. Scene assets contain no scenario case, hidden truth, outcome tables, NPC dialogue, or report text. Both cases load identical assets.

## Current limits

Characters remain static runtime placeholders; these sources do not include rigs, character animation, vehicle simulation, audio or authoritative observations. The main bridge is backdrop beyond the staging boundary: crossing is a game command, not player walking physics. Native Unity imports/builds and performance on the two target Macs still need actual validation.
