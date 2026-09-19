import {
  type Locale,
  isLocale,
  readPreferredLocale,
  savePreferredLocale,
  formatError,
  translate,
} from "./i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { applyClockSample } from "./clockSample";
import {
  get,
  post,
  sessionPath,
  envelope,
  ApiError,
  type P,
  setRequestLocale,
} from "./api";
const savedSession = "last-mile-session-v1";
export function useGame() {
  const [preferredLocale, setPreferredLocaleState] =
    useState<Locale>(readPreferredLocale);
  const [bootstrap, setBootstrap] = useState<P.BootstrapView | null>(null),
    [health, setHealth] = useState<P.HealthView | null>(null);
  const [state, setState] = useState<P.SessionProjection | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [connected, setConnected] = useState(true);
  const locale: Locale =
    state && isLocale(state.locale) ? state.locale : preferredLocale;
  const localeRef = useRef(locale);
  localeRef.current = locale;
  useEffect(() => setRequestLocale(locale), [locale]);
  const setPreferredLocale = (next: Locale) => {
    if (ref.current?.lifecycle === "active") return;
    savePreferredLocale(next);
    setPreferredLocaleState(next);
  };
  const ref = useRef(state);
  ref.current = state;
  const apply = useCallback(
    (s: P.SessionProjection) =>
      setState((old) => {
        if (
          !old ||
          old.sessionId !== s.sessionId ||
          old.runEpoch !== s.runEpoch
        )
          return s;
        if (
          s.stateVersion < old.stateVersion ||
          (s.stateVersion === old.stateVersion &&
            (s.missionTimeMs < old.missionTimeMs ||
              (s.playerElapsedMs !== undefined &&
                old.playerElapsedMs !== undefined &&
                s.playerElapsedMs < old.playerElapsedMs)))
        )
          return old;
        // SSE and HTTP may interleave while instant simulation time is fixed.
        // Preserve the newest elapsed sample, including across older wire data.
        return old.playerElapsedMs === undefined
          ? s
          : {
              ...s,
              playerElapsedMs: Math.max(
                old.playerElapsedMs,
                s.playerElapsedMs ?? 0,
              ),
            };
      }),
    [],
  );
  const refreshJobs = useRef(
    new Map<
      string,
      {
        promise: Promise<P.SessionProjection | undefined>;
        controller: AbortController;
        again: boolean;
      }
    >(),
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const job of refreshJobs.current.values()) job.controller.abort();
      refreshJobs.current.clear();
    };
  }, []);
  const refresh = useCallback(
    (id?: string): Promise<P.SessionProjection | undefined> => {
      const sid = id ?? ref.current?.sessionId;
      if (!sid) return Promise.resolve(undefined);
      const existing = refreshJobs.current.get(sid);
      if (existing) {
        existing.again = true;
        return existing.promise;
      }
      const controller = new AbortController();
      const job = {
        controller,
        again: false,
        promise: Promise.resolve(undefined) as Promise<
          P.SessionProjection | undefined
        >,
      };
      job.promise = (async () => {
        let result: P.SessionProjection | undefined;
        do {
          job.again = false;
          result = await get<P.SessionProjection>(
            sessionPath(sid),
            controller.signal,
          );
          if (
            mounted.current &&
            !controller.signal.aborted &&
            ref.current?.sessionId === sid
          )
            apply(result);
        } while (job.again && mounted.current && !controller.signal.aborted);
        return result;
      })().finally(() => {
        if (refreshJobs.current.get(sid) === job)
          refreshJobs.current.delete(sid);
      });
      refreshJobs.current.set(sid, job);
      return job.promise;
    },
    [apply],
  );
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [b, h] = await Promise.all([
          get<P.BootstrapView>("/bootstrap"),
          get<P.HealthView>("/health"),
        ]);
        if (!alive) return;
        setBootstrap(b);
        setHealth(h);
        const linked = new URLSearchParams(location.search).get("session");
        const sid =
          linked && /^[a-f0-9-]{36}$/i.test(linked)
            ? linked
            : localStorage.getItem(savedSession);
        if (sid) {
          try {
            const s = await get<P.SessionProjection>(sessionPath(sid));
            if (alive) {
              apply(s);
              localStorage.setItem(savedSession, s.sessionId);
            }
          } catch (e) {
            localStorage.removeItem(savedSession);
            if (
              e instanceof ApiError &&
              e.problem.status !== 404 &&
              e.problem.status !== 403
            )
              throw e;
          }
        }
      } catch (e) {
        if (alive) setError(formatError(e, localeRef.current));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [apply]);
  useEffect(() => {
    if (!state?.sessionId) return;
    const sid = state.sessionId;
    const stream = new EventSource("/api/v1" + sessionPath(sid, "/events"));
    let disposed = false;
    let streamHealthy = false;
    stream.onopen = () => {
      streamHealthy = true;
      setConnected(true);
      resync();
    };
    stream.onerror = () => {
      streamHealthy = false;
      setConnected(false);
    };
    stream.addEventListener("projection.changed", (e) => {
      try {
        const v = JSON.parse((e as MessageEvent).data);
        apply(v.data ?? v);
      } catch {
        void refresh().catch(() => {});
      }
    });
    stream.addEventListener("clock.sample", (e) => {
      try {
        const sample = JSON.parse((e as MessageEvent).data) as P.SseClockSample;
        setState((old) => applyClockSample(old, sample));
        const current = ref.current;
        // Recover a missed projection, or an older server's clock-only packet.
        if (
          current?.sessionId === sid &&
          sample.sessionId === sid &&
          (sample.stateVersion > current.stateVersion ||
            sample.runEpoch !== current.runEpoch ||
            (!sample.data.location && current.phase === "resolving"))
        )
          resync();
      } catch {
        /* Next projection resynchronizes. */
      }
    });
    let pending: ReturnType<typeof setTimeout> | undefined;
    const resync = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = undefined;
        void refresh(sid).catch((e) => {
          if (!disposed) setError(formatError(e, localeRef.current));
        });
      }, 100);
    };
    for (const name of [
      "task.updated",
      "report.received",
      "uploads.changed",
      "advice.updated",
      "operation.updated",
      "outcome.sealed",
      "evaluation.updated",
      "export.updated",
    ])
      stream.addEventListener(name, resync);
    const interval = setInterval(() => {
      if (!streamHealthy) resync();
    }, 15000);
    const visible = () => {
      if (document.visibilityState === "visible") resync();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true;
      refreshJobs.current.get(sid)?.controller.abort();
      stream.close();
      clearInterval(interval);
      clearTimeout(pending);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [state?.sessionId, apply, refresh]);
  const perform = useCallback(
    async <T>(work: () => Promise<T>): Promise<T | undefined> => {
      setBusy(true);
      setError("");
      try {
        return await work();
      } catch (e) {
        setError(formatError(e, localeRef.current));
        if (e instanceof ApiError && e.problem.status === 409)
          await refresh().catch(() => {});
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );
  const create = useCallback(
    (selectedLocale: Locale = preferredLocale) =>
      perform(async () => {
        if (!bootstrap)
          throw Error(translate(selectedLocale, "error.notReady"));
        setRequestLocale(selectedLocale);
        const b = bootstrap.profiles[0];
        const r = await post<P.SessionCreated>("/sessions", {
          profileId: b.profileId,
          runPurpose: "design_preview",
          locale: selectedLocale,
          contentVersionId: b.contentVersionId,
        });
        localStorage.setItem(savedSession, r.sessionId);
        history.replaceState(null, "", location.pathname);
        apply(r.projection);
        return r;
      }),
    [bootstrap, perform, apply, preferredLocale],
  );
  const command = useCallback(
    <T>(tail: string, payload: unknown) =>
      perform(async () => {
        const s = ref.current;
        if (!s) throw Error(translate(localeRef.current, "error.noSession"));
        const r = await post<T>(
          sessionPath(s.sessionId, tail),
          envelope(s, payload),
          s.runEpoch,
        );
        await refresh();
        return r;
      }),
    [perform, refresh],
  );
  const receipt = useCallback(
    async (
      kind: P.DisplayReceiptRequest["payload"]["displayKind"],
      ids: { reportId?: string; jobId?: string; operationId?: string } = {},
    ) => {
      const s = ref.current;
      if (!s || s.lifecycle !== "active") return;
      await post(
        sessionPath(s.sessionId, "/display-receipts"),
        {
          observedStateVersion: s.stateVersion,
          observedSceneId: s.sceneId,
          payload: {
            displayKind: kind,
            reportId: ids.reportId ?? null,
            jobId: ids.jobId ?? null,
            operationId: ids.operationId ?? null,
          },
        },
        s.runEpoch,
      ).catch(() => {});
    },
    [],
  );
  return {
    bootstrap,
    health,
    locale,
    preferredLocale,
    setPreferredLocale,
    state,
    loading,
    busy,
    error,
    connected,
    create,
    command,
    perform,
    refresh,
    receipt,
    clearError: () => setError(""),
    home: () => {
      localStorage.removeItem(savedSession);
      history.replaceState(null, "", location.pathname);
      setState(null);
      setError("");
    },
  };
}
export type Game = ReturnType<typeof useGame>;
