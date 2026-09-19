# Unity 接入建议（历史方案）

基于接入前实现 `e31f794` 编写。本目录保留当时的方案与可编辑图纸，其中“待实现”描述的是方案编写时的状态。Unity Web、Blender 场景与车队同步现已实现，当前行为及验证结果见 [Unity 接入实现说明](../../implementation/Unity接入本地试用.md)。

- [draw.io 源文件](Unity_Web_Integration_Proposal.drawio)
- [PNG 预览](Unity_Web_Integration_Proposal.png)

## 推荐范围

先把 Unity Web 作为 React 页面中的地图与场景显示区域。React 继续承担情报、调查、顾问、复盘、鉴权与 REST/SSE 网络会话。后端继续负责任务时间、资源、证据解锁、路线后果与持久化。

另两种方案是把完整客户端迁移为 Unity，或把规则模拟迁入 Unity。前者需要重建全部 UI 和客户端协议适配；后者涉及权威状态与规则的迁移，适合确有连续物理模拟需求时另行设计。

## 改动清单

| 范围 | 拟议改动 |
|---|---|
| 地图入口 | 在 `TacticalMap.tsx` 中增加 `UnityViewport`，保留原地图作为回退。 |
| 网页桥接 | 新增 Unity loader 生命周期、Ready 握手、快照传递、点击意图回调、错误与退出清理。React 统一提交命令。 |
| Unity 工程 | 新建场景、车队控制器、镜头控制器、热点标记和桥接脚本；从公开位置更新展示，按已有路线插值。 |
| 数据 | 第一阶段使用现有 `KnownLocation` / `SessionProjection` 的公开子集；仅在需要更丰富且合法可见的事件表现时扩展后端契约。 |
| 同步 | 使用 session / runEpoch / stateVersion / viewSequence 区分会话和新旧状态；Unity 重载后应用最新完整快照。时钟采样可在 stateVersion 不变时更新，不能只按 stateVersion 丢弃消息。 |
| 交互 | 地图选择先映射到公开节点或行动；消耗资源、启动调查、提交路线均经过现有 API 验证。相机操作只影响展示。 |
| 资产 | 可评估复用 `map.glb`，需处理导入方案、材质、坐标系、单位和模型标记映射。隐藏剧本不进入 Unity 资源。 |
| 部署 | 同源托管 Unity 构建，设置 JS / WASM 的 MIME 和压缩头，检查 CSP 对实际构建的支持；独立构建任务不混进普通 TypeScript 检查。 |
| 开局 | UnityReady 后再提交开始任务；优先预加载本局所需场景。进入后台、切换画面或本地暂停不会暂停服务器时钟。 |
| 复盘 | 保留现有日志与展示回执。若增加现场观察，必须将观察登记成有来源、时间与授权范围的证据，并纳入上传和评价规则。 |

## 桥接契约草案

这些是待实现的概念消息名，不是当前代码已有接口。

- `ApplyRenderState`：传递公开场景、位置、版本、已知标记与语言；不传整个后端 State。
- `SelectLocation`：在网页中打开对应位置的信息或调查面板。
- `RequestAction`：提交行动意图，由 React 使用现有命令通道处理；不代表已经执行成功。
- `UnityReady`：接收最新快照，解除加载状态；进入任务前确保关键资源就绪。
- `UnityFailed`：清理实例并回退到现有地图。

JS → Unity 可通过 `unityInstance.SendMessage` 传递 JSON 字符串；Unity → JS 可使用 `.jslib` 插件。Web 中继续由 JS 处理 EventSource，第一阶段无须改用 WebSocket 或引入多人网络组件。

## 最小验证范围

只完成一个检查站：加载场景 → 点击地图热点打开现有调查面板 → 收到公开报告 → 上传并请求 Advisor → 选择路线 → 车队按服务器位置移动。

验收包括：加载失败可回退、不会提前开始任务计时、刷新可恢复当前显示、断线重连可同步、旧事件不重复播放、没有未经调查就可见的隐藏剧情、路线完成由服务端决定、AI 与复盘输入边界保持成立。

## 玩法扩展顺序

1. 先增强空间感、镜头和行动反馈；沿用现有关卡规则。
2. 再增加有限的现场观察或调查镜头；为每项新增观察定义证据、时间成本、可见性和复盘规则。
3. 最后才评估自由驾驶、移动角色或连续物理事件。这些会把路线决策模型扩展成实时运动模拟，不能只增加一个 Unity 场景解决。

完整 Unity 桌面客户端还需要单独设计鉴权与会话策略：当前云端接口面向浏览器 Cookie 与 Origin 校验，不能假设桌面 HTTP 调用会直接兼容。

## 官方参考

- [Unity Web 与浏览器脚本交互](https://docs.unity3d.com/6000.3/Documentation/Manual/webgl-interactingwithbrowserscripting.html)
- [JavaScript 调用 Unity C#：SendMessage](https://docs.unity3d.com/6000.3/Documentation/Manual/web-interacting-browser-unity-to-js.html)
- [Unity C# 调用 JavaScript / .jslib](https://docs.unity3d.com/6000.3/Documentation/Manual/web-interacting-browser-js-to-unity.html)
- [Web 网络与跨域要求](https://docs.unity3d.com/6000.3/Documentation/Manual/webgl-networking.html)
- [Web 部署、压缩头与 WASM MIME](https://docs.unity3d.com/6000.3/Documentation/Manual/webgl-deploying.html)
