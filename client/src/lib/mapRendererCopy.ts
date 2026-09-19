import type { Locale } from "./i18n";

const en = {
  unity: "Unity scene",
  setup: "Unity setup",
  checking: "Checking for a local Unity build…",
  missing:
    "Unity has not been built locally. The 2D and 3D maps are ready to use.",
  available: "Unity scene available · select Unity to explore",
  loading: "Loading Unity before departure. The mission clock has not started.",
  ready: "Unity connected · public route map",
  failed: "Unity could not run. The standard map is available.",
  loadingActive: "Loading Unity. The mission clock continues to run.",
  controls:
    "Left drag to pan · right drag to orbit · scroll to zoom · F to follow convoy",
  locations: "Explore locations",
  selected: "Selected location",
  closeLocation: "Close location details",
  mapOnly:
    "This is a schematic public location. Selecting it does not reveal conditions, move the convoy or spend resources.",
  investigate: "Investigate this location",
  otherLocation:
    "Investigations become available when the convoy reaches this decision point.",
  investigations: "Choose an investigation",
  investigationNote:
    "Review the channel, time and resource cost before confirming. The mission clock continues to run.",
  install:
    "Install Unity 6.3 LTS through Unity Hub, activate your license and include Web Build Support.",
  build:
    "From the project directory, run the following command. It creates the scene and installs the Web build automatically.",
  editor:
    "The Unity project is in unity/LastMile. You can also open it in the Editor to inspect or change the scene.",
  recheck: "Check for build again",
  useUnity: "Use Unity scene",
  useMap: "Continue with standard map",
};
const zh: typeof en = {
  unity: "Unity 场景",
  setup: "Unity 接入说明",
  checking: "正在检查本地 Unity 构建…",
  missing: "本地尚未构建 Unity。二维路线图和三维沙盘可直接使用。",
  available: "Unity 场景可用 · 点击 Unity 进入",
  loading: "正在加载 Unity，场景就绪后即可出发。任务计时尚未开始。",
  ready: "Unity 已连接 · 公开路线示意图",
  failed: "Unity 未能运行，已切回标准地图。",
  loadingActive: "正在加载 Unity，任务计时仍在继续。",
  controls: "左键平移 · 右键旋转 · 滚轮缩放 · F 跟随车队 · 点击地点查看",
  locations: "查看地点",
  selected: "已选地点",
  closeLocation: "关闭地点详情",
  mapOnly:
    "这里展示的是公开地点示意。选择地点不会揭示现场情况、移动车队或消耗资源。",
  investigate: "调查此地点",
  otherLocation: "车队到达该决策点后，才能发起相关调查。",
  investigations: "选择调查方式",
  investigationNote:
    "选择后先查看渠道、时间和资源成本，再确认调查。任务计时仍在继续。",
  install:
    "通过 Unity Hub 安装 Unity 6.3 LTS，激活许可证，并勾选 Web Build Support。",
  build: "在项目目录运行以下命令，自动生成场景并将 Web 构建接入网页。",
  editor: "Unity 工程位于 unity/LastMile，也可以在 Editor 中打开并修改场景。",
  recheck: "重新检查构建",
  useUnity: "使用 Unity 场景",
  useMap: "继续使用标准地图",
};
export const mapRendererCopy = (locale: Locale) =>
  locale === "zh-CN" ? zh : en;
