import type { P } from "./api";

/** A clock packet may move the public convoy without changing game stateVersion.
 * Never let delayed packets cross a command, a run, or a newer projection. */
export function applyClockSample(
  previous: P.SessionProjection | null,
  sample: P.SseClockSample,
): P.SessionProjection | null {
  if (
    !previous ||
    !sample ||
    sample.eventType !== "clock.sample" ||
    sample.sessionId !== previous.sessionId ||
    sample.runEpoch !== previous.runEpoch ||
    previous.lifecycle !== "active" ||
    sample.stateVersion !== previous.stateVersion ||
    !sample.data ||
    !Number.isSafeInteger(sample.data.missionTimeMs) ||
    sample.data.missionTimeMs < previous.missionTimeMs ||
    (sample.data.playerElapsedMs !== undefined &&
      (!Number.isSafeInteger(sample.data.playerElapsedMs) ||
        sample.data.playerElapsedMs < (previous.playerElapsedMs ?? 0)))
  )
    return previous;
  return {
    ...previous,
    missionTimeMs: sample.data.missionTimeMs,
    // Instant actions advance simulation time independently of play time. Equal
    // mission timestamps may still carry a newer elapsed sample while reading.
    // Older persisted packets have no elapsed value and must preserve this one.
    ...(sample.data.playerElapsedMs === undefined
      ? {}
      : { playerElapsedMs: sample.data.playerElapsedMs }),
    serverNow: sample.data.serverNow,
    // Historical outbox packets did not contain location; keep their compatibility.
    location: sample.data.location ?? previous.location,
  };
}
