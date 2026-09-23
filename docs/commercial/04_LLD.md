# LLD / 三关现场与尾声 M1

日期：2026-09-22。这里描述可按代码执行的 M1；未实现的 Unity/现场观察扩展单列在末尾。本次没有新 HTTP endpoint、SQL migration 或 Agent prompt。所有业务数据继续采用现有类型和 Schema。

## 1. 组件和文件契约

| 文件 | 职责 | 输入 | 输出 / 副作用 |
| --- | --- | --- | --- |
| `client/src/lib/marketField.ts` | 公共布局、碰撞、移动、交互检测、双语文案 | 摄像机 pose、移动方向、dt | 新 pose / `StationId`；无网络 |
| `MarketViewport.tsx` | Three.js 几何、灯光、相机、输入和清理 | `sceneId`, `chinese`, `blocked`, `onInteract` | 仅调用 `onInteract(StationId)` |
| `MarketField.tsx` | 岗位/设备面板、任务触发、展示报告 | `game`, `blocked`, `onMap`, `onTablet` | 既有 `/tasks` 命令；现有证据组件 |
| `GameView.tsx` | 三关地图/现场切换、顶层模态与动作 | `Game` | E1/E2/E3 挂载现场；换关保留 onFoot，重建场景 |
| `campaignField.ts` | 公开章节布局、文案、角色主题 | `SceneId`, `chinese` | `FieldLayout`、copy、主题 ID；无分支/事实 |
| `marketArt.ts` | 公共 GLB 加载、释放、失败回退 | renderer、URL、成功/失败回调 | 同源资产请求；不请求业务数据 |
| `chapterPresentation.ts` | 已完成路线反馈、接收站故事 | 公开 `OperationView` / `OutcomeView` | 双语呈现；不计算规则结果 |
| `ArrivalScene.tsx` / `ArrivalViewport.tsx` | N07 结局层与静态三维接收站 | 结局投影 / 仅语言 | 只读，资源失败保留复盘 |
| `IntelPanel.tsx` | 原情报 UI | `game`, `active` | 导出同一个 `ReportCard` 供现场复用 |
| `market-field.css` | 现场 HUD、响应式布局 | CSS 类 | 无业务状态 |

Three.js 模块不能 import `campaign-reference.json`、`World`、服务端代码或完整 session 类型。`MarketField` 允许读取公开 `SessionProjection`；`MarketViewport` 根本没有接收它的参数。

```ts
type StationId = "noah" | "samira" | "recon" | "command";
type FieldPoint = { x: number; z: number };
type FieldPose = FieldPoint & { yaw: number; pitch: number };
type FieldBox = FieldPoint & { width: number; depth: number };

type MarketViewportProps = {
  sceneId?: "E1" | "E2" | "E3"; // 缺省 E2；业务容器总是传当前章节
  chinese: boolean;
  blocked: boolean;
  onInteract(station: StationId): void;
};
```

站点 ID 是 UI 路由，不能作为世界证据 ID；点进站点本身不产生任务或上报。

## 2. 状态与输入

### 2.1 生命周期

`GameView.onFoot` 默认 false；本地预览 URL 的 `field=1` 仅改变初始展示。E1/E2/E3 的入口可切换 true。换关保留 onFoot，以 `sessionId:runEpoch:sceneId` 为 key 重建现场，使相机、调查弹窗和站点状态归零。主桥拒绝不换关，因此视角保持。父组件继续保有会话，现场卸载不会创建新会话。

`MarketField` 状态：`station`, `investigation`, `reportId`, `submitting`。一次只展示站点模态或调查确认。调查结束后回到侦察站点并展开返回的 reportId。关闭模态不取消已经服务端接受的任务；其结果仍保留在情报档案。

`blocked = drawer || decision || missionMenu || context || exit || story`，再叠加 `phase !== scene` 和内部站点/调查模态。blocked 时清空移动键并退出当前 canvas 的 pointer lock。

### 2.2 移动算法

- 左右/前后输入先按向量长度归一，斜向速度不超过直行。
- 摄像机以 YXZ 顺序旋转，pitch 限制在 ±0.85 rad；眼高 1.68 m。
- 每帧有效 dt 上限 0.05 秒；3.2 m/s。页面恢复时不会跳过整个街区。
- 玩家圆形范围以半径 0.32 m 的 AABB 扩张近似；先测试 X，再测试 Z，实现沿墙滑动。
- 可活动区域从 `FieldLayout.bounds` 获取，再收缩玩家半径：E2 x ∈ [-10,10]、z ∈ [-15,15]；E1/E3 x ∈ [-8,8]、z ∈ [-10,13]。
- 步长上限 0.16 m，小于本布局最薄的可碰撞道具尺度。未来提高速度或引入薄门板时必须换 swept collision，不能无条件复用这个假设。

### 2.3 交互算法

对四个站点：距离小于 3 m；大于 0.7 m 时与视线水平夹角不超过约 60°；沿线每约 0.15 m 检查碰撞，末端保留 0.5 m 作为目标本体。取最近满足条件者。M1 目标固定、地面平整；这不是 Unity 物理射线系统。

键盘仅当 canvas 聚焦或被锁鼠标时生效，输入框内打字不会走动。未锁鼠标时 Q/E 转向、Enter 交互；锁鼠标后 E 交互，鼠标负责转向。点击锁鼠标失败时保留拖动转向。辅助方向按钮使用 pointer capture，并在 up/cancel/lost capture/blur 时清键。

## 3. HTTP 契约：复用而非另建一套

完整定义仍以 [`public.types.ts`](../engineering_v0.5/contracts/public.types.ts)、[`openapi.json`](../engineering_v0.5/api/openapi.json) 和运行时 Schema 为准。以下给出本功能实际用到的 payload。

基础路径：`/api/v1/sessions/{sessionId}`。`game.command` 根据最新 state 包装 `expectedStateVersion`、`expectedSceneId`；`post` 添加 `Idempotency-Key`、`X-Run-Epoch`、`Accept-Language`，使用同源凭据。发生传输级失败时重发相同键和相同字节，不自动把失败业务命令变成新命令。

```json
{
  "expectedStateVersion": 42,
  "expectedSceneId": "E2",
  "payload": { "taskKind": "request_report", "targetRole": "analyst", "topicId": "cause" }
}
```

| UI 意图 | HTTP | Payload / 响应 |
| --- | --- | --- |
| Noah 简报 | `POST /tasks` | `taskKind: request_report`, `targetRole: analyst`, `topicId` 取下方章节矩阵 |
| Samira 简报 | `POST /tasks` | 同上，`targetRole: liaison` |
| 确认调查 | `POST /tasks` | `investigate_and_report`；见下方；`TaskAccepted` |
| 上传一份报告 | `POST /uploads` | `items: [{reportId, expectedRevision}]`；`UploadView` |
| 自由提问 | `POST /questions` | `questionKind: free_text`, `text`, `expectedInboxVersion`, `uploadBatch: []` |
| 路线确认 | `POST /actions` | `actionId`, `waitDurationMs`, `reason`, `reasonAnnotation`, `basedOnAdviceJobId`, `referencedReportIds`, `cancelPendingInvestigations` |
| 展示回执 | `POST /display-receipts` | **非命令 envelope**，使用 observed 版本；见下方 |

调查 payload 从当前 `taskOptions` 读取，不根据场景名称拼接私有目标：

```ts
{
  taskKind: "investigate_and_report",
  targetRole: option.targetRole,
  topicId: option.topicId,
  targetId: option.targetId,
  investigationKind: option.investigationKind,
  sourceReportId: option.investigationKind === "provenance_trace" ? selectedReportId : null,
  reasonAnnotation: null // 或既有 ReasonAnnotation；不另创字段
}
```

`TaskAccepted.task` 若 status=completed 且 reportId 非空，展开对应报告。若将来读取旧 realtime 会话得到未完成任务，应通过原投影/情报档案接收；本次未承诺 realtime 的专用现场交付动画。

回执由原 `useVisibleReceipt` 和 `game.receipt` 发送，内容至少连续可见 550 ms、可见比例达到既有阈值后才发送。receipt 是展示证据，不是“已理解”的证明：

```ts
{
  observedStateVersion: s.stateVersion,
  observedSceneId: s.sceneId,
  payload: {
    displayKind: "report_opened",
    reportId, jobId: null, operationId: null
  }
}
```

不存在 `POST /walk`、`/field-evidence` 或 `unlockTruth`。不要把未来设计当作可调用接口。

## 4. 数据库与事务

**Schema 变更：无。迁移文件：无。数据回填：无。** 前端局部状态不写 PostgreSQL，不添加 pose 字段到 session 权威投影。

| 数据 | 既有表 | 本功能如何使用 |
| --- | --- | --- |
| 会话/场景 | `sessions`, `session_scenes` | E1/E2/E3 访问资格和权威版本 |
| 幂等命令 | `commands` | 同一请求重复发送不重复扣额 |
| 额度 | `quota_accounts`, `quota_ledger` | 每岗位报告和全局渠道成本 |
| 调查/报告 | `task_requests`, `investigations`, `evidence_instances`, `reports` | 站点触发的仍是同一报告体系 |
| 上传 | `uploads` | 保留 evidenceInstanceId、revision 和快照哈希 |
| 顾问输入 | `input_manifests`, `input_manifest_members`, `player_statements` | 冻结白名单资料，不取全部 reports |
| 模型作业 | `agent_jobs`, `agent_attempts` | 延迟、失败、超时和成本计数 |
| 展示和行动 | `display_receipts`, `decision_snapshots`, `operations`, `events` | 评估当时信息集，不记录行走路线 |
| 终局/评估 | `terminal_seals`, `behavior_facts`, `evaluation_reports` | 独立行为评估流程 |

任务校验、扣额、证据实例、报告和状态版本保持原事务边界；现场不会先改 UI 余额后等待数据库。唯一键、外键、CHECK、索引和 SQLite/PostgreSQL 适配沿用现有迁移。原始 DDL 见 `engineering_v0.5/database/001_initial.sql`，运行时补充见 `server/core/store.ts`，云端迁移见 `server/core/` 当前实现。

重复展开同一报告可以来自不同视图，但服务端按既有回执绑定去重。不会因为先在现场、后在侧栏查看而新增一份证据。

## 5. Agent 的具体接入

M1 不创建第三个 Agent，也不把玩家的屏幕截图或 3D 节点名发送给模型。

1. 上传后，现有核心生成 `AdvisorInput`：publicTask、backgrounds、已上传 evidence、最近的未核实玩家 statements 和 question。
2. `buildAdvisorInput` 显式重建白名单、计算 inputHash 并校验 Schema。`priorAnalysis` 保持当前 null 策略，不能接入共享全知对话缓存。
3. 现有网关使用 `.env` / 服务端环境指定的 OpenAI 或 Anthropic。密钥、模型名与接口地址不在新组件中出现。
4. 返回结构经过 JSON Schema、引用与语义范围校验；结果投影给原 `AdvisorPanel`。offline/fallback 状态沿用原明确标识，不伪装成真实模型分析。
5. 封存后构建独立 `EvaluatorInput`，输入行为事实、机会、反证与覆盖限制。三维行走轨迹既未收集，也不能作为“过度谨慎”依据。

新增端到端测试包裹真实 offline Agent gateway，记录实际 `AdvisorInput`，断言它仅包含主动上传的侦察报告；同场已经收到但未上传的岗位简报不在 evidence 中。这验证的是边界和流程，不是真实供应商质量。

## 6. 错误、并发与清理

| 情况 | 当前行为 | 规则状态 |
| --- | --- | --- |
| WebGL 不可用 / context lost | 显示备用提示，保留地点按钮 | 预算、任务正常使用同一 API |
| 锁鼠标被拒绝 | 拖动转向或按键/地点访问仍可用 | 无任务 |
| 同一简报快速连点 | `inFlight` ref + busy 禁止并发提交 | 服务端仍作最终校验 |
| 额度耗尽 | 禁用相关按钮；剩余额度取投影 | 不允许用快捷地点绕过 |
| 调查确认取消 | 回到工作台 | 未发送任务、不扣额 |
| 网络/版本冲突 | 原 command 错误留在确认/站点；刷新状态后重试 | 不乐观扣额、不发新隐藏动作 |
| 旧场景已离开 | 卸载站点，服务端 expectedScene 校验兜底 | 新场景接管 |
| 模型失败 | 原作业失败/降级展示，可自行行动 | 不锁住路线 |
| 页面失焦/后台 | 清空按键，后台跳过 render | 剧情时间不因镜头运行而增加 |
| 卸载现场 | 取消 RAF/ResizeObserver、全部监听器；销毁几何、材质、纹理、shadow map、renderer/context | 会话留在父层 |

渲染循环使用 ref 读取最新 blocked/回调，避免每次 SSE 更新都重新创建 Three.js 场景。DPR 上限 1.5；WebGL 仅在首次进入时异步导入，默认 2D 用户不为此初始化场景。

## 7. 三关与尾声的具体契约

```ts
type FieldLayout = {
  spawn: FieldPose;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  stations: ReadonlyArray<FieldPoint & { id: StationId }>;
  colliders: readonly FieldBox[];
};
```

实际类型以 `marketField.ts` 为准。移动与交互函数接受可选 layout，默认市集以兼容旧调用；站点坐标和碰撞只影响本地可达性。

| 章节 | analyst / Noah 主题 | liaison / Samira 主题 | 环境资产 |
| --- | --- | --- | --- |
| E1 | roads, gate_status | manifest, gate_status | `/assets/fields/gate-v1.glb` |
| E2 | roads, cause | roads, cause | `/assets/market/market-sample-v1.glb` |
| E3 | roads, bridge_status | manifest, ford_status | `/assets/fields/bridge-v1.glb` |

主题矩阵通过单元测试与两种剧本逐项核对。调查选项仍取公开 `taskOptions`，不由这个矩阵生成。E3 指挥站读取 `pendingTasks` 与 `medical.note`；读取不结算任务。

`chapterReceipt` 忽略未完成动作与 wait。仅当完成的 `E3_BRIDGE` 回执仍在 N05，才显示通行未获批准。不能根据按钮被点击或前端已知 actionId 提前预测拒绝。

`arrivalStory` 在 `finalLocation.nodeId !== N07` 返回 null。`terminationReason === awaiting_transfer` 或任一手续 pending 时使用待交接文案；不得只凭 `taskSuccess` 宣称手续完成。名单/查验状态为 `pending | completed | notRequired`，医疗状态沿用 `OutcomeView`。不写回 `handoffCompletedAtMissionMs`，不修改封存结局。

`ArrivalViewport` 只接收语言；加载 `/assets/fields/reception-v1.glb`。资源完成、ResizeObserver 回调时绘制，不启动永久 RAF。卸载中止加载、释放 GPU 和 ImageBitmap。场景失败仅替换画面提示，不阻塞既有 Evaluator、时间线或导出。

## 8. M2 的接口工作项：尚未实现

下一阶段不得在前端放一张完整线索表就算“调查系统”。需要先完成以下契约及测试：

- `ScenePublicProjection`：版本化的已解锁交互物、允许动作和可见表现；不含隐藏条件表达式或未解锁全文。
- `ObserveObject` 命令：objectId、contentVersion、expected state/scene、幂等键；服务端校验发现条件、成本与报告上限。不能信任客户端“我已靠近”的布尔值。
- `ObservationReport`：公开观察与推断分离、来源/时间/范围、修订、引用绑定；确定它属于哪一个岗位额度后再落库。
- `PresentationEvent`：只引用已提交的 operationId/eventId；确认看过动画仅写回执；跳过/重播不能重执行 action。
- Unity bridge 新 schemaVersion：只接受白名单交互意图，绑定 instance/session/runEpoch/viewSequence；拒绝旧实例、未知目标和前端指定后果。
- SaveEnvelope：规则与内容版本、状态及哈希、已提交动作和待处理作业；恢复不重新消耗模型预算。

这些契约受“离线主线”选择和新增现场观察预算影响。目前没有伪造 SQL/API 文件宣称已完成。应在 M2 开始前针对确定的玩法形成完整 Schema、OpenAPI、DDL 与迁移测试。
