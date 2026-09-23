import { lazy, Suspense } from "react";
import type { P } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { arrivalStory } from "../lib/chapterPresentation";
import "./campaign-fields.css";
const ArrivalViewport = lazy(() => import("./ArrivalViewport"));
export function ArrivalScene({ outcome }: { outcome: P.OutcomeView }) {
  const { locale } = useI18n(),
    chinese = locale === "zh-CN";
  const story = arrivalStory(outcome, chinese);
  if (!story) return null;
  const status = (value: P.PendingTasks["manifest"]) =>
    chinese
      ? { pending: "待办理", completed: "已完成", notRequired: "无需办理" }[
          value
        ]
      : {
          pending: "Pending",
          completed: "Completed",
          notRequired: "Not required",
        }[value];
  return (
    <section className="arrival-scene" data-testid="arrival-scene">
      <Suspense fallback={<div className="arrival-viewport" />}>
        <ArrivalViewport chinese={chinese} />
      </Suspense>
      <div className="arrival-narrative">
        <span className="eyebrow">
          {chinese ? "尾声 / 二十段新的旅程" : "EPILOGUE / TWENTY NEW CHAPTERS"}
        </span>
        <h2>{story.title}</h2>
        <p>{story.scene}</p>
        <div className="handoff-receipt" data-testid="handoff-receipt">
          <span>
            {chinese ? "乘员名单" : "Passenger manifest"}
            <b>{status(outcome.pendingTasks.manifest)}</b>
          </span>
          <span>
            {chinese ? "车辆检查" : "Vehicle inspection"}
            <b>{status(outcome.pendingTasks.inspection)}</b>
          </span>
          <span>
            {chinese ? "医疗状态" : "Medical status"}
            <b>
              {outcome.medical.status === "stable"
                ? chinese
                  ? "稳定"
                  : "Stable"
                : chinese
                  ? "需优先转送"
                  : "Priority support needed"}
            </b>
          </span>
        </div>
        <p className="arrival-reflection">{story.closing}</p>
      </div>
    </section>
  );
}
