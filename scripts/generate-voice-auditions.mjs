// Generate four short English voice comparisons. Credentials remain local.
// Run: node --env-file-if-exists=.env scripts/generate-voice-auditions.mjs
import { mkdir, writeFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../assets/authoring/voice-auditions/v1/", import.meta.url);
const text = "West Gate checkpoint. The main road is visible, but permission to pass has not been confirmed. Check the latest report before choosing your route.";
const voices = [
  { name: "Athena", model: "aura-2-athena-en", gender: "feminine", accent: "American", character: "Calm, smooth, professional" },
  { name: "Orion", model: "aura-2-orion-en", gender: "masculine", accent: "American", character: "Approachable, comfortable, calm" },
  { name: "Draco", model: "aura-2-draco-en", gender: "masculine", accent: "British", character: "Warm, approachable, baritone" },
  { name: "Helena", model: "aura-2-helena-en", gender: "feminine", accent: "American", character: "Caring, natural, friendly, raspy" },
];
const key = process.env.DEEPGRAM_API_KEY?.trim();
if (!key || /[\r\n]/.test(key)) {
  throw new Error("Configure a valid local DEEPGRAM_API_KEY before generating auditions.");
}
await mkdir(root, { recursive: true });
for (const voice of voices) {
  const destination = new URL(`${voice.name.toLowerCase()}.mp3`, root);
  if (await access(destination).then(() => true, () => false)) {
    console.log(`Keeping existing audition: ${voice.name}`);
    continue;
  }
  const url = new URL("https://api.deepgram.com/v1/speak");
  url.search = new URLSearchParams({ model: voice.model, encoding: "mp3" }).toString();
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Token ${key}`, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("audio/mpeg")) {
    throw new Error(`Voice generation failed for ${voice.name}: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 1024 || bytes.length > 4 * 1024 * 1024) {
    throw new Error(`Unexpected audio size for ${voice.name}`);
  }
  await writeFile(destination, bytes, { flag: "wx" });
  console.log(`Generated ${voice.name}: ${bytes.length} bytes -> ${fileURLToPath(destination)}`);
}
await writeFile(new URL("manifest.json", root), JSON.stringify({
  purpose: "English narrator comparison, not applied to the game",
  provider: "Deepgram", family: "Aura-2", checkedOn: "2026-09-19",
  currentConfiguredVoice: "aura-2-thalia-en",
  source: "https://developers.deepgram.com/docs/tts-models",
  text, voices: voices.map(voice => ({ ...voice, file: `${voice.name.toLowerCase()}.mp3` })),
}, null, 2) + "\n");
