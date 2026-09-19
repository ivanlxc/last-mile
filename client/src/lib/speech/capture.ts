import { setSpeechActivity } from "./activity";
import { TranscriptBuffer, type TranscriptMessage } from "./transcript";

export type RecordingState = "idle" | "starting" | "recording" | "finalizing";
export type RecordingResult = {
  confirmed: string;
  partial: boolean;
  error?: string;
};
type Callbacks = {
  onState(state: RecordingState): void;
  onTranscript(value: { confirmed: string; interim: string }): void;
  onFinish(result: RecordingResult): void;
};
type Session = {
  buffer: TranscriptBuffer;
  stream?: MediaStream;
  context?: AudioContext;
  source?: MediaStreamAudioSourceNode;
  node?: AudioWorkletNode;
  socket?: WebSocket;
  timer?: ReturnType<typeof setTimeout>;
  trackEnded?: () => void;
  rejectReady?: (error: Error) => void;
  stopping: boolean;
  stopSent: boolean;
};

/** Owns one microphone session. The socket stays open after capture stops so
 * Deepgram's final segment reaches the editable draft before Send is enabled. */
export class SpeechCapture {
  private current: Session | null = null;
  constructor(private readonly callbacks: Callbacks) {}

  async start(maxSeconds = 90): Promise<void> {
    if (this.current) return;
    const session: Session = {
      buffer: new TranscriptBuffer(),
      stopping: false,
      stopSent: false,
    };
    this.current = session;
    this.callbacks.onState("starting");
    this.callbacks.onTranscript(session.buffer.snapshot());
    setSpeechActivity({ recording: true });
    try {
      if (
        !globalThis.isSecureContext ||
        !navigator.mediaDevices?.getUserMedia ||
        typeof AudioContext === "undefined" ||
        typeof AudioWorkletNode === "undefined"
      ) {
        throw new Error(
          "Voice input needs a supported browser on HTTPS or localhost.",
        );
      }
      this.armTimeout(
        session,
        30_000,
        "Microphone setup timed out. You can still type your question.",
      );
      const context = new AudioContext();
      session.context = context;
      // Resume during the click gesture, before any permission or network await.
      const resume = context.resume().then(
        () => null,
        (error: unknown) => error,
      );
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (this.current !== session) {
        stream.getTracks().forEach((track) => track.stop());
        await resume;
        return;
      }
      session.stream = stream;
      session.trackEnded = () =>
        this.finish(
          session,
          "Microphone disconnected. Confirmed words were kept; check your draft.",
        );
      stream
        .getAudioTracks()
        .forEach((track) =>
          track.addEventListener("ended", session.trackEnded!),
        );
      const resumeError = await resume;
      if (resumeError) throw resumeError;
      await context.audioWorklet.addModule("/audio/capture.worklet.js");
      if (this.current !== session) return;
      await this.connect(session);
      if (this.current !== session) return;
      const node = new AudioWorkletNode(context, "last-mile-microphone", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 1,
        channelCountMode: "explicit",
      });
      session.node = node;
      node.port.onmessage = ({
        data,
      }: MessageEvent<{ type: string; buffer?: ArrayBuffer }>) => {
        if (this.current !== session) return;
        if (data.type === "pcm" && data.buffer && !session.stopSent) {
          const socket = session.socket;
          if (socket?.readyState !== WebSocket.OPEN) return;
          if (socket.bufferedAmount > 256_000) {
            this.finish(
              session,
              "The voice connection is too slow. Confirmed words were kept; check your draft.",
            );
            return;
          }
          socket.send(data.buffer);
        } else if (data.type === "flushed" && session.stopping) {
          this.sendStop(session);
        }
      };
      node.onprocessorerror = () =>
        this.finish(
          session,
          "Microphone processing stopped. Check your draft before sending.",
        );
      session.source = context.createMediaStreamSource(stream);
      session.source.connect(node);
      node.connect(context.destination);
      clearTimeout(session.timer);
      session.timer = setTimeout(
        () => this.stop(),
        Math.max(1, Math.min(maxSeconds, 90) - 1) * 1000,
      );
      this.callbacks.onState("recording");
    } catch (error) {
      if (this.current !== session) return;
      const name = error instanceof Error ? error.name : "";
      this.finish(
        session,
        name === "NotAllowedError"
          ? "Microphone access was not allowed. You can still type your question."
          : error instanceof Error
            ? error.message
            : "Voice input could not start. You can still type your question.",
      );
    }
  }

  stop() {
    const session = this.current;
    if (!session || session.stopping) return;
    session.stopping = true;
    clearTimeout(session.timer);
    if (!session.node) {
      this.finish(session);
      return;
    }
    this.callbacks.onState("finalizing");
    // The worklet flushes its final partial 100 ms packet before the stop frame.
    session.node.port.postMessage({ type: "stop" });
    this.armTimeout(
      session,
      2_000,
      "The final audio packet could not be saved. Check your draft before sending.",
    );
  }

  dispose() {
    const session = this.current;
    if (!session) return;
    this.current = null;
    this.release(session);
    setSpeechActivity({ recording: false });
  }

  private connect(session: Session) {
    return new Promise<void>((resolve, reject) => {
      session.rejectReady = reject;
      const url = new URL("/api/v1/speech/transcribe", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      session.socket = socket;
      socket.onmessage = (event) => {
        if (this.current !== session) return;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(event.data as string);
        } catch {
          this.finish(
            session,
            "Voice returned an unreadable response. Check your draft.",
          );
          return;
        }
        if (message.type === "ready") {
          session.rejectReady = undefined;
          resolve();
        } else if (
          message.type === "transcript" &&
          typeof message.text === "string" &&
          typeof message.isFinal === "boolean"
        ) {
          this.callbacks.onTranscript(
            session.buffer.accept(message as TranscriptMessage),
          );
        } else if (message.type === "done") {
          this.finish(session);
        } else if (message.type === "error") {
          this.finish(
            session,
            typeof message.message === "string"
              ? message.message
              : "Voice connection failed. Check your draft.",
          );
        }
      };
      socket.onerror = () =>
        this.finish(
          session,
          "Voice connection failed. Confirmed words were kept; you can still type.",
        );
      socket.onclose = () => {
        if (this.current === session)
          this.finish(
            session,
            "Voice disconnected before final confirmation. Check your draft.",
          );
      };
    });
  }

  private sendStop(session: Session) {
    if (session.stopSent || this.current !== session) return;
    session.stopSent = true;
    this.releaseAudio(session);
    if (session.socket?.readyState !== WebSocket.OPEN) {
      this.finish(
        session,
        "Voice disconnected before final confirmation. Check your draft.",
      );
      return;
    }
    session.socket.send(JSON.stringify({ type: "stop" }));
    this.armTimeout(
      session,
      10_000,
      "Final transcription timed out. Confirmed words were kept; check your draft.",
    );
  }

  private armTimeout(session: Session, ms: number, message: string) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => this.finish(session, message), ms);
  }

  private finish(session: Session, error?: string) {
    if (this.current !== session) return;
    this.current = null;
    const transcript = session.buffer.snapshot();
    this.release(session);
    setSpeechActivity({ recording: false });
    this.callbacks.onState("idle");
    this.callbacks.onFinish({
      confirmed: transcript.confirmed,
      partial: Boolean(error || transcript.interim),
      ...(error ? { error } : {}),
    });
  }

  private releaseAudio(session: Session) {
    if (session.stream) {
      for (const track of session.stream.getAudioTracks()) {
        if (session.trackEnded)
          track.removeEventListener("ended", session.trackEnded);
      }
      session.stream.getTracks().forEach((track) => track.stop());
      session.stream = undefined;
    }
    session.source?.disconnect();
    session.source = undefined;
    if (session.node) {
      session.node.port.onmessage = null;
      session.node.onprocessorerror = null;
      session.node.port.close();
      session.node.disconnect();
      session.node = undefined;
    }
    void session.context?.close().catch(() => {});
    session.context = undefined;
  }

  private release(session: Session) {
    clearTimeout(session.timer);
    this.releaseAudio(session);
    session.rejectReady?.(new Error("Voice input stopped."));
    session.rejectReady = undefined;
    if (session.socket) {
      session.socket.onmessage =
        session.socket.onerror =
        session.socket.onclose =
          null;
      session.socket.close();
      session.socket = undefined;
    }
  }
}
