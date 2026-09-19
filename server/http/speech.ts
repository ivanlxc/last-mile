import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import WebSocket, { type RawData } from "ws";

const PCM_BYTES_PER_SECOND = 32_000;
const MAX_FRAME_BYTES = 65_536;
const MAX_BUFFER_BYTES = 262_144;
const MAX_AUDIO_RESPONSE_BYTES = 4 * 1024 * 1024;
const ENGLISH_VOICES = [
  "aura-2-draco-en",
  "aura-2-thalia-en",
  "aura-2-apollo-en",
] as const;

export interface SpeechConfig {
  apiKey: string;
  enabled: boolean;
  language: "en";
  sttModel: "nova-3";
  ttsModel: (typeof ENGLISH_VOICES)[number];
  maxRecordingSeconds: number;
  maxTextLength: number;
}

/** Only server environment is accepted; neither URLs nor models come from a player. */
export function loadSpeechConfig(
  env: NodeJS.ProcessEnv = process.env,
): SpeechConfig {
  const apiKey = env.DEEPGRAM_API_KEY?.trim() ?? "";
  const voice = env.DEEPGRAM_TTS_MODEL ?? "aura-2-draco-en";
  if (!ENGLISH_VOICES.includes(voice as SpeechConfig["ttsModel"]))
    throw new Error(
      "DEEPGRAM_TTS_MODEL must be a supported English Aura-2 voice",
    );
  if (/[\r\n]/.test(apiKey)) throw new Error("Invalid speech credentials");
  return {
    apiKey,
    enabled: Boolean(apiKey) && env.DEEPGRAM_ENABLED !== "false",
    language: "en",
    sttModel: "nova-3",
    ttsModel: voice as SpeechConfig["ttsModel"],
    maxRecordingSeconds: 90,
    maxTextLength: 2000,
  };
}

export interface SpeechOptions {
  config?: SpeechConfig;
  /** Dependency injection keeps protocol tests local and independent of credentials. */
  connect?: (url: string, apiKey: string) => WebSocket;
  fetch?: typeof globalThis.fetch;
  flushTimeoutMs?: number;
}

type Scope = { key: string; expiresAtMs?: number };

class SpeechBudget {
  private buckets = new Map<string, { count: number; until: number }>();
  private global = { count: 0, until: 0 };
  private active = new Map<string, number>();
  private activeTotal = 0;
  constructor(
    private readonly startsPerTenMinutes: number,
    private readonly globalStarts: number,
    private readonly perPlayer: number,
  ) {}
  acquire(key: string): (() => void) | null {
    const now = Date.now();
    for (const [id, bucket] of this.buckets)
      if (bucket.until <= now) this.buckets.delete(id);
    if (this.global.until <= now)
      this.global = { count: 0, until: now + 600_000 };
    const bucket = this.buckets.get(key) ?? { count: 0, until: now + 600_000 };
    if (
      this.activeTotal >= 4 ||
      (this.active.get(key) ?? 0) >= this.perPlayer ||
      bucket.count >= this.startsPerTenMinutes ||
      this.global.count >= this.globalStarts ||
      (!this.buckets.has(key) && this.buckets.size >= 1024)
    )
      return null;
    bucket.count++;
    this.global.count++;
    this.buckets.set(key, bucket);
    this.activeTotal++;
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeTotal--;
      const count = (this.active.get(key) ?? 1) - 1;
      if (count) this.active.set(key, count);
      else this.active.delete(key);
    };
  }
}

function fail(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
) {
  if (status === 429 || status === 503) reply.header("Retry-After", "5");
  return reply.code(status).send({ error: { code, message } });
}
function noQuery(request: FastifyRequest): boolean {
  return Object.keys((request.query ?? {}) as object).length === 0;
}
function asBytes(data: RawData): Buffer {
  return Array.isArray(data)
    ? Buffer.concat(data)
    : Buffer.isBuffer(data)
      ? data
      : Buffer.from(data);
}

export async function registerSpeechRoutes(
  app: FastifyInstance,
  scope: (request: FastifyRequest) => Scope,
  options: SpeechOptions = {},
): Promise<void> {
  const config = options.config ?? loadSpeechConfig();
  const connect =
    options.connect ??
    ((url: string, apiKey: string) =>
      new WebSocket(url, {
        headers: { Authorization: `Token ${apiKey}` },
        handshakeTimeout: 10_000,
        maxPayload: MAX_FRAME_BYTES,
        perMessageDeflate: false,
        followRedirects: false,
      }));
  const fetchAudio = options.fetch ?? globalThis.fetch;
  const transcriptions = new SpeechBudget(12, 60, 1);
  const synthesis = new SpeechBudget(60, 240, 2);
  const cleanups = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const cleanup of cleanups) cleanup();
  });

  app.get("/api/v1/speech/config", async (request, reply) => {
    if (!noQuery(request))
      return fail(
        reply,
        400,
        "INVALID_REQUEST",
        "Speech options are server configured.",
      );
    const { apiKey: _secret, ...publicConfig } = config;
    return publicConfig;
  });

  app.get(
    "/api/v1/speech/transcribe",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!noQuery(request))
          return fail(
            reply,
            400,
            "INVALID_REQUEST",
            "Speech options are server configured.",
          );
        if (!config.enabled)
          return fail(
            reply,
            503,
            "SPEECH_DISABLED",
            "Voice input is not configured.",
          );
      },
    },
    (client, request) => {
      const identity = scope(request);
      const release = transcriptions.acquire(identity.key);
      if (!release) {
        client.send(
          JSON.stringify({
            type: "error",
            message: "Voice input is busy. Try again shortly.",
          }),
        );
        client.close(1013, "Speech limit reached");
        return;
      }
      let upstream: WebSocket | undefined;
      let closed = false;
      let stopping = false;
      let receivedBytes = 0;
      let receivedFrames = 0;
      let recordingStartedAt = Date.now();
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      let durationTimer: ReturnType<typeof setTimeout> | undefined;
      const connectTimer = setTimeout(
        () => error("Voice input could not connect. Try again."),
        10_000,
      ).unref();
      // Connection latency must not consume the player's recording window.
      // Credential expiry remains a separate hard limit, including final draining.
      const expiryTimer = identity.expiresAtMs
        ? setTimeout(
            () =>
              error(
                "Your game access expired. Reopen the game to record again.",
              ),
            Math.max(1, identity.expiresAtMs - Date.now()),
          ).unref()
        : undefined;
      const keepAlive = setInterval(() => {
        if (!stopping && upstream?.readyState === WebSocket.OPEN)
          upstream.send('{"type":"KeepAlive"}');
      }, 4000).unref();

      function send(message: object) {
        if (client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount > MAX_BUFFER_BYTES) {
          cleanup();
          client.terminate();
          return;
        }
        client.send(JSON.stringify(message));
      }
      function cleanup() {
        if (closed) return;
        closed = true;
        clearTimeout(connectTimer);
        clearTimeout(durationTimer);
        clearTimeout(expiryTimer);
        clearTimeout(flushTimer);
        clearInterval(keepAlive);
        cleanups.delete(shutdown);
        release!();
        if (upstream && upstream.readyState !== WebSocket.CLOSED)
          upstream.terminate();
      }
      function shutdown() {
        cleanup();
        client.terminate();
      }
      function error(message: string) {
        if (closed) return;
        send({ type: "error", message });
        cleanup();
        client.close(1011, "Speech unavailable");
      }
      function done() {
        if (closed) return;
        send({ type: "done" });
        cleanup();
        client.close(1000, "Transcription complete");
      }
      function stop() {
        if (closed || stopping) return;
        stopping = true;
        clearTimeout(durationTimer);
        clearInterval(keepAlive);
        if (upstream?.readyState !== WebSocket.OPEN) {
          done();
          return;
        }
        // CloseStream processes buffered audio and sends final Results before closing.
        // Closing the socket immediately here would lose the final spoken words.
        upstream.send('{"type":"CloseStream"}');
        flushTimer = setTimeout(
          () =>
            error(
              "Voice input timed out while finishing. Review the saved draft.",
            ),
          options.flushTimeoutMs ?? 8000,
        ).unref();
      }
      cleanups.add(shutdown);
      client.on("close", cleanup);
      client.on("error", cleanup);
      // Attach synchronously before opening the provider connection.
      client.on("message", (data, binary) => {
        if (closed) return;
        const bytes = asBytes(data);
        if (!binary) {
          if (bytes.length > 64) return error("Invalid voice input command.");
          try {
            const command = JSON.parse(bytes.toString());
            if (command?.type !== "stop" || Object.keys(command).length !== 1)
              return error("Invalid voice input command.");
            stop();
          } catch {
            error("Invalid voice input command.");
          }
          return;
        }
        if (stopping) return;
        receivedFrames++;
        receivedBytes += bytes.length;
        if (
          !bytes.length ||
          bytes.length % 2 ||
          bytes.length > MAX_FRAME_BYTES ||
          receivedFrames > config.maxRecordingSeconds * 100 ||
          receivedBytes > PCM_BYTES_PER_SECOND * config.maxRecordingSeconds ||
          receivedBytes >
            PCM_BYTES_PER_SECOND *
              ((Date.now() - recordingStartedAt) / 1000 + 5)
        )
          return error("Voice input exceeded its recording limit.");
        if (upstream?.readyState !== WebSocket.OPEN)
          return error("Voice input is not ready. Try again.");
        if (upstream.bufferedAmount > MAX_BUFFER_BYTES)
          return error("Voice connection is too slow. Try again.");
        upstream.send(bytes, { binary: true });
      });

      const url = new URL("wss://api.deepgram.com/v1/listen");
      url.search = new URLSearchParams({
        model: config.sttModel,
        language: "en",
        encoding: "linear16",
        sample_rate: "16000",
        channels: "1",
        punctuate: "true",
        smart_format: "true",
        interim_results: "true",
        endpointing: "300",
        utterance_end_ms: "1200",
        vad_events: "true",
      }).toString();
      try {
        upstream = connect(url.toString(), config.apiKey);
      } catch {
        error("Voice input could not connect. Try again.");
        return;
      }
      upstream.on("open", () => {
        if (closed) return;
        clearTimeout(connectTimer);
        recordingStartedAt = Date.now();
        durationTimer = setTimeout(
          () => stop(),
          config.maxRecordingSeconds * 1000,
        ).unref();
        send({ type: "ready" });
      });
      upstream.on("error", () =>
        error("Voice input is unavailable. Try again."),
      );
      upstream.on("close", (code) => {
        if (closed) return;
        if (stopping && code === 1000) done();
        else error("Voice input disconnected. Review the saved draft.");
      });
      upstream.on("message", (data, binary) => {
        if (closed || binary) return;
        try {
          const message = JSON.parse(asBytes(data).toString());
          if (message.type === "Error") {
            error("Voice input is unavailable. Try again.");
          } else if (message.type === "Results") {
            const text = message.channel?.alternatives?.[0]?.transcript;
            if (typeof text !== "string" || text.length > 8000)
              return error("Voice input returned an invalid response.");
            send({
              type: "transcript",
              text,
              isFinal: message.is_final === true,
              speechFinal: message.speech_final === true,
              ...(Number.isFinite(message.start) &&
              Number.isFinite(message.duration)
                ? { segmentId: `${message.start}:${message.duration}` }
                : {}),
            });
          }
        } catch {
          error("Voice input returned an invalid response.");
        }
      });
    },
  );

  app.post("/api/v1/speech/synthesize", async (request, reply) => {
    const body = request.body;
    if (
      !noQuery(request) ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as { text?: unknown }).text !== "string"
    )
      return fail(
        reply,
        400,
        "INVALID_REQUEST",
        "Provide only the text to read.",
      );
    const text = (body as { text: string }).text.trim();
    if (!text || text.length > config.maxTextLength)
      return fail(
        reply,
        400,
        "INVALID_REQUEST",
        "Text must contain 1–2000 characters.",
      );
    if (!config.enabled)
      return fail(
        reply,
        503,
        "SPEECH_DISABLED",
        "Read aloud is not configured.",
      );
    const identity = scope(request);
    const release = synthesis.acquire(identity.key);
    if (!release)
      return fail(
        reply,
        429,
        "RATE_LIMITED",
        "Read aloud is busy. Try again shortly.",
      );
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timeout = setTimeout(
      abort,
      Math.min(
        20_000,
        identity.expiresAtMs
          ? Math.max(1, identity.expiresAtMs - Date.now())
          : Infinity,
      ),
    ).unref();
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    cleanups.add(abort);
    try {
      const url = new URL("https://api.deepgram.com/v1/speak");
      url.search = new URLSearchParams({
        model: config.ttsModel,
        encoding: "mp3",
      }).toString();
      const response = await fetchAudio(url, {
        method: "POST",
        headers: {
          Authorization: `Token ${config.apiKey}`,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({ text }),
        signal: controller.signal,
        redirect: "error",
      });
      if (
        !response.ok ||
        !response.headers.get("content-type")?.startsWith("audio/mpeg") ||
        !response.body
      )
        throw new Error("Invalid speech response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_AUDIO_RESPONSE_BYTES) {
          controller.abort();
          await reader.cancel();
          throw new Error("Speech response exceeded limit");
        }
        chunks.push(chunk.value);
      }
      if (!length) throw new Error("Empty speech response");
      return reply
        .type("audio/mpeg")
        .header("Cache-Control", "no-store")
        .send(Buffer.concat(chunks));
    } catch {
      controller.abort();
      if (reply.raw.destroyed) return;
      return fail(
        reply,
        503,
        "SPEECH_UNAVAILABLE",
        "Read aloud is unavailable. Try again.",
      );
    } finally {
      clearTimeout(timeout);
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
      cleanups.delete(abort);
      release();
    }
  });
}
