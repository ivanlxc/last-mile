import { useEffect, useState, type ReactNode } from "react";
import { ArrowRight, KeyRound, RefreshCw, ShieldCheck } from "lucide-react";
import {
  LocaleProvider,
  readPreferredLocale,
  savePreferredLocale,
  type Locale,
} from "../lib/i18n";
import "./cloud-access.css";

export type AccessMode = "local" | "cloud";
const words = {
  "en-US": {
    label: "INVITED PLAYTEST",
    title: "Your next decision\nstarts here.",
    body: "A convoy. Twenty civilians. Incomplete information. Enter your invitation code to begin LAST MILE.",
    code: "Invitation code",
    enter: "Enter playtest",
    busy: "Checking access…",
    checking: "Connecting to LAST MILE…",
    retry: "Try again",
    unavailable:
      "We couldn’t reach the game. Check your connection and try again.",
    invalid: "That invitation code was not accepted.",
    limited: "Too many attempts. Please wait before trying again.",
    device:
      "Your missions are linked to this browser. Keep its cookies to return to your records.",
    footer: "One commander · Three decisions · Human + AI",
  },
  "zh-CN": {
    label: "受邀试玩",
    title: "下一次决定，\n从这里开始。",
    body: "一支车队，二十名平民，还有不完整的情报。输入邀请口令，进入 LAST MILE。",
    code: "邀请口令",
    enter: "进入试玩",
    busy: "正在验证…",
    checking: "正在连接 LAST MILE…",
    retry: "重试",
    unavailable: "暂时无法连接游戏，请检查网络后重试。",
    invalid: "邀请口令未通过验证。",
    limited: "尝试次数过多，请稍后再试。",
    device: "任务记录与当前浏览器关联。保留 Cookie，便可返回查看自己的记录。",
    footer: "一名指挥官 · 三次抉择 · 人与 AI",
  },
};

export function AccessGate({
  children,
}: {
  children: (mode: AccessMode) => ReactNode;
}) {
  const [locale, setLocale] = useState<Locale>(readPreferredLocale);
  const [access, setAccess] = useState<{
    authenticated: boolean;
    mode: AccessMode;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [error, setError] = useState<
    "invalid" | "limited" | "unavailable" | null
  >(null);
  const t = words[locale];
  async function check() {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/v1/access", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!r.ok) throw Error("unavailable");
      const value = await r.json();
      if (
        typeof value.authenticated !== "boolean" ||
        !["local", "cloud"].includes(value.mode)
      )
        throw Error("invalid response");
      setAccess(value);
    } catch {
      setError("unavailable");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void check();
  }, []);
  useEffect(() => {
    const expired = () => {
      if (access?.mode === "cloud") {
        setAccess({ authenticated: false, mode: "cloud" });
        setCode("");
      }
    };
    window.addEventListener("last-mile-access-required", expired);
    return () =>
      window.removeEventListener("last-mile-access-required", expired);
  }, [access?.mode]);
  if (access?.authenticated) return children(access.mode);
  const choose = (next: Locale) => {
    savePreferredLocale(next);
    setLocale(next);
  };
  return (
    <LocaleProvider locale={locale}>
      <main className="cloud-gate">
        <div className="cloud-gate-art" aria-hidden="true" />
        <header className="cloud-gate-nav">
          <strong>
            LAST MILE
            <span>{locale === "zh-CN" ? "最后一程" : "The final stretch"}</span>
          </strong>
          <div
            className="language-switch"
            role="group"
            aria-label={locale === "zh-CN" ? "选择语言" : "Select language"}
          >
            <button
              type="button"
              aria-pressed={locale === "en-US"}
              onClick={() => choose("en-US")}
            >
              English
            </button>
            <button
              type="button"
              aria-pressed={locale === "zh-CN"}
              onClick={() => choose("zh-CN")}
            >
              中文
            </button>
          </div>
        </header>
        <section className="cloud-gate-panel">
          <div className="overline">
            <ShieldCheck size={16} />
            {t.label}
          </div>
          <h1>
            {t.title.split("\n").map((line, i) => (
              <span key={line}>
                {i > 0 && <br />}
                {line}
              </span>
            ))}
          </h1>
          <p>{t.body}</p>
          {loading ? (
            <p role="status" className="cloud-access-status">
              {t.checking}
            </p>
          ) : !access ? (
            <button className="secondary" onClick={() => void check()}>
              <RefreshCw size={16} />
              {t.retry}
            </button>
          ) : (
            <form
              onSubmit={async (event) => {
                event.preventDefault();
                if (busy) return;
                setBusy(true);
                setError(null);
                try {
                  // No implicit retry: a lost response must not silently create another visitor.
                  const r = await fetch("/api/v1/access", {
                    method: "POST",
                    credentials: "same-origin",
                    headers: {
                      "Content-Type": "application/json",
                      "Accept-Language": locale,
                    },
                    body: JSON.stringify({ inviteCode: code }),
                  });
                  if (!r.ok) {
                    setError(
                      r.status === 429
                        ? "limited"
                        : r.status === 401
                          ? "invalid"
                          : "unavailable",
                    );
                    return;
                  }
                  setCode("");
                  await check();
                } catch {
                  setError("unavailable");
                } finally {
                  setBusy(false);
                }
              }}
            >
              <label htmlFor="invitation-code">
                <KeyRound size={15} />
                {t.code}
              </label>
              <input
                id="invitation-code"
                name="inviteCode"
                type="password"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                maxLength={256}
                required
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
              />
              <button
                className="primary"
                type="submit"
                disabled={busy || !code}
              >
                {busy ? t.busy : t.enter}
                <ArrowRight size={18} />
              </button>
            </form>
          )}
          {error && (
            <p className="cloud-access-error" role="alert">
              {t[error]}
            </p>
          )}
          <p className="cloud-access-note">{t.device}</p>
        </section>
        <footer className="cloud-gate-footer">{t.footer}</footer>
      </main>
    </LocaleProvider>
  );
}
