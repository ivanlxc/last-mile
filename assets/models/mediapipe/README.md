# MediaPipe hand landmarks

Google's unmodified Hand Landmarker float16/version 1 task bundle is retained here so a checkout can prepare the experiment without a model download. Source URL and SHA-256 are in `source.json`. This detects hand landmarks; it does not identify people.

The runtime is pinned to `@mediapipe/tasks-vision@1.0.1` in the package lock. `pnpm prepare:gestures` copies its installed WASM/JS files and this checked model into the ignored `client/public/gestures/` directory. Both development and web builds run this step. Browser requests stay on the application's origin. No CDN is used at runtime.

Upstream: https://github.com/google-ai-edge/mediapipe

Model documentation: https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker

Model card (Apache 2.0; includes limitations): https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Hand%20Tracking%20(Lite_Full)%20with%20Fairness%20Oct%202021.pdf

The upstream license and third-party notices are retained in `LICENSE`; they are copied alongside the served assets. This model is used only for an opt-in experimental game camera control, not a real-world operational decision.
