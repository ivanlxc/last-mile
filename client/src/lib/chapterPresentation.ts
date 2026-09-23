import type {
  OperationView,
  OutcomeView,
} from "../../../docs/engineering_v0.5/contracts/public.types";

/** Uses only confirmed public results. Never predict a branch from the action alone. */
export function chapterReceipt(operation: OperationView, chinese: boolean) {
  if (operation.status !== "completed" || operation.operationKind === "wait")
    return null;
  const refused =
    operation.actionId === "E3_BRIDGE" &&
    operation.currentLocation.nodeId === "N05";
  return {
    refused,
    title: refused
      ? chinese
        ? "桥头 · 通行申请未获批准"
        : "Bridge approach / passage not granted"
      : chinese
        ? "车队位置已更新"
        : "Convoy position updated",
    summary: operation.publicProgressLabel,
    next: refused
      ? chinese
        ? "车队仍在河西。你可以继续核查已获得的报告，或选择旧河床便道；调查和上报额度不会补满。"
        : "The convoy remains on the west bank. Review your reports, investigate further, or choose the riverbed route. Investigation and report allowances have not reset."
      : chinese
        ? "上一段行动已结算。进入新的现场，继续核对信息并决定下一步。"
        : "The previous action is settled. Enter the next field scene, check the information, and decide what comes next.",
  };
}
export function arrivalStory(outcome: OutcomeView, chinese: boolean) {
  if (outcome.finalLocation.nodeId !== "N07") return null;
  return {
    title: chinese ? "黎明接收站" : "Daybreak reception point",
    scene:
      outcome.terminationReason !== "awaiting_transfer" &&
      outcome.pendingTasks.manifest !== "pending" &&
      outcome.pendingTasks.inspection !== "pending"
        ? chinese
          ? "发动机渐渐安静下来。乘员握着那把一路带来的家门钥匙，望向接待棚。地图上的最后一段路走完了；每个人接下来的生活，仍有很长的路。"
          : "The engines settle into silence. A passenger holds the house key they carried through the valley and looks toward the reception tents. The last stretch on the map is over. Their lives continue beyond it."
        : chinese
          ? "车队抵达了接收区，乘员仍在等待交接安排。抵达地点与完成任务，是两项不同的记录。"
          : "The convoy has reached the reception area. The passengers are waiting for the handover arrangements. Reaching the destination and completing the mission are separate records.",
    closing: chinese
      ? "现在回看：你当时知道什么？AI 看到了什么？哪些判断有证据支持？"
      : "Look back now: what did you know, what did the AI see, and which judgments were supported by evidence?",
  };
}
