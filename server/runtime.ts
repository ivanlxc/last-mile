import { createAiService } from "./ai/index.js";

/** Cloud playtests must fail at startup rather than silently launch offline. */
export function configuredAgents(
  mode: "local" | "cloud",
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (
    mode === "cloud" &&
    env.MODEL_PROVIDER !== "openai" &&
    env.MODEL_PROVIDER !== "anthropic"
  ) {
    throw new Error(
      "Cloud mode requires MODEL_PROVIDER=openai or anthropic. Offline mode is for local development.",
    );
  }
  const agents = createAiService({ repoRoot, env });
  if (mode === "cloud" && !agents.configured) {
    throw new Error(
      "Cloud mode requires a non-empty provider API key and model ID in server environment variables.",
    );
  }
  return agents;
}
