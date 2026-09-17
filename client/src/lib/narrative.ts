import type { SceneId } from "../../../docs/engineering_v0.5/contracts/public.types";

export const campaign = {
  title: "LAST MILE",
  subtitle: "最后一程",
  callSign: "曙光 07",
  region: "萨赫尔河谷",
  premise: "二十个人。一条回家的路。没有完整的答案。",
  briefing: [
    "临时停火后的傍晚，萨赫尔河谷的通信仍断断续续。曙光接收站正在撤收最后一班转运车，你的车队必须在十分钟内抵达河对岸。",
    "车上是二十名平民。有人带着家里的钥匙，有人只带了证件。医护员提醒：八分钟后，一位乘客需要优先医疗转送。时间不会因为我们还在讨论而停下。",
    "你是车队指挥官。情报员诺亚负责影像与路况，联络员萨米拉负责机构和目击者。AI 顾问可以分析你交给它的材料，最终的决定由你作出。",
  ],
  closing: "地图上的最后一段路，是二十个人的下一段生活。",
  tutorial: [
    {
      number: "01",
      title: "先确认自己知道什么",
      text: "向诺亚或萨米拉索取已有简报；也可以安排新的调查。每人每关最多上报 3 条，调查完成时会自动上报。",
    },
    {
      number: "02",
      title: "给 AI 看什么，由你决定",
      text: "每关最多上传 5 张情报卡。AI 不会自动看到其他卡片、倒计时或资源余量；自由输入会被标记为你的未核实陈述。",
    },
    {
      number: "03",
      title: "行动，也意味着放下问题",
      text: "调查会消耗时间和整局共享资源。选择路线后车队立即执行，未完成的调查将取消；已消耗的渠道次数不会退回。",
    },
    {
      number: "04",
      title: "结束后，重新看见你的决定",
      text: "复盘分别记录任务结果和你的信息使用方式。成功抵达不等于每次判断都好，信息不足时也不会强行给你贴标签。",
    },
  ],
};
export const characters = {
  analyst: {
    name: "诺亚",
    nameEn: "NOAH",
    role: "情报员",
    initials: "N",
    channel: "影像 / 路况",
    line: "我可以告诉你画面里有什么，也会说明画面看不到什么。",
  },
  liaison: {
    name: "萨米拉",
    nameEn: "SAMIRA",
    role: "联络员",
    initials: "S",
    channel: "机构 / 目击者",
    line: "我会问清楚：是谁亲眼看见，又是谁听别人说的。",
  },
};
export const scenes: Record<
  SceneId,
  {
    number: string;
    title: string;
    english: string;
    location: string;
    image: string;
    intro: string;
    radio: string;
    speaker: string;
    atmosphere: string;
    topics: { id: string; label: string }[];
  }
> = {
  E1: {
    number: "01",
    title: "门后的答案",
    english: "THE WEST GATE",
    location: "西门检查站 · N01",
    image: "/assets/gate.png",
    intro:
      "岗亭的无线电里传来断续的登记指令。主路穿过西门，南侧服务路绕向市集。地图画出了两条路，却没有告诉你此刻该走哪一条。",
    radio: "名单在我手上。走主门可以办理登记；绕行的话，这件事还得在后面处理。",
    speaker: "萨米拉",
    atmosphere: "发动机低声运转。一名乘客把证件放回了外衣口袋。",
    topics: [
      { id: "gate_status", label: "当前登记状态" },
      { id: "manifest", label: "名单与交接" },
      { id: "roads", label: "路线情况" },
    ],
  },
  E2: {
    number: "02",
    title: "回声的重量",
    english: "ECHOES IN THE MARKET",
    location: "旧市集 · N02",
    image: "/assets/market.png",
    intro:
      "一声爆响从街巷深处传来。白色皮卡、封路、不同的讲述者——消息比车队跑得更快。真正需要确定的，是主路现在能不能走。",
    radio: "我听到了几种很像的说法。先别把转述的人数，当成亲眼看见的人数。",
    speaker: "萨米拉",
    atmosphere: "风掀起商铺的遮阳布。前车的刹车灯映在车窗上。",
    topics: [
      { id: "roads", label: "当前道路通行" },
      { id: "cause", label: "消息与来源" },
    ],
  },
  E3: {
    number: "03",
    title: "河的另一边",
    english: "THE OTHER SIDE",
    location: "主桥西端 · N05",
    image: "/assets/bridge.png",
    intro:
      "接收站就在河对岸。主桥更直接，旧河床便道更长。桥面在暮色中显得完整，但看得见的结构与车辆通行许可，是两个不同的问题。",
    radio: "快到了。请把“桥还在”和“我们的车现在可以通过”分开确认。",
    speaker: "诺亚",
    atmosphere: "河面反射着最后的天光。车内有人开始整理随身的行李。",
    topics: [
      { id: "bridge_status", label: "主桥与车辆许可" },
      { id: "ford_status", label: "旧河床便道" },
      { id: "manifest", label: "待办交接" },
      { id: "roads", label: "路线情况" },
    ],
  },
};
export const channelLabels = {
  satellite: "卫星侦察",
  drone: "无人机侦察",
  localAgency: "当地机构",
  witness: "目击者",
};
export const dimensionLabels = {
  complacency: "过度依赖",
  distrust: "过度怀疑",
  overCaution: "过度谨慎",
  calibratedTrust: "校准信任",
};
export const supportLabels = {
  not_assessable: "证据不足",
  not_observed: "未观察到",
  observed_once: "单次迹象",
  repeated_observation: "重复迹象",
};
export const reasonLabels = {
  evidence_supported: "依据已知证据",
  current_conflict: "发现当前矛盾",
  accepted_uncertainty_for_time: "为时间接受不确定性",
  ai_said_so: "主要因为 AI 建议",
  prior_ai_error_only: "主要因为 AI 以前出错",
  new_question: "需要回答一个新问题",
  no_new_question: "暂时没有新问题",
};
export function duration(ms: number | null) {
  if (ms === null) return "时间未知";
  if (ms < 60000) return `${Math.ceil(ms / 1000)} 秒`;
  const m = Math.floor(ms / 60000),
    s = Math.round((ms % 60000) / 1000);
  return `${m} 分${s ? ` ${s} 秒` : ""}`;
}
export function timer(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
}
