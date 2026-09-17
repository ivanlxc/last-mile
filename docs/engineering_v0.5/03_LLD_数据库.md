# 03 · 数据库详细设计

**状态：工程评审稿。** 本文与可执行 SQL 一起定义持久化边界，不包含游戏服务器实现。SQLite 在本机后端私有进程使用，浏览器和两个模型均不持有数据库连接。当前单人参考方案里的 NPC 自动交付、实时 600 秒、每场景上报 3 / 上传 5、累计上传等仍属待评审产品选项；已确认的是调查资源整局共享，以及新溯源/更正另占新的上报与上传额度。

## 1. 交付物与运行入口

| 文件 | 可直接检验的内容 |
|---|---|
| [001_initial.sql](database/001_initial.sql) | 35 张 STRICT 表、复合外键、CHECK、唯一/部分索引与触发器；空库完整迁移 |
| [DATA_DICTIONARY.md](database/DATA_DICTIONARY.md) | 逐字段类型、空值、默认值、语义、键、索引、触发器；当前 328 个字段 |
| [transactions.sql](database/transactions.sql) | 8 个完整参数化事务块：任务接受/交付、上传、行动、模型请求占额、终局 |
| [queries.sql](database/queries.sql) | 幂等、到期调度、指挥官投影、AI 清单、SSE、账目核对与恢复查询 |
| [reference_seed.sql](database/fixtures/reference_seed.sql) | 两局确定性合成数据，采用当前参考 policy，模式固定 test |
| [test_database.py](verification/test_database.py) | 每测试新建内存库；执行真实 DDL、触发器和命名事务模板 |
| [database_test_results.json](verification/database_test_results.json) | 实际 SQLite 版本、迁移与 fixture 哈希、测试数、结果及验证范围 |

从交付包根目录运行 `python3 verification/test_database.py`。只用 Python 标准库，不访问模型或网络、不启动游戏，不写入用户已有数据。SQL 需要 SQLite 3.38+；交付时实际验证使用 SQLite 3.51.3。SQLite 版本较旧时启动明确拒绝，不悄悄跳过 STRICT 或 JSON 约束。

每个数据库连接初始化：

```sql
PRAGMA foreign_keys=ON;
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
PRAGMA busy_timeout=500;
```

迁移文件自带 `foreign_keys=ON` 和 `BEGIN IMMEDIATE/COMMIT`；`journal_mode` 在连接初始化且无活跃事务时设定。读连接可设置 `query_only=ON`。写操作经唯一 SQLiteStore/SessionCoordinator；WAL 允许并发读取，但 SQLite 仍只有一个写事务，模型网络请求不得持锁。

## 2. 数据域、拥有者与读取规则

| 域 | 主表 | 唯一写入边界 | 允许读取者 |
|---|---|---|---|
| W：私有世界与规则 | content_versions、policy_profiles、sessions.world_state_json | ContentRegistry / WorldEngine | WorldEngine、Scheduler；不直接暴露 API 或模型 |
| I：岗位已获得信息 | evidence_instances、provenance_disclosures、investigations | InvestigationBroker、RoleInventory | 对应 NPC 岗位；指挥官没有原始库存接口 |
| C：指挥官已收到 | reports、public_records、display_receipts | ReportingService、ProjectionService | 指挥官 UI、其行为截面构建器 |
| A：AI 获准输入 | uploads、input_manifests、成员表、player_statements | UploadService / Advisor 输入构建器 | AdvisorOrchestrator 只读冻结输入 |
| 过程与额度 | tasks、operations、quota_*、events、commands | SessionCoordinator 同事务写 | 相应投影；私有日志不原封公开 |
| 封存与独立评价 | terminal_seals、decision_snapshots、behavior_facts、evaluation_reports | Seal / FactBuilder / EvaluatorOrchestrator | OutcomeRenderer 读 Outcome；Evaluator 只读事实投影 |
| 技术执行与历史访问 | launches、launch_session_access、agent_jobs/attempts、export_jobs、diagnostic_records | 相应技术服务 | 本机授权接口、脱敏诊断 |

SQLite 无内建行级角色权限，本设计不把触发器当成数据库账号隔离。防泄露依赖私有进程边界、明确服务端口和白名单 DTO；SQL 的同局外键提供第二道结构性防线。模型不得调用通用 SQL、任意文件、库存列表或隐藏规则工具。

### 2.1 关系主链

```text
launch → session → actor_binding
                 ├─ quota_account ← quota_ledger
                 ├─ task → investigation → evidence(instance,revision)
                 │                           └─ report → upload
                 │                                       └─ input_manifest → advisor job → attempts
                 ├─ events → public_records → display_receipts
                 │         └─ decision_snapshots
                 └─ terminal_seal → behavior_facts → evaluator job → evaluation_reports
                                  └─ export_jobs
new launch → launch_session_access → original commander binding（历史只读，不续局）
```

所有局内实体引用都携带 `session_id`。例如 upload 引用 `(session_id,report_id,report_revision)`；从另一局拿到合法 UUID 也不能通过外键或报告接收检查。内容及 policy 是全局不可变版本，session 创建时固定哈希；运行中不能切换私有 case、规则版本或 runEpoch。`content_versions.content_version_id` 是内容注册时由后端生成的全局不透明 UUID，NOT NULL 且 UNIQUE；`content_hash` 仍是内部主键及 sessions/seal 的外键。公共 `SessionProjection.contentVersionId`、`WorldSnapshot.contentVersionId` 和内部 `ContentRegistryPort` 使用这个 UUID：投影按 session 的 content_hash JOIN 注册表取 UUID，内部 Registry 按 UUID 解析私有内容版本。禁止用未声明的 registry_json 字段、哈希或哈希截断串代替 UUID；旧映射随内容版本一起不可修改。

### 2.2 原角色身份与新启动授权不同

`actor_bindings` 描述当局行为主体，局内每个角色唯一且不可变。重启后历史查看使用新的 launch 和 `launch_session_access`，指向原 commander binding。可授 `commander.read`，并按启动器权限授 `evaluation.request` / `export.request`；不能给旧 terminal 局重新授 `commander.command`。访问授权不是新的游戏行为，因此不修改 seal、状态版本或原角色身份。无公开“恢复运行”端点。

授权查询必须同时检查：当前 token 属于尚有效的 launch；grant 的 session 与路径一致；绑定角色正确；endpoint 所需 capability 存在；gameplay 还要求原 launch、同 runEpoch、非 terminal。SQL grant 插入检查角色、原 launch 与 terminal 条件；后续请求仍必须重复验证，不因为历史上存在 command grant 就继续允许终局写入。

## 3. 不变量与执行位置

| 不变量 | 数据库保证 | 应用还必须保证 |
|---|---|---|
| 不串局 | 所有局内复合 FK；报告/上传/行为主体额外 trigger | 路径 session、token、capability 一致；每次查询携带 session |
| 不重扣 | command 唯一幂等键、ledger 唯一因果组、父金额上限 | 先查原成功回执再校验旧版本；同键异摘要返回 409 |
| 余额非负 | available/reserved/spent CHECK；合计 capacity；合法 delta；禁止直接改余额 | 原因码授权；技术补偿不能由玩家请求伪造 |
| 每岗一个任务 | active task 部分唯一索引；调查另有 active role 索引 | 当前 phase 允许、NPC 选项/公共目标有效 |
| 调查完成才获知 | 有调查来源时要求已 completed 且 acquired≥due | NULL 调查来源只能用于作者明确预置资料；不能用 NULL 绕过观察 |
| 原信息不可改 | evidence/report/upload/manifest/事件/快照 immutable triggers | 更正另生成新版本及新额度；正确关联旧证据 |
| AI 只收已上传 | manifest 成员 FK 指向 uploads；同场景、最多 5、完成后封口 | permitted_input_json 与成员一一对应、允许字段 schema、文本来源语义不泄漏 |
| 一个当前 Advisor | 单局 queued/running 部分唯一索引；输入绑定不可改 | 已成功历史结果用 current 投影判断，不修改成 superseded |
| 调用有界 | 单 job ≤2 attempts、单局 Advisor ≤30 sending；顺序与终态不可改 | 服务商超时/格式错误/恢复共用预算，不能创建新 job 规避 |
| 终局不改世界 | reciprocal deferred seal FK；无活跃工作/预留额才可 seal；终局写屏障 | WorldEngine 判定终止条件、规范化 seal 哈希、严格同步封存 |
| 评价无后见之明 | facts 引用封存与原截面，cutoff 必须匹配 | FactBuilder 只使用当时合法信息；EvaluatorInput 不含 Outcome/隐藏真相 |
| JSON 有效 | `json_valid`、object/array 顶层类型 | JSON Schema 2020-12、完整联合类型、枚举语义、UUID 格式、字数/引用守卫 |

SQL 层的 UUID 多数为长度检查，哈希多数为长度检查；字段合法外观不能证明权限或内容正确。规范序列化固定 UTF-8、递归键序、无多余空白、数组保序、拒绝非有限数，整型不超 JS 安全整数；内容/输入/配置/快照/seal 的 SHA-256 都由对应构建器计算。不要把 hash 当成数字或采用未固定顺序的 JSON stringify。

## 4. 时间、版本与原子提交

### 4.1 一次命令的精确顺序

1. 本机 HTTP 边界验证 token、origin、body/schema，解析实际 actor binding。进入该 session 的串行互斥锁。
2. 查 `commands(session_id,request_id)`。同 command hash 返回保存的成功 HTTP 状态与 JSON；不同 hash 返回 `IDEMPOTENCY_KEY_REUSED`。该检查在 expectedStateVersion 判断前。
3. 用服务器单调钟计算本局当前任务时刻。`missionNow = persistedMission + max(0,monotonicNow-anchor)`；同一时间既不能按墙钟累计又额外加行动 authored duration。
4. Scheduler 按运行时规定顺序处理截至该时刻的到期调查、报告交付、路线阶段、期限。**独立事务提交**系统变化与公共投影；COMMIT 后才处理新玩家命令。
5. 重新取本局 state/scene/version 与最新额度；检查 gameplay phase、expected version/scene、runEpoch、世界前提。不满足时返回错误，已经提交的到期事件不会回滚。
6. `BEGIN IMMEDIATE`。再确认版本与前提；同事务追加 ledger、实体、事件、视图事件、决策截面、允许输入 manifest、待执行 job、状态版本及成功 command receipt。
7. COMMIT 成功后才发送 HTTP/SSE 和唤醒模型 worker。任何语句/COMMIT 失败，整笔新命令 ROLLBACK；不局部补交余额或回执。

`state_version` 每次有意义变化仅加 1。单命令批量上传两张卡产生两条 `upload.created` 事件，但状态、inbox、assistantContext 各加一次。内部 seq 随事件递增；同一提交多个事件共享新 stateVersion。时间流逝的前端动画不逐帧写库。

显示回执使用 API 的 `observedStateVersion/observedSceneId`，不会提升 stateVersion；它由服务器接收时刻及入库 seq 排序。应用验证观察版本不在未来、记录确实已对该角色可见；其他状态变化不使回执自动失效。迟到的回执不能回填到已做出的决策截面，terminal 后不接受新的行为回执。

### 4.2 采样时刻与到期时刻不能混用

命名 SQL 模板中的 `:mission_ms` 和 `:anchor_ms` 必须表示**同一个逻辑时点**。批量补到期事件时，可将锚点推进到该到期时刻在原单调钟轴上的位置，再继续补算剩余经过时间；不能把“30 秒到期的效果”配上“35 秒才收到请求时的单调钟锚点”，否则会丢掉 5 秒。

在实时参考方案中，调查 30 秒表示 `due=accepted+30000`；它与另一个岗位的 20 秒调查共享一条时钟，不是 50 秒。WAIT 也只建立到期等待作业；不先加等待时长再让钟继续跑。由于进程单调钟重启后不可比较，本版重启活跃局走 interrupted 技术封存，不按设备时间猜测离线时长。

### 4.3 幂等键与冲突处理

| 情形 | 结果 |
|---|---|
| 成功提交后 HTTP 响应丢失 | 重试同键/同内容返回原回执，不重复扣费/派任务 |
| 同键，改 body/endpoint/role/runEpoch | 409 `IDEMPOTENCY_KEY_REUSED` |
| 未命中回执，expectedStateVersion 过期 | 409 状态冲突；无新命令写入 |
| 额度/选项无效 | 422 领域错误；先前到期提交保留 |
| 数据库忙 | 在总等待预算 ≤500ms 内返回可重试技术错误；客户端保留原键 |
| COMMIT 成功与否不确定 | 新连接查同键 receipt；有则重放，无则按完整流程再次处理，绝不手动再扣一次 |
| 创建 session 响应丢失 | `(launch_id,request_id)` creation receipt 命中原 session；不能以 `(session,key)` 代替创建幂等 |

拒绝响应不落 `commands`，允许相同语义请求在新状态以**新键**重新提出；客户端不得自动用新键重发未知结果的旧命令。不同局可以使用相同 request UUID，因为作用域隔离。

## 5. 额度账本及任务交易

### 5.1 账户初始化

每局创建四个 session 范围渠道账户：analyst.satellite=2、analyst.drone=3、liaison.localAgency=3、liaison.witness=2。每场景再按已选 policy 建 analyst.report、liaison.report、commander.upload；初值 `(available,reserved,spent)=(capacity,0,0)`。`quota_scope`、resource、role、capacity 一旦创建不可改；不能到 E2 再建一个 drone 账户，唯一索引会拒绝。policy JSON 中读取的键为 `reportLimitPerRolePerScene` 和 `uploadLimitPerScene`。

| 入账 | available | reserved | spent | 父记录 |
|---|---:|---:|---:|---|
| reserve(n) | −n | +n | 0 | 无 |
| spend available(n) | −n | 0 | +n | 无 |
| spend reserved(n) | 0 | −n | +n | 原 reserve |
| release(n) | +n | −n | 0 | 原 reserve |
| refund(n) | +n | 0 | −n | 原 spend |

每条 ledger 检查 `account_version_before` 与余额，再触发更新账户。对同一父 reserve 的 spend+release 总量不能超过原金额；同一 spend 退款总量也不能超过实际花费。额度不足或重复源引用使整事务失败。运营修正也只能追加带明确原因的补偿账目，不能 UPDATE 原账或直接改账户。

### 5.2 investigate_and_report

`accept_investigation`：在当前 phase/版本下预留 1 格 report，再花费 1 次具体渠道，创建 running task 和 running investigation，写 `task.accepted`、公开任务状态、选择截面与 202 回执。每个任务的预留行和每次调查的渠道扣费行唯一，不可复用。`targetRole` 是岗位目标，实际发起者仍是 commander。

`complete_investigation`：到期事务确认仍 running、场景仍当前；先标观察 completed，再创建该实际世界分支的 evidence，消费原 report reservation，把公共卡片逐字复制为 report，task 完成，写 NPC 上报事件及 commander 可见记录。原卡片 hash 和 JSON 必须相同。模板不运行模型、不让 NPC 从隐藏真假收益中选“最优”卡。

### 5.3 request_report

`accept_report_request` 只预留报告额度，无渠道消费；`accepted_mission_ms/due_mission_ms` 支持参考 policy 的 1 秒交付。它占同一个岗位活跃槽，因此不会与该岗位调查或第二次 report request 抢相同私有库存。`complete_report_request` 在到期后按 NPC 公共议题规则选择已获得证据，再消费预留并生成报告。SQL 不能证明某句文本属于正确公开 topic；NpcRoleController 根据 authored metadata 确定候选并记录选择规则。

同一报告来源在当前场景已上报时不会再重复生产；如果候选已不存在/不再合法，释放预留、task 标 failed 并写明确失败码。技术失败另补偿；不能为制造戏剧性随意判 NPC 拒绝。

### 5.4 行动、取消与补偿

`accept_operation` 接受服务端导出的 action 或 wait。action 离开场景前取消该场景未完成任务/调查，释放尚未使用 report reservation；渠道扣费保留。WAIT 保持任务继续运行，`release_entries_json=[]`，phase 进入 resolving。单局只允许一个活跃 operation；浏览器动画结束不会自己产生世界结算。

数据库模板 `action` 分支用于实际离场行动；若某动作的 authored 效果为“留在当前场景”，运行时必须先归类为原地作业再调用对应模板，不能仅凭按钮名字默认离场。行进计划中的路线和时间由 WorldEngine 固定在 `private_plan_json`，前端不能提交任意目的地或直接将 N08 跳到 E3。

明确技术失败的补偿顺序：同事务将调查 failed、task failed；release 原报告预留；refund 该调查真实 channel spend；追加失败及 quota 事件，提交新状态。玩家主动离开、取消或不满意信息不构成技术退款。应用验证补偿原因；SQL验证父账数量。

## 6. 上传、知识隔离与自动重算

### 6.1 一批 1–5 张卡的全有或全无

`upload_batch` 接收的是服务端规范化 refs，不接收卡片正文。先确认当前场景报告归属、版本、未曾上传、数量与剩余额度；一次 ledger spend N。随后插入 N 个 uploads，每个引用 immutable report。只要其中一个 ref 无效，整批 ROLLBACK，不出现“已扣两格只传一张”。每卡各有一条 canonical `upload.created`，API 返回批量视图；两个版本计数只加一次。

允许输入构建器只读取已授权地图/位置、获批背景包、当前场景累计 uploads 和明确纳入的未核验 statements。**missionTime、伤员/生命、资源余额、未上传报告列表、库存列表、隐藏世界根源不能自动带入。** `C−A` 的 UI “尚未上传”标记来自 commander 查询，只在 UI 显示，不能拼进 Advisor prompt。

### 6.2 为什么清单先写成员、后写父行

`input_manifest_members` 和 `manifest_statements` 对父 manifest 使用 deferred FK。同一事务中：

1. 写实际成员行；这些成员已指向存在的 uploads / player_statements。
2. 构造并 schema 校验完整允许输入、排序稳定的引用与 inputHash。
3. 插入 input_manifests 父行，SQL 检查同场景且成员数≤5。
4. 父行存在后，再追加任何成员都会触发 `MANIFEST_ALREADY_FINALIZED`；所有行不可更新删除。
5. COMMIT 时仍缺父行会因 deferred FK 整体失败。

这种顺序让模型看到的 inputHash 与一份无法偷偷追加卡片的清单绑定。JSON 里的卡片是否与 normalized members 完全一致由输入构建器做集合相等和 hash 校验；SQL 文本 JSON 校验不能替代这一点。

### 6.3 版本、旧结果与更正

旧 pending Advisor job 先标 superseded，再创建新 queued job，确保同局最多一个 logical active Advisor。job 绑定 manifest、scene、context、inputHash、configHash；worker 网络回调发布前重新检查这些条件仍是当前允许输入。历史 succeeded job 保留成功状态，只在查询投影中标为历史，不能改写成功历史为 superseded。

一条更正的例子：旧 card v1 已 report/upload，后续调查产出 v2 或一个独立 provenanceFinding。新 evidence 指向被更正版本，原 v1 完全不变；v2 必须新 report、再新 upload，两个动作分别再次占额度。Advisor 只有在新发现被明确上传后才知道它；不能因后台 root 已查清就自动给旧 prompt 增加真相。

本版 SQL 模板表达的是累计、不可替换的参考方案。若用户最终选替换式库存或其他额度语义，要先修改 policy/schema/事务/测试并重新评审，不可在运行时删旧 uploads 腾格。

## 7. Agent jobs、真实尝试与崩溃窗口

`agent_jobs` 是逻辑工作，`agent_attempts` 是实际可能产生费用的网络调用。公开 attemptCount 用 COUNT 派生，不另存易漂移计数。Advisor job 去重键为 `(session,scene,context_version,input_hash,config_hash)`；Evaluator 为 `(session,seal_hash,config_hash)`。后者输入版本为封存事实格式版本，不复用正在进行的 Advisor 上下文。

`claim_model_attempt` 在事务内将 queued→running，并插入 sending attempt；所有预算检查先发生。COMMIT 后 worker 才联网。因此：

- COMMIT 前崩溃：没有 durable sending，没发请求；可以重新领取。
- COMMIT 后、确认调用前崩溃：无法证明是否发出，恢复记 unknown，仍占这次调用；不自动退预算。
- 已返回结果、发布前崩溃：先查尝试/任务状态；只有输入和当前上下文匹配才完成发布。重复回调不会新建尝试或重复写结果。
- 已 superseded/cancelled/terminal 的返回：不发布为当前建议，记录迟到技术诊断；不修改世界或 seal。

每 job 默认 2 次尝试，首轮格式修复、网络重试和用户显式恢复共用这个上限；不能把每一类重试都各给两次。Advisor 每局最多 30 次 sending。Evaluator 每 seal/config 只有一个 job，恢复复用该行，不通过新 job 清零。mode 明确为 live_model 或 offline_template，fallback 结果必带标记。

`failed/fallback → queued` 仅为已有 job 剩余额度的显式恢复；deadline 可按新激活技术时刻重设，attempt 历史不动。发送超时的 attempt 终态 timeout/unknown 不能改成“其实成功”；迟到确认写 diagnostic_records。取消 job 不等于供应商请求一定取消，因此技术 attempt 可以在终局后补最终状态，游戏行为保持冻结。

评价的具体提示词、Guardrail、事实规则与字段见 [Agent LLD](05_LLD_Agent系统.md)。DB 仅保证绑定与不可变性，不宣称 SQLite 能判断自然语言建议是否合理。

## 8. 封存、显示证据与评价

### 8.1 Seal 是事务边界

`seal_session` 的顺序：先结算应已发生的系统效果；取消剩余 investigation/task/operation/Advisor；释放所有未兑现 reservation；追加最后的 `session.sealed` 行为事件及公开终局事件；构建 outcome 与不可变行为数据；插入 terminal_seals；同事务把 sessions 改 terminal 并绑定 seal。

两边互相 deferred FK：不能只插 seal 而忘记激活 session，也不能只把 lifecycle 改 terminal 而没有一致 seal。seal trigger 要求版本为当前+1、event seq 等于当前末尾、content/policy 相同、没有活跃工作与 reservation。缺一项就拒绝提交。

后续 evidence/report/upload/ledger/任务/公开行为记录/世界事件都禁止写入。可以继续写独立评价结果、导出作业、技术 attempts/diagnostics 和新的历史访问 grants；这些不改 terminal seq，也不重新启动实时钟。终局之后的管理/技术事件不是可继续追加的 gameplay event stream。API 定义独立 `PostgameAuditEvent` 联合，含 auditId/sessionId/sealedHash/createdAt/eventType/data，无 seq 和 missionTime；以 `diagnostic_records.category=postgame_audit` 保存完整 envelope。SQL 校验 auditId、sessionId 与已激活 seal 相符；应用校验完整联合。管理业务表和 audit 必须同事务提交，不增加原行为 last_event_seq。

### 8.2 行为截面与 Outcome 分开

`decision_snapshots` 保存当时可见信息、display receipt 截止、引用报告/AI 建议及操作理由。FactBuilder 根据这些输入生成明确规则的 facts；每条 fact 必须绑定 seal、context、主体、rule，cutoff seq/stateVersion 必须等于原截面且不超过 seal。

`displayed` 仅意味着浏览器上报成功展示，不能推断玩家阅读理解；`opened` 与 `usedInReason` 也分别记录。服务端收到回执晚于 action snapshot 时，不能把它补算成行动前已阅读。系统/NPC 的选择与玩家判断分开保留 actor，评价不能把自动上报算成玩家能力。

Outcome 单独在 terminal_seals.outcome_json，OutcomeRenderer 可读；Evaluator 的查询明确只投影 behavior_facts 和当时可见 refs，不 SELECT terminal_seals.*。`evaluation_reports` 必须与指定 Evaluator job 的 seal/config/mode/result 精确一致，报告历史不可改，重评产生新版本或按已约定 job 恢复规则处理。

## 9. 查询、索引与存储预算

关键查询均在 `queries.sql` 给出参数化形式。主键与热点索引：

| 查询 | 使用键/索引 | 设计目的 |
|---|---|---|
| 幂等命中 | commands PK(session,request)；creations PK(launch,request) | 先查成功回执，避免全量日志扫描 |
| 到期调查/交付 | ix_investigation_due、ix_task_due，均只含 active | 只扫描当前活跃作业，不扫描历史完成项 |
| 指挥官报告 | ix_reports_commander(session,scene,reported_time) | 当前场景固定排序卡片流 |
| 私有库存 | ix_evidence_inventory(session,owner,scene,acquired) | NPC 仅取得本岗位库存 |
| AI 当前工作 | active 唯一索引、输入去重索引 | 防双重当前建议和重复调用 |
| 公共 SSE | view_events PK(session,role,cursor) | 从角色范围 cursor 增量重连，隐藏内部 seq 间隙 |
| 资源对账 | ix_ledger_account / ix_ledger_parent；单局小数据 | 检查余额等于初值+所有 delta、version 等于条数 |

数据库为 hackathon 本机单局负载设计，性能目标不是已测吞吐：每局行为日志控制在数千条、一般输入/输出 JSON ≤64 KiB、单事务目标几十毫秒、写锁目标不跨网络或渲染操作。正式压测需在实现后用目标设备和实际场景执行。本包验证了到期查询使用指定索引，没有声称多用户并发、帧率或 AI 延迟已通过测试。

回放公开序列使用 view cursor，不因私有事件增多而暴露隐藏数量。内部完整回放仅团队 spoil/诊断导出可用，且不含 token/key。导出路径由服务端生成在受限目录内；API 返回 artifact JSON，不接受任意文件路径。SQL 简单相对路径 CHECK 之外，文件写入层仍须 `resolve` 后校验在固定 export root 内。

## 10. 恢复与迁移

### 10.1 启动恢复流程

1. 获取本机服务单实例锁；确认 SQLite 版本、schema user_version、迁移文件 checksum 与应用兼容性。
2. 打开 DB 并执行 `quick_check`，关键恢复点执行 `foreign_key_check`；失败则进入明确维护错误，不在坏库上继续 gameplay。
3. 新建 launch/token；原 launch 不继承明文 token，旧 UI 的 runEpoch/授权不获恢复运行资格。
4. 找到 briefing/running 局，固定其最后已持久化 mission_ms，不尝试解释旧 monotonic anchor。将 active attempts 标 unknown 并记 recovery；取消未完成岗位/行动与 Advisor，释放未兑现 reservation。
5. 以 interrupted 和具体技术原因进行原子 seal；原调查渠道扣费仍按终止参考规则保留；技术补偿若有确凿失败记录须在 seal 前追加且不可猜测。
6. 终局的 Evaluator/export 可按各自剩余预算/输出哈希恢复；禁止重新向已结束 gameplay 写事件。
7. 启动器 `--resume-session <id>` 只读打开本机 terminal 历史，写入新 launch 的 access grant。UI 明示中断及历史模式；不会恢复旧时钟或发出继续行进请求。

一个崩溃发生在事务中时，SQLite 回滚该笔未提交事务；应用不靠“逐行补齐一半任务”恢复。一笔事务提交后但客户端没收到响应的情形，以 durable command receipt 为准。

### 10.2 迁移顺序与备份

`001_initial.sql` 是空库安装迁移，不是对 v0.3/v0.4 文档 JSON 的自动数据升级器。迁移前：停止写入、关闭 worker、使用 SQLite backup API 生成一致备份并验证；不要只复制有活跃 WAL 的 `.sqlite` 主文件。部署元数据记录迁移脚本 SHA-256、应用版本、执行时刻及备份摘要。

加载器先读取 user_version 与 schema_migrations：空库执行 001；已为 1 且记录/预期 schema 匹配则跳过；未知更高版本明确拒绝，不能自动 DROP/重建。后续 002 必须增加独立顺序迁移文件，在一次事务里完成变换、回填验证、索引/触发器重建、FK/invariant 检查，最后写迁移记录和 user_version。不可关闭 foreign_keys 忽略迁移失败，也不可原地修改已发布迁移哈希。

迁移失败由事务回滚到原版本。若新应用已写入新结构而决定降级，关闭服务后恢复**经过验证的完整备份及匹配旧应用**；不提供运行时破坏审计记录的通用 DOWN/DROP 脚本。旧世界内容升级不修改现有局，只新建内容版本供新局使用。policy 的批准同样新增不可变批准版本；历史 review 局保留原 policy。

局删除/保留策略未作为产品决定冻结。此版不提供单行硬删除 gameplay 审计数据接口；开发期清理采用关闭服务、备份后移走完整测试数据库，再建空测试库。不能给用户一个会绕开 immutable triggers 的“清理旧局”按钮。

## 11. 实际验证与未声称的范围

测试使用两局、三场景、两调查岗位、三角色和完整账户 fixture；每例独立新数据库，正例与负例都验证 SQL 的实际结果。包含：跨局 binding/报告/更正失败、直接改余额失败、渠道整局唯一、预留父金额上限、退款不可重复、失败事务回滚、新版本另占额度、manifest 封口、单岗任务互斥、模型预算、技术迟到结果、封存双向原子性、WAIT 保留调查、离场取消不退渠道、独立 catch-up 提交保留，以及八个命名事务模板的执行。

本次实际运行 43 项测试全部通过；最终运行结果以 `database_test_results.json` 为准。合成 SQL fixture 的事件/卡片 payload 为刻意简化数据库测试数据，不能当成规范 API/Agent 示例；完整跨契约示例与 schema 验证见 API/Agent 附件。本包没有声称实际游戏、浏览器 3D、模型准确度、第三方引擎兼容性或所有故障注入已经验证。
