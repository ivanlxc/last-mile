# LAST MILE — Native market art study

An independent Unity **6000.3.22f1 / URP 17.3.0** project for evaluating the authored market at human scale on Apple Silicon. This stage contains a local walkthrough; gameplay, AI requests, saved sessions and backend identity are not yet connected.

## Minimal setup

Install only the Apple Silicon Unity Editor. The macOS Mono target uses the Editor's included support; Android, iOS, Web and IL2CPP modules are unnecessary for this sample. Complete the applicable Unity license setup in Hub yourself. Keep free space for imported assets and build output as well as the Editor.

From the repository root:

```sh
node scripts/build-native-art.mjs --check
node scripts/build-native-art.mjs --prepare-only
pnpm prepare:native-art
pnpm open:native-art
pnpm build:native-art
```

`--prepare-only` stages the assets without requiring Unity. `prepare:native-art` imports them, converts materials, creates the render pipeline and saves the initial scene. `open:native-art` opens the Editor; on first use choose **Last Mile Art → Prepare Sample**, then press Play. `build:native-art` creates `Builds/LastMileArt.app`, a local development build. It is not a signed/notarized release for public distribution.

The executable can be overridden with `UNITY_EDITOR_PATH`. No script loads `.env`, API keys or hidden game scenarios.

## Asset pipeline

- Source: `assets/authoring/market-sample-v1/MarketSample.fbx`; material parameters come from the matching browser GLB.
- Only referenced JPEG textures are copied. License and source records remain in the authoring folder.
- Raw files in `Assets/Art` are generated and ignored by Git; regenerate them with `--prepare-only` after cloning. Unity `.meta` files are versioned to preserve material and scene references across machines.
- URP materials map base colour, tangent normals, metallic and linear roughness. Roughness is converted to the smoothness alpha channel expected by URP Lit.
- Import units and building height are checked. Mesh colliders, first-person movement, daylight, reflection probe, ACES colour grading and an English/Chinese inspection HUD are configured automatically.
- Preparing again preserves an existing scene's manual edits. Materials and pipeline settings are regenerated. Back up manual material changes before preparing again.

## Controls

Click the scene or press Enter to capture the pointer. WASD/arrows move, mouse looks, Esc releases the pointer, Home resets, Tab toggles help, L switches English/Chinese. P saves a screenshot to Unity's application persistent-data directory (the player log prints its path). The HUD shows rolling frame time after a warm-up and resets when focus changes; this is an inspection aid, not a performance certification. The bundled Noto Sans CJK font and its OFL license ship with the app.

## Acceptance

Editor compilation, material/scale checks, ARM64 build, keyboard walkthrough, pointer release and both HUD languages passed on M4 on 2026-09-27. **Last Mile Art → Check Floor and Wall Collision** runs the real controller for 600 steps against the street and facade. It checks representative collision, not every prop edge. Detailed evidence and remaining QA limits are in [the verification record](../../docs/commercial/art-direction/native-study.md).

Performance goals remain 1080p/30 FPS on M4 and 1080p/60 FPS on M4 Pro. Neither has passed the sustained route test yet. This scene remains an art study, not the complete native game.
