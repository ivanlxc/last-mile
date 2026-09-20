# LAST MILE

A single-player decision game about human–AI collaboration. Lead a convoy of twenty civilians through a fictional Sahel valley, investigate incomplete information, decide what to share with an AI advisor, and take responsibility for the route you choose.

The game has three chapters, two hidden scenario variants, and an independent decision debrief. There is **no mission countdown**: take time to read, explore, and think. English is the default language; Chinese is also available.

## Play the game

**[Launch LAST MILE](https://last-mile-qcq0.onrender.com)**

**Invite code:** `c2e0af7948e6ce29a4ed55d35fb85e21`

Open the link in a **desktop browser**, enter the invite code, and start a new mission. Players do not need to install anything or provide API keys. The interface is designed for desktop use, not mobile screens. Microphone and camera access are optional, for voice input and experimental gesture controls respectively.

The invitation code above is intentionally published for this playtest. Each browser receives its own player identity and game history; using the same invitation code does not merge players' saves.

## What you can do

- Explore a satellite-style 2D map, a Three.js 3D map, or the Blender-powered Unity scene.
- Request reports, investigate leads, and choose which evidence the AI advisor receives.
- Open the advisor when you need it, type a question, or dictate in English.
- Listen to reports and advisor responses with the Draco voice when the speech service is configured.
- Make route decisions with immediate feedback, then review your decisions at the end.
- Hear separate background music for the opening, West Gate, Market, Main Bridge, and ending.
- Try optional one-hand map controls: pan, rotate, and zoom, with a thumbs-up gesture to switch modes.

## How to play

1. Read the briefing and start the escort. The opening drive advances **in-world time** immediately and takes you to West Gate.
2. Ask Noah and Samira for existing briefings or further investigation. Each can submit up to three reports per chapter; starting an investigation reserves a report slot.
3. Manage the investigation budget shared across the whole mission: **2 satellite, 3 drone, 3 local-agency, and 2 witness requests**.
4. Upload up to five formal evidence cards per chapter to the advisor. It does not automatically receive unshared reports, the clock, medical status, or remaining resources. Free-text input is treated as an unverified player statement.
5. Compare the available routes, optionally record your reasoning, and choose an action. Investigations, provenance checks, corrections, and travel may consume simulated time or resources, but do not make you wait out that duration in real time.
6. Review the result and continue through the Market and Main Bridge. The ending distinguishes arrival, completed formalities, and a full handover; it does not invent a handover completion time.

The debrief considers overreliance, excessive skepticism, excessive caution, and calibrated trust. It avoids a forced classification when evidence is insufficient and is not a psychological assessment. Elapsed time is recorded for review, without a new time penalty or numerical overall score.

Passengers remain medically stable under the current unlimited-time rules. The old eight-minute medical escalation and ten-minute failure deadline do not apply to new missions. Older runs retain the content and rules version under which they began.

## Time and immediate actions

**Play time** measures actual time spent in a mission and has no upper limit. **In-world time** advances only when an action has a simulated duration. Reading, thinking, browsing the map, or opening the advisor does not advance in-world time.

Investigations and existing briefings deliver their reports immediately. Route choices immediately resolve and update the convoy's location. The interface shows progress while a network request is being submitted and keeps failed confirmations available for retry. AI analysis and speech still take the actual time required by their services.

Both clocks are recorded separately in the debrief. See [Immediate actions and time](docs/instant-actions.md) for the implementation and validation record.

## Run locally

Requirements: **Git, Node.js 24, and pnpm 11**.

```bash
git clone https://github.com/ivanlxc/last-mile.git
cd last-mile
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open [http://127.0.0.1:3111](http://127.0.0.1:3111). Local mode listens on loopback by default. A fresh clone does not include API keys or player saves; without model configuration, the advisor uses explicitly labeled offline templates.

For development:

```bash
pnpm dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Vite proxies `/api` to port 3111. Private story data, server source, environment files, and saves are excluded from the development server's accessible files.

On macOS, you can also double-click `启动 LAST MILE.command` in the repository root after installing the prerequisites. Keep its terminal open; press `Ctrl+C` to stop the service. If the service is already running, the launcher opens the existing page rather than restarting the backend or reloading configuration.

Some contracts, story data, and SQL under `docs/engineering_v0.5/` are runtime dependencies. Keep that directory with the application source when building or deploying.

## Configure the AI advisor and debrief

For local development, copy `.env.example` to `.env` **only if `.env` does not already exist**. Put real keys in `.env`, never in the public template or frontend variables. For the hosted service, set the equivalent variables in **Render → Environment**; local settings are not synchronized to Render.

The advisor and evaluator can share one provider and API key. They use separate prompts and independently constructed context, without sharing conversation history.

The project previously passed limited English and Chinese synthetic tests with this OpenAI configuration. Use a model that is available to your own account and supports the required structured output:

```dotenv
MODEL_PROVIDER=openai
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5.6-luna
OPENAI_REASONING_EFFORT=low
AI_ADVISOR_TIMEOUT_MS=30000
AI_ADVISOR_MAX_OUTPUT_TOKENS=2500
AI_EVALUATOR_TIMEOUT_MS=45000
AI_EVALUATOR_MAX_OUTPUT_TOKENS=5000
```

Alternatively, configure Anthropic:

```dotenv
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=your_anthropic_api_key
ANTHROPIC_MODEL=your_exact_model_id
```

Use `MODEL_PROVIDER=offline` for local development without model calls. Anthropic has simulated protocol coverage; the recorded real-provider checks used OpenAI. See [Real-model validation](docs/implementation/真实模型接入验收.md) for the scope and remaining checks.

**Restart the backend after changing `.env`.** An existing process does not reload the file. Start a new test mission and check the advisor's `LIVE MODEL` indicator. A present key is not proof that its permissions, quota, or model access work.

Keys are read only by the server and are excluded from browser payloads, game snapshots, logs, and exports. In live mode, analysis can run when a scene begins, evidence is uploaded, or the player asks a question. A separate evaluation runs at the ending. Advisor requests are limited to 30 actual sends per mission, with at most two attempts per job. A formatting, citation, or obvious language error may receive one bounded repair attempt; network failures do not automatically trigger another paid attempt.

The explicit limits above provide 30 seconds / 2,500 output tokens for the advisor and 45 seconds / 5,000 tokens for the evaluator. If omitted, the code defaults remain 8 seconds / 1,200 tokens and 20 seconds / 3,000 tokens. Failed analysis falls back to a clearly labeled offline template. Waiting for AI does not advance in-world time.

Offline templates describe evidence boundaries and auditable behavior rules; they do not pretend to be an LLM or generate a supposedly optimal route. Language checks are conservative, skip explicit quotations, and do not rewrite the player's original words or guarantee output quality. Full three-chapter live-model playtesting remains part of validation.

Provider references: [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs) and [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs).

## English voice input and read-aloud

Speech is optional. To enable English transcription and Draco read-aloud, add these server-side settings to local `.env` or Render's environment:

```dotenv
DEEPGRAM_API_KEY=your_deepgram_api_key
DEEPGRAM_ENABLED=true
DEEPGRAM_TTS_MODEL=aura-2-draco-en
```

Deepgram uses its own key, separate from OpenAI. The game remains playable with text when speech is unavailable. See [Speech setup](docs/speech-setup.md) and the [map-first interface and voice implementation](docs/implementation/地图主界面与英文语音.md).

## Maps, Unity, and Blender

The 2D map uses satellite-style artwork based on an orthographic view of the existing Blender terrain. Public roads, locations, and convoy positions remain interactive, with dragging, zooming, view reset, and keyboard selection. This is static artwork of a fictional location, not live reconnaissance evidence. See the [map asset notes](assets/authoring/satellite-map/README.md).

React manages the briefing, evidence, advisor, action confirmation, and debrief. Unity renders the public map and convoy position and returns location selections to the web interface. The server remains authoritative for time, resources, and game rules. Selecting a map location neither spends resources nor reveals new intelligence.

The Unity scene uses Blender models, materials, an independent convoy, perspective cameras, lighting, and shadows. Press **F** or use the follow control for a closer convoy view; press **Home** for the overview. Immediate route resolution updates the convoy to its resulting location rather than making the player watch the full simulated travel time.

To build Unity locally, install **Unity 6.3 LTS** with **Web Build Support**, activate your editor license, and run:

```bash
pnpm build:unity
pnpm dev
```

Use **Check for build again** in the Unity setup dialog. When Unity is selected during the briefing, the scene must be ready before the escort starts; the same scene instance is retained into the mission. Loading failures fall back to the standard map. The 2D and Three.js views work without a Unity installation.

With Blender installed, rebuild the artwork before rebuilding Unity:

```bash
pnpm build:art
pnpm build:unity
```

The original and refined authoring projects are in `assets/authoring/last-mile-v2/` and `assets/authoring/last-mile-unity/`. See [Unity setup](unity/README.md) and [Unity integration validation](docs/implementation/Unity接入本地试用.md).

### Unity on Render

Unity source, Blender files, FBX models, and textures are tracked in Git. Compiled browser files under `client/public/unity/` are ignored. A normal source deployment alone therefore does not include Unity.

The [Unity Web runtime release for d458981](https://github.com/ivanlxc/last-mile/releases/tag/unity-web-d458981) provides the matching prebuilt runtime and checksum file. Its archive contains the manifest and the four browser build assets. Extract it into `client/public/` **before** running `pnpm build`, so the files are copied into the deployed site. This does not require installing Unity or supplying a Unity license on Render.

For the current runtime release, the Render **Build Command** is:

```sh
pnpm install --frozen-lockfile --prod=false && curl -fL --retry 3 https://github.com/ivanlxc/last-mile/releases/download/unity-web-d458981/last-mile-unity-d458981.tar.gz -o /tmp/last-mile-unity-d458981.tar.gz && printf '%s\n' '957d6fd31ef25a682ebd8763ac1a34a63ca7d7453222533a71c17d01dd2929ff  /tmp/last-mile-unity-d458981.tar.gz' | sha256sum -c - && tar -xzf /tmp/last-mile-unity-d458981.tar.gz -C client/public && pnpm build
```

Keep **Start Command** as `pnpm run start`. Update the release URL and checksum together when publishing a newer Unity build. Confirm that `/unity/manifest.json` and its referenced assets are available after deployment.

### Experimental one-hand controls

Gesture controls are off by default. Select Unity and open the gesture trial panel to enable the camera. Face the **back of your hand toward the camera** and hold a thumbs-up for about 0.7 seconds to switch between pan, rotate, and zoom. Relax the gesture before the next switch or pinch interaction; panel buttons remain available. See [Gesture controls and rollback](docs/implementation/手势控制实验与回滚.md) for controls, validation limits, and checkpoints.

## Music and sound

Five original tracks follow the public chapter: opening/briefing, West Gate, Market, Main Bridge, and ending. Transitions take about two seconds; tracks loop with overlap. Opening reports or switching map views does not restart the music.

Interact with the page or enter the briefing to enable audio. The **Sound** panel provides mute and separate **Music** and **Ambience** controls, saved in the current browser. Music ducks during read-aloud; background sound is muted while recording. Audio pauses when the page is hidden and resumes when it returns. If the browser blocks playback or a file fails to load, the panel offers a play or retry control.

Music is served as static application assets and needs no API key. See [Music system](docs/music-system.md) for versions, loop boundaries, and validation notes.

## Language support

- A new browser starts in English, independent of the operating system's language.
- The title screen saves the selected language for later visits.
- Each mission keeps its starting language. To use another language, start a new mission; changing preferences does not reset an active mission or refund resources.
- Scenes, reports, advisor templates, debriefs, and controls are localized. Player input and quoted statements remain in their original language.
- Both languages share the same rules, budgets, time model, and hidden scenario variants. Live models receive the mission's output-language instruction.

## Saves, recovery, and cloud hosting

Local saves use SQLite at `.last-mile/game.sqlite`, with WAL, transactions, idempotent commands, and immutable terminal records. Refreshing the browser does not reset actual play time. During the same server run, the current page can be recovered.

Stopping or restarting the backend seals unfinished missions as technical interruptions. Resumable pause-and-continue play is not implemented; unlimited play time does not mean a mission survives server shutdown as an active run.

To inspect a sealed local record after a restart, obtain its `outcome.sessionId` from an exported debrief and run:

```bash
pnpm exec tsx --env-file-if-exists=.env server/index.ts --resume-session YOUR_SESSION_UUID
```

Then open `http://127.0.0.1:3111/?session=YOUR_SESSION_UUID`. Local mode does not provide a history picker across server runs; exporting the complete debrief at the ending is the simplest way to keep a record. `LAST_MILE_DB` changes the local database path and `PORT` changes the local port.

The hosted configuration uses **Render for the application and Neon PostgreSQL for persistent storage**, with invite-based access, separate browser identities, session ownership checks, and model usage limits. Players can access their own historical records after a restart. Run only one game-engine instance against a database. Follow the [Render + Neon deployment guide](docs/implementation/云端试玩部署.md); `render.yaml` and `deploy/render.env.example` contain the baseline configuration. Use the Unity build command above when deploying the prebuilt scene.

Server API keys belong in Render's environment, not in GitHub. Keep `DATABASE_URL` and `LAST_MILE_COOKIE_SECRET` private. The public playtest invite code in this README is a player entry code, not a provider API key or a database credential.

## Development and verification

```bash
pnpm build         # Type checking and production frontend build
pnpm test          # Core, API, AI, security, geometry, and UI-copy checks
pnpm test:ui       # Browser regression tests; see suite-specific server setup
pnpm verify:model  # Safe configuration summary; no model calls by default
```

To explicitly run paid provider checks using synthetic fixtures rather than player saves:

```bash
pnpm verify:model --live --role=all --locale=en-US --attempts=1 --output=.local-artifacts/model-smoke-en.json
```

`--role` accepts `advisor`, `evaluator`, or `all`; `--locale` accepts `en-US` or `zh-CN`. The default is one attempt per role. `--attempts=2` allows one repair attempt within the job budget. Reports may only be written under the Git-ignored `.local-artifacts/` directory. Configuration checks do not print key values.

Validation records are dated milestones, not a claim that every deployment or provider account has passed every check. See [Immediate-action validation](docs/instant-actions.md), [Cloud implementation validation](docs/implementation/云端改造验收.md), and [Real-model validation](docs/implementation/真实模型接入验收.md). Historical test counts remain in those reports.

Browser automation defaults to Chrome on macOS. Other systems can set `PLAYWRIGHT_CHROME_PATH` or install Playwright Chromium. Tests using an injected clock are distinct from real-time browser checks; there is no public HTTP endpoint for time acceleration or chapter skipping.

## Repository and documentation

The application version is **v0.3.0** in `package.json`. The **v0.5 engineering baseline** is a separate design-document version, not the current application release number. Runtime behavior is defined by the current code, tests, and implementation notes; historical timed-game proposals do not override the unlimited-time implementation.

| Path | Contents |
| --- | --- |
| `client/src/` | React interface, 2D/Three.js maps, Unity integration, and visibility receipts |
| `client/public/assets/` | Public map models, scene illustrations, and audio assets |
| `server/core/` | Story state machine, SQLite/PostgreSQL storage, resource ledger, clocks, and outcomes |
| `server/http/` | Fastify APIs, validation, authentication, event streams, speech, and static assets |
| `server/ai/` | Provider adapters, isolated contexts, evidence boundaries, output guards, and templates |
| `unity/` | Unity project and build instructions |
| `scripts/` and `tests/` | Build tools, model checks, and automated regression suites |
| `docs/engineering_v0.5/` | Versioned design baseline, editable architecture diagrams, and runtime contracts/data |
| `docs/implementation/` | Implementation notes, validation records, and differences from the baseline |
| `assets/authoring/` | Blender sources, map previews, and authoring data |
| `docs/releases/` | Historical release validation and screenshots |
| `.local-artifacts/` | Ignored local packages, backups, and temporary outputs |
| `archive/` | Ignored historical material retained only on the original development machine |

Useful references:

- [Documentation index](docs/README.md)
- [PRD](docs/engineering_v0.5/01_PRD.md) and [high-level design](docs/engineering_v0.5/02_HLD.md)
- [Current architecture](docs/implementation/architecture-current/README.md)
- [Project structure and versions](docs/项目目录与版本.md)
- [API keys and GitHub workflow](docs/开发与GitHub.md)
- [Implemented story and chapters](docs/implementation/故事与关卡实装.md)
- [Implementation-to-design mapping](docs/implementation/实施与设计映射.md)

Some supporting documents remain in Chinese. This repository is public and includes full story definitions and authoring data, so repository readers can see spoilers even though the game browser receives only permitted information. A clone does not include keys, player databases, Unity caches, or the original developer's local archives. No external Codex workspace is required to run the project.

## Project status

LAST MILE is a playable prototype with a hosted playtest, local development mode, and the v0.5 `SINGLE_PLAYER_REFERENCE` / `design_preview` rules as its design foundation. It remains subject to complete live-model playtesting, balance and onboarding feedback, and validation on the machines used for the event. Historical review labels are retained in the design records rather than presented as completed player validation.
