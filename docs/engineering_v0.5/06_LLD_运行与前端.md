# LAST MILE LLD：运行时、世界引擎与前端 v0.5

本章定义数据库/API/Agent以外的实现细节。类型名称以 [public.schema.json](contracts/public.schema.json)、[internal.schema.json](contracts/internal.schema.json) 和生成TS为准；本文的伪代码用于规定执行顺序，不声称已经实现完整服务器。

## 1. 模块目录和可替换端口

```text
apps/server/src/
  bootstrap/           配置、迁移、内容校验、恢复
  http/                OpenAPI校验、鉴权、路由、SSE
  sessions/            SessionCoordinator、CommandHandler
  world/               纯规则、ActionPlanResolver、ObservationResolver
  investigations/      Broker、NpcRoleController、Inventory
  evidence/            ReportingService、UploadService、ProvenanceProjection
  projections/         CommanderProjector、AdvisorProjector、ReplayProjector
  scheduler/           DueEventQueue、Clock、JobDispatcher
  persistence/         SQL事务和查询；只有此层导入sqlite驱动
  agents/              Adapter、Advisor/EvaluatorOrchestrator、FactBuilder
  exports/             ReplayPackageWriter
apps/web/src/
  api/                 生成client、fetchSse、problem映射
  session/             store、reconcile、clockInterpolation、commandQueue
  map/                 ThreeMap、SvgMap、VehicleView、routeGeometry
  screens/             Briefing、Commander、Outcome
  components/          HUD、报告、来源图、AI、行动、任务抽屉
packages/contracts/    从本包Schema复制/生成；不手写第二份业务DTO
content/private/       campaign、已签定policy、注册表；不能打入web
assets/public/         map、GLB、二维图、字体、音频、素材来源清单
```

正式端口使用 `WorldEnginePort.advance()/commitAction()`、`InvestigationBrokerPort.complete()`、`ProjectionServicePort.commander()`、`AdvisorContextBuilderPort.build()` 和 `ModelAdapterPort.generateStructured()`。Clock、锁和事务为实现内部依赖；`resolveAction/observe` 是World内部纯函数，不是另一套公开端口。端口输入是对应Schema类型；依赖注入使Clock和Model可在测试中替换。完整内部端口以 [contracts](contracts/) 下TS为准。

## 2. 会话状态机

### 2.1 存储状态与界面状态

| lifecycle | phase | UI含义 | 允许游戏写入 |
|---|---|---|---|
| briefing | briefing | 简报、尚未计时 | start/abandon |
| running | travelling | 路径行进 | display receipt；不收新场景命令 |
| running | decision | 决策现场 | task/upload/question/action/receipt |
| running | coordinating | 路线行动已选，执行办理/等候步骤 | receipt；路线已不可再选 |
| running | resolving | 同事务中的状态结算 | 不作为可操作持久等待页面 |
| completed/abandoned/interrupted | terminal | 终局只读 | evaluation/export；不再gameplay |

WAIT不是一个新scene，不将phase改成travelling；保持decision并存在`operationKind=wait,status=running`。task/upload/question可继续，新的actions因已有active operation拒绝。WAIT到期完成operation，同幕仍可决定；不会为“等待完成”创建新一套额度。

DB状态通过显式适配器映射到公开状态：lifecycle briefing→created，running→active，completed/abandoned/interrupted→sealed；phase briefing→briefing，decision→scene，coordinating/travelling/resolving→resolving，terminal→terminal。转场细节由activeOperation/currentLocation表达，不直接cast数据库枚举。不能加入未在Schema定义的前端自创“paused”状态；网络断连只是UI连接状态。

### 2.2 进入、离开与回到E3

进入新scene事务：创建scene配额账户（若不存在）、实例化本岗位预置私有证据、更新sceneId与location、清空本幕模型活动上下文并建manifest、追加SceneEntered和公开视图事件。

离场：把本幕running调查/任务置cancelled，释放尚未消费的报告预留；不退还游戏层已花渠道次数；旧报告、已上传与模型manifest只读归档；取消尚在queued/running的Advisor job，成功历史建议只读标旧，不再作为当前建议。新scene额度只是创建新账户，不修改旧账本。

主桥拒绝：E3_BRIDGE执行20秒hold后`bridgeRefused=true`、operation完成，仍为E3、同一scene账户，不能再执行BRIDGE；只可FORD或WAIT。没有新的SceneEntered，没有初始额度/预置报告重复生成。拒绝结果使已公开合法动作集合变化：同事务增加assistantContextVersion、取消/标旧旧Advisor任务、保留本幕上传卡重新建manifest并触发分析；不得沿用仍推荐BRIDGE的旧context作为当前建议。FORD只能提交一次，提交即离开E3；600秒前未能抵达则逾期。

## 3. 命令处理算法与并发

### 3.1 HTTP命令主流程

```typescript
async function execute(command: ValidatedCommand, auth: LaunchBinding) {
  assertAuthorized(auth, command.sessionId); // 缓存读取前仍鉴权
  return sessionLock.withSession(command.sessionId, async () => {
    const canonicalHash = hashCanonicalRequest(command);
    const old = store.findCommand(command.sessionId, command.idempotencyKey);
    if (old) {
      if (old.requestHash !== canonicalHash) throw conflict('IDEMPOTENCY_KEY_REUSED');
      return old.response;  // 不再扣费；不受当前版本变化影响
    }
    await catchUpAndCommit(command.sessionId, clock.monotonicMs());
    // catch-up单独提交；下面reject不能撤销已经到期的调查或截止
    return uow.run('IMMEDIATE', tx => {
      const current = tx.loadSession(command.sessionId);
      assertEpoch(current, command.runEpoch);
      assertLiveAllowed(current, command.kind);
      assertExpectedVersionAndScene(current, command);
      const result = dispatchTypedHandler(tx, current, command);
      tx.appendEvents(result.domainEvents);
      tx.applyProjectionAndIncrementVersion(result);
      tx.enqueueDurableJobs(result.jobs); // 这里只存记录
      tx.insertCachedCommandResponse(command, canonicalHash, result.response);
      return result.response;
    });
  });
}
// 后台worker只在事务提交后调用网络；提交失败不会发起模型调用。
```

这段伪代码中的错误名是语义名；HTTP具体code以API Schema为准，路由适配器不得凭空增加未声明的error枚举。

### 3.2 幂等与版本

- create以`launchId+Idempotency-Key`去重；其余以`sessionId+Idempotency-Key`去重。
- 规范化hash覆盖HTTP方法、资源路径、body和runEpoch；不覆盖易变的requestId/时间戳。采用递归键排序的JSON编码，数字只允许Schema整数范围，不允许NaN/Infinity。
- 只记录已提交的成功响应。鉴权、结构错误、余额不足、版本冲突不创建成功command；用户改变body必须生成新key。
- 命令事务更新stateVersion一次；同一事务多个内部事件共享新version并有不同seq。scheduler有效提交同样递增。
- 时间插值、heartbeat与SSE连接不增加stateVersion。display receipt使用observedStateVersion/observedSceneId记录所看版本，不提升stateVersion，不做当前版本CAS；只允许本局已公开且可访问记录。
- 客户端同一时刻只发送一个修改会话状态的命令。显示回执与封存后job请求走独立队列，禁止为了“重试更快”自动覆盖expectedVersion。

### 3.3 竞争用例

| 同时发生 | 规则 |
|---|---|
| 两次调查争最后1次渠道 | session锁顺序处理，第一扣费；第二新状态下422或旧版本409 |
| 用户选择路线与调查到期 | 先catch-up到命令接收时刻；若调查已到期先完成，未到期随离场取消 |
| 截止与行动请求 | 先结算截止；新行动不再接受 |
| 旧模型结果与新上传 | 上传先提交则旧结果superseded；结果先发布则新上传把它标旧 |
| 相同按键网络重发 | 原结果返回；不重新执行catch-up作为该命令的一部分 |
| 一次批量上传中有无权报告 | 整体拒绝，无部分扣费，无部分manifest |

### 3.4 终局后的管理事件

封存冻结gameplay events和last_event_seq。评价任务、behavior facts、导出进度写各自管理表；对应PostgameAuditEvent写diagnostic_records(category=postgame_audit)，带独立auditId和sealedHash，不带gameplay seq/missionTime，不追加到原events。管理事件与相应job/fact/export变更同事务提交；公开SSE仍通过view_events独立序号发布。不得为了发“评价完成”而改写seal的event range。

## 4. 时钟和调度

### 4.1 时间源

运行时只由服务器单调时钟推进。`startAnchorMonoMs`与`startAnchorMissionMs=0`保存在进程内；数据库保存已结算的mission_ms以及事件due_ms。浏览器clock和系统UTC仅用于显示/关联，不决定游戏后果。

前端收到clock sample后用performance.now插值倒计时：

```text
estimateMission = sample.missionTimeMs + (performance.now() - sample.receivedMonoMs)
remaining = max(0, missionDurationMs - estimateMission)
```

网络延迟会带来显示误差；每1秒sample校准、偏差>250ms直接纠正、小偏差视觉平滑。最终是否逾期只认服务器。前端到0时显示“正在确认任务结果”，不自行判负。

### 4.2 调度器排序

扫描周期100ms；命令前也catch-up。取所有`dueMs<=nowMissionMs`条目按 `(dueMs, priority, stableId)` 排序：

1. priority10：路线分段到达/办理完成，包含N07抵达；
2. priority20：调查完成/上报交付；
3. priority30：WAIT完成；
4. priority40：伤员支持状态阈值；
5. priority90：任务截止。

每批在session锁内，按scheduled dueMs而不是唤醒时刻计算。若priority10导致终局，之后条目转为取消/排除；同刻抵达优先意味着`arrivalMs<=600000`成功。priority20交付如果同刻被截止封存，可记录“已到达未显示”，不能作为玩家看见的证据。

`catchUp`处理所有因前一个事件派生且也到期的下一步骤，直到无可处理条目或终局。为防错误脚本零时循环，内容校验禁止0时长循环，单次catch-up最多256步；超过则技术封存并记录诊断，不无限循环。

### 4.3 不是双重扣时间

调查消耗的是等待真实30秒，与玩家阅读或另一岗位调查并行；没有再从倒计时额外减30。路线hold和route步骤同样经历真实时间。API中的duration是到期计划，不是立即跳转的减法。单元测试可用FakeClock快进，正式模式不可暴露快进接口。

## 5. 预写世界解释器

### 5.1 私有输入

`campaign-reference.json`通过scenario.schema、跨引用检查和路径连通检查后载入。case在create时服务器等概率选择并固定；正式API不接受caseId或随机seed。测试可在**内部WorldEngine单元fixture**注入case，不能把debugcase参数保留在公开API。

世界引擎提供两个纯操作：

```text
observe(case, sceneId, definitionId, missionMs) -> AuthoredObservation
resolveAction(case, actionId, currentFlags) -> ResolvedActionPlan
```

它们没有LLM、数据库或HTTP依赖。case只在World模块内；返回到下游时按所需投影选择字段。禁止把整个case作为“方便后续使用”的参数传给NPC或Advisor。

### 5.2 ActionPlan步进语义

| kind | 必填字段 | 持续时长 | 完成行为 |
|---|---|---|---|
| hold | nodeId,durationMs | 指定ms | 原地，推进到下一step |
| route | routeId,fromFraction,toFraction | route.durationMs×abs(to−from) | 沿弧长插值，reverse合法须bidirectional |
| conditionalHold | nodeId,flag,durationMs | plan创建时flag=true才保留 | 在实际节点办理；完成后清除该pending flag |

fraction表示route折线**累计弧长百分比**，不是waypoint数组索引。0对应fromNode，1对应toNode。相邻步骤的物理位置必须连接；允许R04 0→0.4再0.4→0形成市集返程，不瞬移。

resolve时将conditionalHold编译为具体hold，并复制immutable resolved plan；附`clearFlagOnCompletion`派生效果，不提前清除。总plan最终effects只在全部完成后应用；被截止截断的后续效果不能兑现。路线投影只公开已经发生的位置和公开的基础路线，不公开未来私有失败步骤。

### 5.3 路径、临界和后果

- 初始R00为30秒entry plan，不创建E1 action假记录。
- E1_BYPASS：N01 hold5秒→R02→R03；总130秒，完成后manifestPending=true。
- E2_MAIN A：N02 hold25→R04 0到0.4（20秒）→返回（20秒）→N02 hold35→R03 reverse50→R05 95；总245秒。
- E3_BRIDGE B：N05 hold20秒→同E3拒绝，bridgeRefused=true。不是尝试过桥然后瞬移回来。
- E3_FORD：R08 70→R09 70→N10条件办理20/25→R10 60。只有真实完成补录步骤才能清待办。
- 截止发生于route中间：保留该时刻位置fraction，标operation cancelled/mission_deadline；未抵达节点不触发节点事件。
- 伤员支持阈值是UI状态改变；不隐含死亡、健康值随机扣减或隐藏负分。

## 6. NPC、证据与溯源实现

### 6.1 request_report

玩家选择岗位和公开topic。读取该角色本幕已取得、未上报的EvidenceInstance，只匹配topic；按priority降序、acquiredMissionMs升序、definitionId词典顺序选一条。若不存在返回无匹配报告，不泄漏未解锁证据列表，也不消耗额度。

参考profile预置证据是在入场时角色已持有的简报/通信摘录。交付用reportDeliveryMs=1000的任务；先预留报告额度，到期spend并创建Report。预置卡不是免费无限上报，不能借request_report绕过3条限制。

### 6.2 investigate_and_report

验证公开TaskOption、role、scene、库存余额及报告槽；当次调查绑定一个作者definitionId/targetId。先reserve report再spend channel，同事务失败整体回滚。到期调用World.observe，仅创建这一观察，再生成新报告；不能因NPC“觉得别的更重要”换成另一个未调查事实。

每岗位任何活跃task最多1件，包含request_report的1秒交付；role_busy时不再预留或扣费。一个target在同幕重复调查允许但仍消耗渠道/报告，产生新的instance UUID；内容作者不给新情况就返回同一观察文本、新取得时刻。其信息价值是否低由公开规则判断，不能仅因为文本一样直接判玩家过度谨慎。

### 6.3 EvidenceCard实例化和Advisor映射

| 作者模板字段 | Commander EvidenceCard | Advisor专用投影 |
|---|---|---|
| definitionId | 保持公开ID，各case相同 | 只作可允许的定义引用 |
| title/body/statementKind | 原文，不由NPC改写事实 | 剥离命令含义，作为不可信数据 |
| sourceLabel/observationScope | 显示来源与观察范围 | 同范围，不能泛化 |
| observationAgeMs | observedAt=startWall+acquisitionMs−age；未知则null | 固定的observationAgeMs，不传mission时钟 |
| runtime UUID/revision | Evidence实例ID与版本 | 显式映射为允许的引用ID |
| receivedAtMissionMs | 当前实际收到时刻 | 删除 |
| validUntilMissionMs | 本参考内容null，freshness靠明确观察范围/历史标记 | 不自动发送未来截止或时钟变化 |
| hiddenRootId/privateCaseId | 禁止 | 禁止 |

卫星`observationAgeMs=600000`是图像在取得时已有10分钟年龄，调查等待仅10000ms。`initial`的观察时间未知，不伪造实时。observation/brief也不一律等于“完全核实”；画面只能证明可见范围。

### 6.4 provenance_trace

只能由liaison执行，sourceReportId必须是Commander本幕已收到且模板traceResult不为空的报告。扣模板`traceCostChannel`；预置卡channel=initial时仍明确扣localAgency或witness，不能从initial臆造免费资源。

结果：新instance、新report、statementKind=provenance、新revision且supersedesEvidenceInstanceId指向被核验实例。正文写清查到的是传播链还是内容真实性。本版trace结果均不自动将整条说法变成verified。

同时生成ProvenanceDisclosure，关联的definition只能在Commander已见实例之间渲染边。若某个相关来源未上报，可在核验正文中说传播链范围，但不能泄露该库存卡ID/正文；Advisor只有玩家上传核验报告后才能获知该关系。后续新报告进入时可以投影已被本次核验明确披露的同源关系，不需要偷偷重查私有root。

### 6.5 更正

更正使用同样新实例/新报告/新上传规则，但本参考剧情没有任意作者更正触发器。扩展内容时需作者明确触发条件与新正文；Schema已允许correction，不能让模型生成它替代世界事实。旧上传manifest永远不被更正重写。

## 7. 前端状态、请求与回放

### 7.1 Store拆分

```typescript
type UiConnection = 'connecting' | 'connected' | 'reconnecting' | 'offline';
type LocalUi = {
  selectedReportIds: string[]; questionDraft: string;
  openPanel: 'none' | 'task' | 'provenance' | 'history';
  renderMode: 'three' | 'twoD'; connection: UiConnection;
  pendingCommandKey: string | null;
};
// authority是SessionProjection；不可把隐藏world类型导入web。
```

余额、scene、actions、TaskOption availability都来自authority；前端只做可用性预提示，服务器重校。新增报告不要自动上传；UI可显示“新报告1”，玩家选择仍是学习机制的一部分。

### 7.2 提交队列

1. 校验表单，创建UUID key，冻结完整body。
2. 禁用重复提交按钮但保留阅读操作；不得提前减余额。
3. 2xx应用响应并按新stateVersion reconcile；202显示Task/Operation状态，不当成已经完成。
4. 网络未知结果用**相同key＋相同body**重试，指数延迟0.5/1/2秒，最多3次；之后提示“结果未知，正在同步”，读取会话或operation。
5. 409 VERSION：重新snapshot，保留草稿但不自动重发新版本，避免状态变了还替玩家重新做决定。
6. 422额度/能力错误：展示服务器的可读原因，不增加前端“补额度”按钮。

可选`reasonAnnotation`位于“记录我的考虑”折叠区，默认null；不填也能行动。玩家自报只是证据，不把勾选复选框直接判作真实心理动机。basedOnAdviceJobId与referencedReportIds只允许选择已显示且存在的记录；服务器验证回执。

### 7.3 SSE与快照合并

通过fetch流读取text/event-stream并带Authorization。每session/Commander view有独立cursor，禁止直接用全局私有event seq作为公开事件ID。客户端保存最后已应用cursor；重连带Last-Event-ID。

先GET snapshot获取projection+cursor，再SSE从该cursor之后读取，避免两步间漏事件。事件只传明确公开变更或要求refresh；重复cursor丢弃。发现gap/未知epoch/版本倒退时丢弃本地authority并全量snapshot。SSE注释心跳只维持连接，不写业务日志；有序clock.sample写公开view_events以支持断线重放，不进入domain events、不提升stateVersion。

若SSE消息超过界限、解析失败或Schema不符，关闭流、记录客户端诊断、重取快照。不能“尽量读懂”后把未知字段并入store。启动时检查bootstrap.contractVersion=0.5，不兼容提示刷新应用；SSE载荷不凭空添加schemaVersion字段。

### 7.4 展示回执

报告正文展开、AI建议主体或行动后果成功渲染连续500ms且页面可见后，分别记录report_opened/advice_displayed/consequence_seen；折叠卡摘要不发回执。行动成本与渠道能力完整呈现500ms后记context_displayed，三个实体引用均null，绑定observedStateVersion/SceneId对应服务端已保存的公开briefing记录；菜单有入口不算展示。去重后逐条发送，服务器校验记录确实属于该Commander公开视图。

display receipt证明程序呈现，不证明用户理解。FactBuilder须把它称为“已展示”，不能写“玩家已经理解”。请求没有客户端时间字段。只有服务器收到并记录的序号早于决定snapshot时才计入该决定；迟发回执不倒填过去知识，terminal不新写游戏展示记录。

### 7.5 复盘

ReplayDrawer按decisionSnapshot列：当时可见报告/展示过的AI输出/玩家自报理由/最终动作/实际执行结果。先看过程，另按钮展开“事后得知”。普通报告只读；不允许修改历史输入重跑后覆盖同一个评分。新一局生成新session。

## 8. Blender沙盘到游戏界面

### 8.1 资产接入

已有 `LAST_MILE_GameMap.glb` 与 `last_mile_map.json` 是运行时素材，不在浏览器打开.blend。使用GLTFLoader加载GLB，节点位置和路径取公开地图。GLB自带坐标为X右/Y上/Z南，现有position_glb和waypoints_glb已经转换，**不得再次执行(x,z,−y)**。[Three.js GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html)

原文件静态规模约13.2MB、344714三角形、1443节点，是资产统计，不是帧率保证。M5先测绘制调用与加载时间，再决定合批/实例化/纹理压缩；不要一开始重建整个Blender场景。

### 8.2 车队和路线

- 初始位置N00，车队由独立gameplay marker表示，不依赖GLB里某辆装饰车的隐藏名字。
- 路线预计算waypoint累计距离。fraction定位目标距离，二分查segment，再线性插值XYZ；方向沿segment切线，拐弯平滑仅影响渲染。
- 高度包含原作者车体pivot偏移，不重复加一次固定高度。摄像机为俯视斜角正交，约束缩放和拖拽范围，提供复位。
- route/path动画以权威progress采样+客户端插值播放；动画结束不触发WorldEngine。
- 点击节点只能查看公开说明，不会传任意destination到服务器。可行动路线由ActionOption选择。

### 8.3 二维降级

WebGL创建失败、模型加载超过8秒或连续10秒平均帧率<20时提示切换SVG二维地图；保持同一Store和API连接，不重新开局。二维使用相同node/route折线，将GLB (x,z)投到屏幕平面，并保持北向约定。UI中允许手动回3D一次，避免自动来回闪烁。

三幕场景图为普通图像背景与HTML标记，不与沙盘mesh耦合。调查卡可使用裁剪影像或文字观察；美术不必表现未验证的世界答案。

## 9. 启动、停止、恢复

启动次序：配置合法→建立数据目录→打开DB并启用FK/WAL/busy_timeout→迁移→校验全部content/schema和hash→处理遗留活跃局为interrupted→启动scheduler/worker→监听API→打开本地UI。

SIGTERM：停止接新命令，完成当前短事务，取消/封存活跃局，等待最多3秒记录worker状态，关闭DB。未能优雅退出则下次boot恢复处理；无论哪种方式都不能把远端模型未知结果标“成功”。

服务端重启后对旧running/sending provider attempt标unknown；同事务将原running job转fallback（能形成合法模板时）或failed，不能遗留活跃running行阻塞恢复。避免盲目重发并重复计费；同sealedHash/config的评价恢复必须复用原job，unknown attempt仍占原max2额度；成功job直接返回，不能新建job绕过唯一键或预算。旧launch token失效；同机恢复访问通过启动器显式 `--resume-session <id>` 选择本机既有terminal会话，校验记录后给新launch创建launch_session_access只读授权，复用原不可变commander actor_binding（不创建新的角色主体）；浏览器由启动参数获得该id，再GET原session。没有公开恢复运行或历史列表接口，不能把任意sessionId默认开放给远端。

## 10. 测试接缝和完成标准

| 模块 | Fake/fixture | 必须验证 |
|---|---|---|
| Clock/Scheduler | FakeClock、同刻事件 | 600000到达成功、600001失败、任务不双结算 |
| World | A/B固定case | 全部12个action plan、partial route、条件办理、不瞬移 |
| NPC | 固定库存、topic、优先级 | 无truth依赖、未取得不报、同topic稳定选择 |
| Coordinator | 临时SQLite、两并发命令 | 幂等、余额、catch-up不回滚、终局barrier |
| Projection | 隐藏root/case诱饵字段 | C/A/E独立白名单、同A不同W字节一致 |
| Frontend | 假API＋模拟SSE | 重连不漏/重、409草稿、键盘、2D降级 |
| End-to-end | 假ModelAdapter | 两case三幕→终局→评价→回放→导出 |

这些是实现验收要求。本包执行了其中的DDL、Schema和作者脚本参考检查；完整浏览器与服务器仍需开发后执行，结果不能预填PASS。
