# LAST MILE — Native market field slice

An independent Unity **6000.3.22f1 / URP 17.3.0** project for evaluating the authored market at human scale on Apple Silicon. The market now connects to the existing local game API: briefings, investigations, evidence uploads, advisor questions and route decisions. This is an E2 development slice with disposable state, not the complete native campaign. See [the gameplay design and verification record](../../docs/commercial/art-direction/native-gameplay-v1.md).

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

The executable can be overridden with `UNITY_EDITOR_PATH`. Art preparation and build scripts do not load secrets or hidden scenarios. The optional live-model preview reads server configuration only inside Node.

## Asset pipeline

- Source: `assets/authoring/market-sample-v1/MarketSample.fbx`; material parameters come from the matching browser GLB.
- Only referenced JPEG textures are copied. License and source records remain in the authoring folder.
- Raw files in `Assets/Art` are generated and ignored by Git; regenerate them with `--prepare-only` after cloning. Unity `.meta` files are versioned to preserve material and scene references across machines.
- URP materials map base colour, tangent normals, metallic and linear roughness. Roughness is converted to the smoothness alpha channel expected by URP Lit.
- Import units and building height are checked. Mesh colliders, first-person movement, daylight, reflection probe, ACES colour grading and an English/Chinese inspection HUD are configured automatically.
- Preparing again preserves an existing scene's manual edits. Materials and pipeline settings are regenerated. Back up manual material changes before preparing again.

## Controls

Start a disposable game from the repository with `pnpm play:native`. Use `--locale zh-CN` for a Chinese session, `--case B` for the second server-side test variant. Optional `--live-ai` uses the configured server model and incurs provider charges; the default is explicitly labelled offline.

Enter/click captures the pointer, WASD/arrows move, mouse looks, Q/R turns, E opens a nearby station. F1–F6 open briefings/recon/intel/AI/routes. Tab toggles the tablet, Esc releases/closes, Home resets the walking view. ↑/↓ and Enter operate tablet buttons. F12 captures a screenshot; P also works outside the tablet. F9 toggles frame-time observations. Language is fixed by the active session; English is the default.

The launcher pre-completes E1 and starts at E2. Route completion can continue in the browser using the same session while the native app and launcher stay open. Quitting the app stops the temporary server. The build contains no API key, scenario truth or saved identity. Reopening the app directly provides art inspection or a connection form.


## Acceptance

Editor compilation, material/scale checks, ARM64 build, keyboard walkthrough, pointer release and both HUD languages passed on M4 on 2026-09-27. **Last Mile Art → Check Floor and Wall Collision** runs the real controller for 600 steps against the street and facade. It checks representative collision, not every prop edge. Detailed evidence and remaining QA limits are in [the verification record](../../docs/commercial/art-direction/native-study.md).

Performance goals remain 1080p/30 FPS on M4 and 1080p/60 FPS on M4 Pro. Neither has passed the sustained route test yet. The complete native campaign, persistent saves, cloud login and distribution signing remain future milestones.
