import { translateFixed, type Locale } from "../localization.js";
/** Public capability map only. Never derives a current answer from a target,
 * hidden case, route outcome, or author-only source chain. */
export type PublicCheckChannel =
  "satellite" | "drone" | "localAgency" | "witness";
const targetQuestions: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    gate_satellite: ["historical_gate_surface"],
    gate_drone: ["gate_activity"],
    gate_agency: ["gate_registration"],
    gate_witness: ["gate_driver_experience"],
    service_drone: ["service_lane"],
    market_satellite: ["historical_market_surface"],
    market_drone: ["market_lane"],
    market_clearance: ["south_lane"],
    market_agency: ["market_reported_cause"],
    market_witness: ["market_reported_cause"],
    bridge_satellite: ["historical_bridge_surface"],
    bridge_drone: ["bridge_signage"],
    bridge_agency: ["bridge_permission"],
    bridge_witness: ["ford_driver_experience"],
    ford_drone: ["ford_lane"],
  });
const cannotConfirm: Readonly<Record<PublicCheckChannel, readonly string[]>> =
  Object.freeze({
    satellite: ["gate_registration", "bridge_permission", "market_lane"],
    drone: [
      "gate_registration",
      "bridge_permission",
      "explosion_cause",
      "hostile_intent",
    ],
    localAgency: [],
    witness: [],
  });
/** Callers handling provenance_trace must select source_chain instead. An
 * explicit player-declared question is retained even if the channel cannot
 * answer it. Unknown targets have no inferred capability. */
export function questionKeysForTarget(targetId: string): string[] {
  return [...(targetQuestions[targetId] ?? [])];
}
export function cannotConfirmQuestionKeys(
  channel: PublicCheckChannel,
): string[] {
  return [...cannotConfirm[channel]];
}
export function publicChannelScopeText(
  channel: PublicCheckChannel,
  locale: Locale = "zh-CN",
): string {
  const descriptions: Record<PublicCheckChannel, string> = {
    satellite:
      "卫星资料是历史地表观察，不能确认当前登记系统、通行许可或集市当前车道状态。",
    drone:
      "无人机只能观察可见区域，不能确认登记系统、通行许可、爆炸原因或人员敌意。",
    localAgency:
      "机构联系只提供其授权与掌握范围内的答复；转述不自动成为现场事实。",
    witness: "目击者只提供个人经历与转述；不能仅凭人数认定独立来源或事件原因。",
  };
  return translateFixed(descriptions[channel], locale);
}
