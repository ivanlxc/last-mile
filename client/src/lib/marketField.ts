/** Public, presentation-only geometry. Never import scenario/case content here. */
export type FieldPoint = { x: number; z: number };
export type FieldPose = FieldPoint & { yaw: number; pitch: number };
export type FieldBox = FieldPoint & { width: number; depth: number };
export type StationId = "noah" | "samira" | "recon" | "command";
export const FIELD_SPAWN: FieldPose = { x: 0, z: 11, yaw: 0, pitch: 0 };
export const FIELD_RADIUS = 0.32;
export const FIELD_BOUNDS = { minX: -10, maxX: 10, minZ: -15, maxZ: 15 };
export const FIELD_STATIONS: ReadonlyArray<FieldPoint & { id: StationId }> = [
  { id: "noah", x: -3.2, z: 5 },
  { id: "samira", x: 3.3, z: -2 },
  { id: "recon", x: -3.6, z: -9 },
  { id: "command", x: 4.6, z: 10 },
];
export const FIELD_BUILDINGS = [
  { x: -9, z: -11, width: 5, depth: 6, height: 6.4, color: "#bd986f" },
  { x: -9.5, z: -2.5, width: 6, depth: 7, height: 4.6, color: "#d3b58b" },
  { x: -9.5, z: 7, width: 6, depth: 7, height: 7.2, color: "#a98c72" },
  { x: 9.2, z: -10, width: 5.5, depth: 8, height: 8, color: "#b5a080" },
  { x: 9.5, z: 1, width: 6, depth: 9, height: 5.6, color: "#ceb696" },
  { x: 0, z: -19, width: 26, depth: 5, height: 5, color: "#af9c85" },
] as const;
export const FIELD_COLLIDERS: readonly FieldBox[] = [
  ...FIELD_BUILDINGS,
  { x: -4.5, z: 5, width: 1.8, depth: 2.8 },
  { x: 4.5, z: -2, width: 1.8, depth: 2.8 },
  { x: -4.5, z: -9, width: 2.2, depth: 2.2 },
  { x: 6.1, z: 10, width: 2.6, depth: 5.4 },
  // Sample storefront: pots and chair remain solid even when art falls back.
  { x: -6.03, z: 7, width: 0.6, depth: 0.6 },
  { x: -6, z: 9.92, width: 0.52, depth: 0.52 },
  { x: -5.75, z: 4.98, width: 0.6, depth: 0.62 },
  { x: -3.2, z: 5, width: 0.48, depth: 0.48 },
  { x: 3.2, z: -2, width: 0.48, depth: 0.48 },
];
export type FieldLayout = {
  spawn: FieldPose;
  bounds: typeof FIELD_BOUNDS;
  stations: ReadonlyArray<FieldPoint & { id: StationId }>;
  colliders: readonly FieldBox[];
};
export const MARKET_LAYOUT: FieldLayout = {
  spawn: FIELD_SPAWN,
  bounds: FIELD_BOUNDS,
  stations: FIELD_STATIONS,
  colliders: FIELD_COLLIDERS,
};
export function fieldPositionAllowed(
  point: FieldPoint,
  layout: FieldLayout = MARKET_LAYOUT,
) {
  const r = FIELD_RADIUS,
    b = layout.bounds;
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.z) &&
    point.x >= b.minX + r &&
    point.x <= b.maxX - r &&
    point.z >= b.minZ + r &&
    point.z <= b.maxZ - r &&
    !layout.colliders.some(
      (box) =>
        Math.abs(point.x - box.x) < box.width / 2 + r &&
        Math.abs(point.z - box.z) < box.depth / 2 + r,
    )
  );
}
/** Normalize diagonal movement, cap a stalled frame, and slide along walls. */
export function moveInField(
  pose: FieldPose,
  right: number,
  forward: number,
  seconds: number,
  layout: FieldLayout = MARKET_LAYOUT,
): FieldPose {
  if (
    ![right, forward, seconds, pose.x, pose.z, pose.yaw, pose.pitch].every(
      Number.isFinite,
    )
  )
    return pose;
  const length = Math.max(1, Math.hypot(right, forward));
  const distance = (Math.max(0, Math.min(seconds, 0.05)) * 3.2) / length;
  const dx =
    (Math.cos(pose.yaw) * right - Math.sin(pose.yaw) * forward) * distance;
  const dz =
    (-Math.sin(pose.yaw) * right - Math.cos(pose.yaw) * forward) * distance;
  const next = { ...pose };
  if (fieldPositionAllowed({ x: next.x + dx, z: next.z }, layout)) next.x += dx;
  if (fieldPositionAllowed({ x: next.x, z: next.z + dz }, layout)) next.z += dz;
  return next;
}
/** Interaction requires proximity and looking toward a station, not through a wall. */
export function nearbyStation(
  pose: FieldPose,
  layout: FieldLayout = MARKET_LAYOUT,
): StationId | null {
  let closest: StationId | null = null,
    distance = 3;
  for (const station of layout.stations) {
    const dx = station.x - pose.x,
      dz = station.z - pose.z,
      d = Math.hypot(dx, dz);
    if (
      d >= distance ||
      (d > 0.7 &&
        (-Math.sin(pose.yaw) * dx - Math.cos(pose.yaw) * dz) / d < 0.5)
    )
      continue;
    // Stops interaction through props/buildings; last half metre is the station itself.
    const samples = Math.ceil(Math.max(0, d - 0.5) / 0.15);
    let clear = true;
    for (let i = 1; i <= samples; i++) {
      const t =
        ((i / (samples + 1)) * Math.max(0, d - 0.5)) / Math.max(d, 0.001);
      // Sight is a thin ray. The player's collision radius is only for walking;
      // applying it here incorrectly makes a crew member occlude themselves.
      if (
        layout.colliders.some(
          (box) =>
            Math.abs(pose.x + dx * t - box.x) < box.width / 2 &&
            Math.abs(pose.z + dz * t - box.z) < box.depth / 2,
        )
      ) {
        clear = false;
        break;
      }
    }
    if (clear) {
      closest = station.id;
      distance = d;
    }
  }
  return closest;
}
export function marketCopy(chinese: boolean) {
  return chinese
    ? {
        title: "市集 · 临时指挥点",
        subtitle: "第二章 / 现场原型",
        enter: "进入市集现场",
        map: "返回战术地图",
        objective: "核对路况与消息来源，再决定车队路线。",
        walk: "点击画面控制视角 · WASD 移动 · E 交互 · Esc 释放鼠标",
        alternate: "也可拖动画面转向，方向键移动，Q / E 转向；按 Enter 交互。",
        engage: "查看",
        stations: "地点快捷访问",
        close: "返回现场",
        loading: "正在准备市集…",
        artLoading: "正在载入店面材质与模型…你可以继续移动和调查。",
        artFallback: "精细模型未能载入，已保留基础场景。调查功能仍可使用。",
        failed: "当前设备无法显示 3D 场景。你仍可通过下方地点按钮完成调查。",
        environment: "此处是车队停靠点；实际通行状况请通过情报核实。",
        paused: "现场控制已暂停",
        controls: "现场控制",
        noah: "Noah · 情报员",
        samira: "Samira · 联络员",
        recon: "侦察工作台",
        command: "车队指挥车",
        noahIntro:
          "Noah 在无线电旁整理收到的消息。先确定你要了解的问题，再请他传递简报。",
        samiraIntro:
          "Samira 正在协调当地联系人。不同渠道的说法未必是独立的目击信息。",
        reconIntro: "选择调查渠道，在下一步查看能力范围与消耗，再确认执行。",
        commandIntro:
          "车队等待你的决定。只有你主动上传的报告会进入 AI 顾问的资料包。",
        roads: "请求路况简报",
        cause: "请求巨响相关简报",
        allowance: "每条简报消耗该岗位本关 1 条上报额度；不消耗侦察渠道次数。",
        received: "已收到的简报",
        none: "尚未收到本站报告。",
        exhausted: "该岗位本关额度已用尽。",
        advisor: "打开 AI 顾问",
        intel: "打开证据档案",
        routes: "在地图上选择路线",
        report: "已收到报告",
        unavailable: "当前不可用",
        confirmed: "仅读取报告不会自动上传给 AI。",
        reportSlots: "剩余上报额度",
        forward: "向前",
        back: "向后",
        left: "向左",
        right: "向右",
        turnLeft: "左转",
        turnRight: "右转",
      }
    : {
        title: "Market / staging courtyard",
        subtitle: "ACT II / FIELD PROTOTYPE",
        enter: "Enter market on foot",
        map: "Tactical map",
        objective: "Check the road. Question the sources. Choose a route.",
        walk: "Click to look · WASD to move · E to interact · Esc to release",
        alternate:
          "Or drag to look, use arrow keys to move, Q / E to turn and Enter to interact.",
        engage: "Inspect",
        stations: "Location shortcuts",
        close: "Back to the courtyard",
        loading: "Preparing the courtyard…",
        artLoading:
          "Loading storefront materials and models… You can keep walking and investigating.",
        artFallback:
          "Detailed art could not load. The basic scene and investigation controls remain available.",
        failed:
          "3D is unavailable on this device. Use the location buttons below to continue your investigation.",
        environment:
          "Convoy staging area. Verify route conditions through intelligence.",
        paused: "Field controls paused",
        controls: "Field controls",
        noah: "Noah / Intelligence",
        samira: "Samira / Liaison",
        recon: "Recon workstation",
        command: "Command vehicle",
        noahIntro:
          "Noah sorts the incoming radio traffic. Decide what you need to know before asking him to relay a briefing.",
        samiraIntro:
          "Samira coordinates the local contacts. Different channels may be repeating the same original account.",
        reconIntro:
          "Choose a channel, then review its observation limits and cost before committing.",
        commandIntro:
          "The convoy is waiting for your decision. Only the reports you explicitly upload enter the AI advisor’s evidence packet.",
        roads: "Request road briefing",
        cause: "Request loud-bang briefing",
        allowance:
          "Each briefing uses one of this role’s three scene report slots; no recon channel use is charged.",
        received: "Received briefings",
        none: "No reports received at this station yet.",
        exhausted: "This role has no scene report slots left.",
        advisor: "Open AI advisor",
        intel: "Open evidence archive",
        routes: "Choose a route on the map",
        report: "Report received",
        unavailable: "Unavailable right now",
        confirmed: "Reading a report does not upload it to the AI.",
        reportSlots: "Report slots left",
        forward: "Move forward",
        back: "Move backward",
        left: "Move left",
        right: "Move right",
        turnLeft: "Turn left",
        turnRight: "Turn right",
      };
}
