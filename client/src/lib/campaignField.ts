import type { SceneId } from "../../../docs/engineering_v0.5/contracts/public.types";
import {
  MARKET_LAYOUT,
  marketCopy,
  type FieldLayout,
  type FieldBox,
} from "./marketField";

const stations = [
  { id: "noah" as const, x: -3.2, z: 2 },
  { id: "samira" as const, x: 3.2, z: -3 },
  { id: "recon" as const, x: -3.6, z: -7 },
  { id: "command" as const, x: 4.6, z: 9 },
];
const commonSolids: readonly FieldBox[] = [
  { x: -4.65, z: 2, width: 1.6, depth: 2.5 },
  { x: 4.65, z: -3, width: 1.6, depth: 2.5 },
  { x: -4.8, z: -7, width: 1.5, depth: 2.3 },
  { x: 6.1, z: 9, width: 2.6, depth: 5.4 },
  ...stations
    .filter((s) => s.id === "noah" || s.id === "samira")
    .map((s) => ({ ...s, width: 0.48, depth: 0.48 })),
];
const gate: FieldLayout = {
  spawn: { x: 0, z: 10, yaw: 0, pitch: 0 },
  bounds: { minX: -8, maxX: 8, minZ: -10, maxZ: 13 },
  stations,
  colliders: [
    ...commonSolids,
    { x: -6.9, z: -3, width: 2.2, depth: 3.5 },
    { x: 6.9, z: -6, width: 2.2, depth: 3.8 },
    { x: 0, z: -10, width: 16, depth: 0.5 },
  ],
};
const bridge: FieldLayout = {
  spawn: { x: 0, z: 10, yaw: 0, pitch: 0 },
  bounds: { minX: -8, maxX: 8, minZ: -10, maxZ: 13 },
  stations,
  colliders: [
    ...commonSolids,
    { x: -6.9, z: -5, width: 2.2, depth: 4 },
    { x: 6.9, z: -5, width: 2.2, depth: 4 },
    { x: 0, z: -10, width: 16, depth: 0.5 },
  ],
};
export function fieldLayout(scene: SceneId): FieldLayout {
  return scene === "E1" ? gate : scene === "E3" ? bridge : MARKET_LAYOUT;
}
/** Role topic menus contain only public, authored report categories. No case data. */
export const FIELD_TOPICS = {
  E1: {
    analyst: ["roads", "gate_status"],
    liaison: ["manifest", "gate_status"],
  },
  E2: { analyst: ["roads", "cause"], liaison: ["roads", "cause"] },
  E3: {
    analyst: ["roads", "bridge_status"],
    liaison: ["manifest", "ford_status"],
  },
} as const;
export function fieldCopy(scene: SceneId, chinese: boolean) {
  const base = marketCopy(chinese);
  if (scene === "E2") return base;
  const e1 = scene === "E1";
  return {
    ...base,
    title: chinese
      ? e1
        ? "西门 · 集结检查站"
        : "主桥 · 河西指挥点"
      : e1
        ? "West gate / assembly checkpoint"
        : "The other side / bridge approach",
    subtitle: e1 ? "ACT I / THE WEST GATE" : "ACT III / THE OTHER SIDE",
    enter: chinese
      ? e1
        ? "进入西门现场"
        : "进入主桥现场"
      : e1
        ? "Enter checkpoint on foot"
        : "Enter bridge approach",
    objective: chinese
      ? e1
        ? "核对登记安排与名单，再选择出发路线。"
        : "核实车辆通行许可与交接安排，完成最后一段护送。"
      : e1
        ? "Check registration and the manifest. Choose how to depart."
        : "Verify vehicle clearance and handover. Complete the final crossing.",
    environment: chinese
      ? e1
        ? "车队集结区；登记状况须通过报告确认。"
        : "河西停靠区；桥梁外观不代表当前通行许可。"
      : e1
        ? "Convoy assembly area. Confirm registration through reports."
        : "West-bank staging area. Appearance is not vehicle clearance.",
    noahIntro: chinese
      ? e1
        ? "Noah 在检查站前整理路口图像和岗亭消息。选择问题后，他会按岗位上报额度提交简报。"
        : "Noah 将桥梁图像与道路资料分开整理。看见桥面，不等于知道车辆的通行条件。"
      : e1
        ? "Noah organizes junction imagery and checkpoint messages. Choose a question; each briefing uses one report slot."
        : "Noah separates bridge imagery from route records. Seeing a span does not establish vehicle clearance.",
    samiraIntro: chinese
      ? e1
        ? "Samira 保管乘员名单并联系登记人员。她可以提供名单交接和登记消息的简报。"
        : "Samira 联系接收站并整理旧河床便道的说法。已完成的手续以任务面板记录为准。"
      : e1
        ? "Samira keeps the passenger manifest and contacts registration staff. Ask about the handover or registration messages."
        : "Samira coordinates with reception and sorts accounts about the riverbed track. The mission panel records completed handover tasks.",
    loading: chinese ? "正在准备现场…" : "Preparing the field scene…",
    artLoading: chinese
      ? "正在载入场景模型…你可以继续调查。"
      : "Loading scene models… You can continue investigating.",
    artFallback: chinese
      ? "场景模型未能载入，地点调查仍可使用。"
      : "Scene art could not load. Location investigations remain available.",
    close: chinese ? "返回现场" : "Back to the field",
  };
}
