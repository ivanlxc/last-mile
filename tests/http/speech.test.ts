import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { createHttpApp } from "../../server/http/app.js";
import { loadHttpConfig } from "../../server/http/config.js";
import {
  loadSpeechConfig,
  type SpeechOptions,
} from "../../server/http/speech.js";
import type { GameService } from "../../server/core/service.js";

const apps: FastifyInstance[] = [];
const token = "test-speech-cookie";
const httpConfig = {
  ...loadHttpConfig({ LAST_MILE_ROOT: process.cwd() }),
  clientDir: "/__no_client__",
};
const headers = {
  host: "127.0.0.1:3111",
  cookie: `${httpConfig.cookieName}=${token}`,
  origin: "http://127.0.0.1:5173",
};
const config = loadSpeechConfig({ DEEPGRAM_API_KEY: "test-provider-key" });

class ProviderSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: Array<string | Buffer> = [];
  terminated = false;
  constructor(autoOpen = true) {
    super();
    if (autoOpen) queueMicrotask(() => this.open());
  }
  open() {
    if (this.terminated) return;
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }
  send(data: string | Buffer) {
    this.sent.push(data);
  }
  terminate() {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1006);
  }
  result(text: string, final: boolean, start = 0, duration = 1) {
    this.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "Results",
          channel: { alternatives: [{ transcript: text }] },
          is_final: final,
          speech_final: final,
          start,
          duration,
        }),
      ),
      false,
    );
  }
  finish() {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", 1000);
  }
}

async function fixture(overrides: SpeechOptions = {}) {
  const sockets: ProviderSocket[] = [];
  const connect = vi.fn((_url: string, _apiKey: string) => {
    const socket = new ProviderSocket();
    sockets.push(socket);
    return socket as unknown as WebSocket;
  });
  const fetchAudio = vi.fn(
    async () =>
      new Response(new Uint8Array([73, 68, 51, 1]), {
        headers: { "Content-Type": "audio/mpeg" },
      }),
  );
  const app = await createHttpApp({
    service: { launchId: "speech-test" } as GameService,
    config: httpConfig,
    launchToken: token,
    speech: { config, connect, fetch: fetchAudio, ...overrides },
  });
  apps.push(app);
  async function open(customHeaders = headers) {
    const messages: Array<Record<string, unknown>> = [];
    const client = await app.injectWS(
      "/api/v1/speech/transcribe",
      {
        headers: customHeaders,
        socket: { remoteAddress: "127.0.0.1" } as never,
      },
      {
        onInit: (socket) =>
          socket.on("message", (data) =>
            messages.push(JSON.parse(data.toString())),
          ),
      },
    );
    return { client, messages };
  }
  const synthesize = (body: unknown, extraHeaders = {}) =>
    app.inject({
      method: "POST",
      url: "/api/v1/speech/synthesize",
      headers: { ...headers, ...extraHeaders },
      payload: body as object,
    });
  return { app, sockets, connect, fetchAudio, open, synthesize };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.useRealTimers();
});

describe("optional English speech service", () => {
  it("keeps credentials server-side and rejects configurable endpoints or foreign voices", async () => {
    const { app, synthesize, fetchAudio } = await fixture();
    const response = await app.inject({
      url: "/api/v1/speech/config",
      headers,
    });
    expect(response.json()).toEqual({
      enabled: true,
      language: "en",
      sttModel: "nova-3",
      ttsModel: "aura-2-thalia-en",
      maxRecordingSeconds: 90,
      maxTextLength: 2000,
    });
    expect(response.body).not.toContain("test-provider-key");
    expect(
      (await synthesize({ text: "Hello", url: "https://example.com" }))
        .statusCode,
    ).toBe(400);
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(() =>
      loadSpeechConfig({ DEEPGRAM_TTS_MODEL: "aura-2-julius-de" }),
    ).toThrow("English");
    expect(
      loadSpeechConfig({ DEEPGRAM_API_KEY: "key", DEEPGRAM_ENABLED: "false" })
        .enabled,
    ).toBe(false);
  });

  it("requires existing cookie authentication and an allowed Origin for WebSocket upgrades", async () => {
    const { app, open, connect } = await fixture();
    expect(
      (
        await app.inject({
          url: "/api/v1/speech/config",
          headers: { host: headers.host },
        })
      ).statusCode,
    ).toBe(401);
    await expect(open({ ...headers, cookie: "" })).rejects.toThrow("401");
    await expect(
      open({ ...headers, origin: "https://attacker.example" }),
    ).rejects.toThrow("403");
    await expect(
      open({ ...headers, origin: undefined } as never),
    ).rejects.toThrow("403");
    expect(connect).not.toHaveBeenCalled();
  });

  it("works without a key and never calls the provider when speech is disabled", async () => {
    const { app, open, synthesize, connect, fetchAudio } = await fixture({
      config: loadSpeechConfig({}),
    });
    expect(
      (await app.inject({ url: "/api/v1/speech/config", headers })).json()
        .enabled,
    ).toBe(false);
    expect((await synthesize({ text: "Hello" })).statusCode).toBe(503);
    await expect(open()).rejects.toThrow("503");
    expect(connect).not.toHaveBeenCalled();
    expect(fetchAudio).not.toHaveBeenCalled();
  });

  it("streams PCM and delivers the last final result before done after CloseStream", async () => {
    const { open, sockets, connect } = await fixture();
    const { client, messages } = await open();
    await vi.waitFor(() => expect(messages[0]?.type).toBe("ready"));
    const provider = sockets[0]!;
    const url = new URL(connect.mock.calls[0]![0] as unknown as string);
    expect(url.origin).toBe("wss://api.deepgram.com");
    expect(url.searchParams.get("language")).toBe("en");
    expect(url.searchParams.get("sample_rate")).toBe("16000");
    expect(url.searchParams.get("diarize")).toBeNull();
    client.send(Buffer.from([1, 0, 2, 0]));
    await vi.waitFor(() =>
      expect(provider.sent[0]).toEqual(Buffer.from([1, 0, 2, 0])),
    );
    provider.result("Is the", false);
    client.send(JSON.stringify({ type: "stop" }));
    await vi.waitFor(() =>
      expect(provider.sent[1]).toBe('{"type":"CloseStream"}'),
    );
    expect(provider.terminated).toBe(false);
    provider.result("Is the bridge clear?", true);
    provider.finish();
    await vi.waitFor(() => expect(messages.at(-1)?.type).toBe("done"));
    expect(messages.slice(1)).toEqual([
      {
        type: "transcript",
        text: "Is the",
        isFinal: false,
        speechFinal: false,
        segmentId: "0:1",
      },
      {
        type: "transcript",
        text: "Is the bridge clear?",
        isFinal: true,
        speechFinal: true,
        segmentId: "0:1",
      },
      { type: "done" },
    ]);
  });

  it("bounds concurrent recordings and releases the slot on browser disconnect", async () => {
    const { open, sockets, connect } = await fixture();
    const first = await open();
    const second = await open();
    await vi.waitFor(() => expect(second.messages[0]?.type).toBe("error"));
    expect(connect).toHaveBeenCalledTimes(1);
    first.client.terminate();
    await vi.waitFor(() => expect(sockets[0]!.terminated).toBe(true));
    const third = await open();
    await vi.waitFor(() => expect(third.messages[0]?.type).toBe("ready"));
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("starts the recording cap only after a slow provider handshake is ready", async () => {
    const provider = new ProviderSocket(false);
    const { open } = await fixture({
      connect: () => provider as unknown as WebSocket,
    });
    vi.useFakeTimers({
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "Date",
      ],
    });
    const { messages } = await open();
    await vi.advanceTimersByTimeAsync(9000);
    provider.open();
    await vi.waitFor(() => expect(messages[0]?.type).toBe("ready"));
    await vi.advanceTimersByTimeAsync(82_000);
    expect(provider.sent).not.toContain('{"type":"CloseStream"}');
    await vi.advanceTimersByTimeAsync(8000);
    expect(provider.sent).toContain('{"type":"CloseStream"}');
    provider.result("", true);
    provider.finish();
    await vi.waitFor(() => expect(messages.at(-1)?.type).toBe("done"));
    expect(messages.some((message) => message.type === "error")).toBe(false);
  });

  it("rejects non-PCM frames and does not surface provider error details", async () => {
    const { open, sockets } = await fixture();
    const first = await open();
    await vi.waitFor(() => expect(first.messages[0]?.type).toBe("ready"));
    first.client.send(Buffer.from([1, 2, 3]));
    await vi.waitFor(() => expect(first.messages.at(-1)?.type).toBe("error"));
    expect(sockets[0]!.terminated).toBe(true);
    const second = await open();
    await vi.waitFor(() => expect(second.messages[0]?.type).toBe("ready"));
    sockets[1]!.emit("error", new Error("private upstream diagnostics"));
    await vi.waitFor(() => expect(second.messages.at(-1)?.type).toBe("error"));
    expect(JSON.stringify(second.messages)).not.toContain("private upstream");
  });

  it("reports a bounded flush timeout instead of claiming an incomplete transcript finished", async () => {
    const { open, sockets } = await fixture({ flushTimeoutMs: 20 });
    const { client, messages } = await open();
    await vi.waitFor(() => expect(messages[0]?.type).toBe("ready"));
    client.send('{"type":"stop"}');
    await vi.waitFor(() => expect(messages.at(-1)?.type).toBe("error"));
    expect(messages.some((message) => message.type === "done")).toBe(false);
    expect(sockets[0]!.terminated).toBe(true);
  });

  it("synthesizes only bounded text as private MP3 and retains media CSP", async () => {
    const { synthesize, fetchAudio } = await fixture();
    expect((await synthesize({ text: " " })).statusCode).toBe(400);
    expect((await synthesize({ text: "a".repeat(2001) })).statusCode).toBe(400);
    const response = await synthesize({ text: " Check the crossing. " });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("audio/mpeg");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain(
      "media-src 'self' blob:",
    );
    expect(response.rawPayload).toEqual(Buffer.from([73, 68, 51, 1]));
    const [url, init] = fetchAudio.mock.calls[0]! as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.origin).toBe("https://api.deepgram.com");
    expect(url.searchParams.get("model")).toBe("aura-2-thalia-en");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body as string)).toEqual({
      text: "Check the crossing.",
    });
  });

  it("rejects upstream errors and oversized audio without leaking response content", async () => {
    const denied = await fixture({
      fetch: vi.fn(
        async () => new Response("private upstream response", { status: 401 }),
      ),
    });
    const result = await denied.synthesize({ text: "Hello" });
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain("private upstream");
    const large = await fixture({
      fetch: vi.fn(
        async () =>
          new Response(new Uint8Array(4 * 1024 * 1024 + 1), {
            headers: { "Content-Type": "audio/mpeg" },
          }),
      ),
    });
    expect((await large.synthesize({ text: "Hello" })).statusCode).toBe(503);
  });

  it("limits synthesis starts and does not send over-budget requests upstream", async () => {
    const { synthesize, fetchAudio } = await fixture();
    for (let i = 0; i < 60; i++)
      expect((await synthesize({ text: "Hello" })).statusCode).toBe(200);
    expect((await synthesize({ text: "Hello" })).statusCode).toBe(429);
    expect(fetchAudio).toHaveBeenCalledTimes(60);
  });
});
