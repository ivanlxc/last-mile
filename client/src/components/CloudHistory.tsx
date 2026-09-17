import { useEffect, useState } from "react";
import { History, ArrowUpRight } from "lucide-react";
import { get } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { Modal } from "./Modal";
interface SavedMission {
  sessionId: string;
  locale: "en-US" | "zh-CN";
  status: "created" | "active" | "sealed";
  createdAt: string;
  updatedAt: string;
}
export function CloudHistory() {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SavedMission[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setFailed(false);
    setSessions(null);
    void get<{ sessions: SavedMission[] }>("/my-sessions", controller.signal)
      .then((value) => setSessions(value.sessions))
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [open]);
  return (
    <>
      <button
        className="secondary cloud-history-trigger"
        onClick={() => setOpen(true)}
      >
        <History size={16} />
        {zh ? "我的任务记录" : "My missions"}
      </button>
      {open && (
        <Modal
          title={zh ? "我的任务记录" : "My missions"}
          onClose={() => setOpen(false)}
        >
          <p className="cloud-history-help">
            {zh
              ? "可以返回当前任务，或查看已结束与技术中断的记录。服务器重启后，进行中的任务会封存为技术中断。"
              : "Return to a mission or review completed and interrupted records. A server restart seals running missions as technically interrupted."}
          </p>
          {failed ? (
            <p role="alert">
              {zh
                ? "记录暂时无法加载，请关闭后重试。"
                : "Records could not be loaded. Close this panel and try again."}
            </p>
          ) : !sessions ? (
            <p role="status">
              {zh ? "正在读取记录…" : "Loading your missions…"}
            </p>
          ) : sessions.length === 0 ? (
            <p>{zh ? "还没有任务记录。" : "No missions yet."}</p>
          ) : (
            <div className="cloud-history-list">
              {sessions.map((s) => (
                <a
                  key={s.sessionId}
                  href={`/?session=${encodeURIComponent(s.sessionId)}`}
                >
                  <span>
                    <strong>
                      {s.status === "active"
                        ? zh
                          ? "继续任务"
                          : "Continue mission"
                        : s.status === "created"
                          ? zh
                            ? "任务简报"
                            : "Mission briefing"
                          : zh
                            ? "查看任务复盘"
                            : "Review mission"}
                    </strong>
                    <small>
                      {new Date(s.createdAt).toLocaleString(locale)} ·{" "}
                      {s.locale === "zh-CN" ? "中文" : "English"}
                    </small>
                    <small>{s.sessionId.slice(0, 8)}</small>
                  </span>
                  <ArrowUpRight size={18} />
                </a>
              ))}
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
