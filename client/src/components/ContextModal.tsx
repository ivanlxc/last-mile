import { useI18n, getChannelScopes } from "../lib/i18n";
export { getChannelScopes } from "../lib/i18n";
/** Backward-compatible public Chinese copy; rendering uses the selected locale. */
export const channelScopes = getChannelScopes("zh-CN");
import { Clock3, X } from "lucide-react";
import type { Game } from "../lib/useGame";
import { timer } from "../lib/narrative";
import { useVisibleReceipt } from "../lib/useVisibleReceipt";
import { Modal } from "./Modal";
export function ContextModal({
  game,
  missionTimeMs,
  onClose,
}: {
  game: Game;
  missionTimeMs: number;
  onClose: () => void;
}) {
  const { t, locale, duration, characters, channelLabels, channelScope } =
    useI18n();
  const s = game.state!,
    ref = useVisibleReceipt(
      `${s.sessionId}:${s.sceneId}:${s.stateVersion}`,
      () => void game.receipt("context_displayed"),
      0.98,
    );
  return (
    <Modal
      wide
      title={t("ui.resourcesCostsAndInformationLimits")}
      onClose={onClose}
    >
      <div ref={ref} className="context-body">
        <div className="context-time">
          <Clock3 size={15} />
          <span>
            {t("context.elapsed", {
              time: timer(missionTimeMs),
              medical:
                s.medical.status === "stable"
                  ? t("medical.stable")
                  : t("medical.priority"),
            })}
          </span>
        </div>
        <div className="context-channels">
          {s.resources.map((r) => (
            <article key={r.channel}>
              <strong>
                {channelLabels[r.channel]}
                <b>
                  {t("resources.remaining", {
                    remaining: r.remaining,
                    total: r.initial,
                  })}
                </b>
              </strong>
              <p>{channelScope(r.channel)}</p>
            </article>
          ))}
        </div>
        <div className="context-actions">
          {s.actionOptions
            .filter((a) => a.kind === "route")
            .map((a) => (
              <div key={a.actionId}>
                <strong>
                  {a.label}
                  <span>
                    {duration(a.cost.knownDurationMs)}{" "}
                    {t("ui.additionalDelayPossible")}
                  </span>
                </strong>
                <p>{a.knownRisk}</p>
              </div>
            ))}
        </div>
        <p className="context-quotas">
          {t("context.quotas", {
            reports: s.reportQuotas
              .filter((q) => q.sceneId === s.sceneId)
              .map((q) =>
                t("context.roleQuota", {
                  name: characters[q.role].name,
                  count: q.remaining,
                }),
              )
              .join(locale === "en-US" ? "; " : "，"),
            uploads: s.uploadQuota?.remaining ?? 5,
            tasks: s.activeTasks.length,
          })}
        </p>
      </div>
      <button className="primary" onClick={onClose}>
        {" "}
        {t("ui.returnToCommand")}{" "}
      </button>
    </Modal>
  );
}
