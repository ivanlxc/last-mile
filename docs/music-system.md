# Chapter music

The runtime soundtrack uses the five approved instrumental masters. Music follows
the public story stage; it does not encode hidden route conditions or reveal a
correct decision.

## Asset selection

`client/src/lib/music-cues.ts` defines the public URLs and repeat boundaries.
The source files below are relative to `assets/authoring/music-auditions/`.
Runtime copies in `client/public/audio/music/` are byte-for-byte identical to
those sources; the approved compositions were not edited for integration.

| Screen / chapter | Title | Source | Runtime file | Full duration |
| --- | --- | --- | --- | --- |
| Opening / briefing | Last Light | `v1/last-light.mp3` | `opening.mp3` | 67.000 s |
| E1 / West Gate | Weight of Passage | `v3/west-gate.mp3` | `west-gate.mp3` | 59.429 s |
| E2 / Market | Unsettled Accounts | `v5/market.mp3` | `market.mp3` | 72.000 s |
| E3 / Bridge | The Weight Across the Water | `v5/bridge.mp3` | `bridge.mp3` | 76.571 s |
| Ending / debrief | A Place to Rest | `v4/ending.mp3` | `ending.mp3` | 73.000 s |

All files are 48 kHz stereo MP3s, mastered to approximately −19 LUFS. The total
compressed asset size is 6,146,246 bytes (about 5.86 MiB). Each file is served from
the application itself; playback does not need an external music service.

The versioned authoring directories are historical audition records. In
particular, their `runtimeIntegrated: false` fields describe the state when those
auditions were created, not the current application. Preserve those records and
their original acceptance/review labels for comparison. The later user approval
selected the exact five files listed above for this integration.

## Repetition boundaries

These masters contain their original fade-in, ending phrase, and reverb tail.
They are not seamless loop exports. Playback overlaps two independently started
sources with complementary equal-power gain curves instead of enabling the
audio buffer's native `loop` flag over the whole MP3.

For each cue, `loopEndSeconds` is the composed duration
(`bars × beatsPerBar × 60 / bpm`) plus two seconds of release. A new source starts
six seconds before that endpoint. During those six seconds, the old source fades
out as the new opening fades in; the old source stops at the endpoint. This avoids
replaying the near-silent end of the audition master. Every later repetition uses
the same spacing.

| Cue | New source starts after | Old source stops after | Overlap |
| --- | --- | --- | --- |
| Opening | 56.000 s | 62.000 s | 6 s |
| E1 | 47.429 s | 53.429 s | 6 s |
| E2 | 60.000 s | 66.000 s | 6 s |
| E3 | 64.571 s | 70.571 s | 6 s |
| Ending | 60.000 s | 66.000 s | 6 s |

The overlap is musical phrase blending, not a bar-aligned or phase-locked loop.
The return of the piano themes can still be heard as a new phrase. Future changes
can replace the runtime files and boundaries with dedicated loop masters while
keeping the current approved auditions intact.

## Player behavior

`GameAudioProvider` in `client/src/lib/gameAudio.tsx` owns one shared audio
context for the soundtrack and procedural ambience across title, briefing,
gameplay, and debrief. A public active `sceneId` chooses E1/E2/E3; null state,
briefing, and prologue travel use the opening; every sealed run uses the
reflective ending. Game outcomes and private route conditions never select music.

The compact **Sound** control is available on every screen. It opens separate
**Music** and **Ambience** sliders plus a master mute. The browser stores these
preferences under `last-mile-audio-v1`; defaults are music 55%, ambience 32%,
enabled. First trusted interaction unlocks playback when enabled. A saved mute
is respected on reload; blocked playback and failed downloads have explicit
Play/Retry controls. Music failures leave the game and speech controls usable.

Narration lowers background levels; microphone recording silences background
audio to keep it out of voice prompts. Page hiding or master mute fades down and
suspends the shared audio clock; returning or unmuting resumes it. Ambience and
radio notifications run during active gameplay only. Soundtrack state survives
map renderer switches and opening/closing information panels.

`client/src/lib/music.ts` owns the `MusicPlayer` and shares the caller's
`AudioContext`. It fetches and decodes only the requested cue, retaining up to
three decoded cues for repeat visits. Re-requesting an already active cue does
not restart its playhead. Stale downloads are cancelled when the requested cue
changes.

Same-cue repetition uses 65-point sine/cosine gain curves for the six-second
equal-power overlap described above. A change of chapter instead uses a separate
two-second fade between cue buses. These are intentionally distinct operations:
one repeats a phrase within a chapter, while the other moves to a different
composition.

The player's volume input is independent of environmental sound. When its
`ducked` input is active, music falls to 15% of the selected level so that speech
has room; a hidden-page input makes it silent. Volume changes are smoothed, and
closing the player stops its scheduled sources, pending request, and scheduler.

## Provenance and validation

The source scores and mastering reports remain next to each audition MP3. The
original scores were rendered offline with the repository's Swift AVFoundation
renderer using the local macOS General MIDI / DLS instrument bank, then mastered
with the repository's Python / FFmpeg script. The operating-system instrument
bank itself is not copied into the repository.

Integration checks confirmed:

- Each runtime MP3 has the same SHA-256 hash as its source, decodes successfully,
  and is stereo at 48 kHz.
- Every configured repeat endpoint is inside the decoded track, and every
  overlap starts before that endpoint.
- A PCM simulation of each same-cue equal-power overlap contains finite samples
  and has peak magnitude below 0.456 (full scale is 1). This checks same-cue
  overlap headroom, not an arbitrary mix with speech, ambience, or another cue.
- Correlation between the outgoing and incoming six-second windows ranges from
  approximately −0.04 to +0.05, with no systematic phase cancellation. The
  market overlap includes an approximately 3 dB dip within its quiet ending;
  opening and ending retain their natural piano attacks. Numerical checks do
  not substitute for listening to musical transitions.

| Runtime file | Bytes | SHA-256 |
| --- | ---: | --- |
| `opening.mp3` | 1,260,472 | `dcdb289fbf02b20fbea9f040cb4e0da87207c1b78c6c16ef1b54929d206a6ff8` |
| `west-gate.mp3` | 1,015,621 | `509fd6e6d2c7605a7d07dda398e6950ff5620795cfbd71b6b08b65d999868fa3` |
| `market.mp3` | 1,173,013 | `977ec5ace4851a0ca35234d1e5d6c6df7bf1548f8f5b2672824d36295a387137` |
| `bridge.mp3` | 1,387,299 | `73e6043e3143ecb14d8a75e29b850ab9830bf3f417f5e9f26703b1d42312975f` |
| `ending.mp3` | 1,309,841 | `0616dc946f4b0c5a0031a8a4d19ecd751cef645d46d92cb9b756db21cd4f06ec` |

## Integration verification and checkpoints

- `pnpm build`: TypeScript and production assets.
- `pnpm exec vitest run tests/music.test.ts tests/audio-state.test.ts tests/speech-playback.test.ts`: source scheduling, crossfades, async cancellation, cache bounds, volume/ducking, disposal, public cue selection, stored preferences, and narration playback.
- `pnpm exec playwright test tests/ui/music.spec.ts tests/ui/speech-controls.spec.ts tests/ui/speech.spec.ts`: native browser decoding and playback across a full in-memory campaign, persisted controls, map/drawer continuity, download retry, speech ducking and microphone regressions. These fixtures use isolated databases and synthetic microphone data, not the player's live save or a physical microphone.

Before integration: `checkpoint/pre-music-integration-20260919` (`6e89913`).
Integrated version: `checkpoint/audio-06-game-integration`. Both are local Git
checkpoints; this step does not publish to GitHub.
