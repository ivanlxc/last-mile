# LAST MILE｜LLD：API、公开投影与模块契约 v0.5

2026-09-16 · 实现级设计契约；没有实现游戏服务器。

## 1. 契约范围与唯一来源

本文把前端、规则、存储与 Agent 的交接固定为可检查的结构。使用固定版本 [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html) 描述 HTTP；数据模式采用 [JSON Schema 2020-12](https://json-schema.org/draft/2020-12/json-schema-core)。不声称这两个版本是最新版本。

| 文件 | 唯一职责 |
|---|---|
| `api/openapi.json` | 23 个端点、请求/响应、每类错误、授权、幂等头和例子 |
| `api/operations.json` | 端点/operationId/状态码/请求响应类型的可机读目录 |
| `contracts/public.schema.json` | 所有公开命令、投影、来源图、结果、复盘、SSE 判别联合；对象封闭 |
| `contracts/internal.schema.json` | 24种游戏事件＋独立7种终局管理audit及记录；二者不能混写，均不得作为公开SSE原样发送 |
| `agents/contracts.schema.json` | Agent 输入、输出及公共 job；API 通过本地 `$ref` 使用，不复制定义 |
| `contracts/ports.ts` | 模块间类型化接口，无业务实现 |
| `contracts/*types.ts` | 从 canonical schemas 派生的 TypeScript 类型；不手工改字段 |
| `contracts/fixtures/*-cases.json` | 合法与拒绝样例；`contracts/examples.json` 提供各公开结构的形状示例 |
| `verification/validate_api_contracts.py` | 校验 OAS、封闭对象、本地引用、正反例和端点示例 |

JSON Schema 是运行时结构约束；TypeScript 辅助编译，不代替数值范围、条件分支、跨会话关联、额度及权限检查。字段全部显式，不接受无约束 `payload:{}`。值为 null 与字段缺失不同：除 schema 明示可选外，规定的字段必须出现。

### 参考 profile 与产品批准的区别

这是一套可直接实施、可以测试的单人参考契约：一名指挥官玩家、确定性 NPC 请求/上报、三个事件、600 秒实时钟、整局 2/3/3/2 调查资源、每场景每岗位报告 3 条、累计上传 5 条、真实自主分析、抵达成功与交接待办分离。资源整局使用和更正/溯源新版本占额已获确认；其他参考选择按本包 PRD/ADR 标识待批准。

`SINGLE_PLAYER_REFERENCE` 在 review 状态时，`normalStartAllowed=false`。`approved_play` 创建返回 422 `POLICY_NOT_APPROVED`；只有明确选择 `design_preview` 并在 start 再确认试验性质，才允许工程演示。不开放多人房间、账号或调查者原始库存端点。

## 2. HTTP 与授权约定

- 基础路径 `/api/v1`，本机 loopback，同源浏览器。除 `/health` 外必须发送 `Authorization: Bearer <opaque launch token>`。
- 启动器签发的令牌绑定本机启动。后端通过launch_session_access验证该launch对目标session的能力，再引用已有actor_binding确认身份；正文没有可提升权限的 `actor` 字段。`targetRole` 是接收任务的岗位，不是调用者身份。
- 对已有会话的访问，先验证绑定，再检索该会话下的资源。其他会话的 report/job/task ID 返回统一 404，不泄露是否存在。主机与 Origin 不合格返回 403。
- 所有 POST 必须发送 UUID `Idempotency-Key`；已有会话 POST 另需 UUID `X-Run-Epoch`。响应包含服务端 `X-Request-Id`。令牌不放 URL、SSE 查询参数、导出或日志。
- 请求 JSON 上限 65,536 字节；超限 413。已有会话的实时玩法命令一律 `{expectedStateVersion, expectedSceneId, payload}`。start 的 `expectedSceneId` 必须 null；评估与导出使用专门的 `{sealedHash,...}`，没有无意义的活动局版本字段。
- 展示回执是审计命令，独立采用 `{observedStateVersion, observedSceneId, payload}`，不对当前版本做CAS、不增加stateVersion。拒绝未来版本、未公开目标和终局后的新行为；旧版本本身不导致拒绝。只以服务端实际收到顺序决定是否早于决策，不按客户端时刻倒填知识。
- 201/202 同时返回 `Location` 头与正文资源地址。异步工作通过 GET 或 SSE 观察；模型调用在提交之后发生。GET 不把“返回了卡片”记成“玩家已阅读”。

启动器显式使用`--resume-session <id>`访问本机既有terminal记录时，新增的是launch_session_access授权记录，并复用原指挥官actor_binding；不能创建第二个角色绑定或修改封存身份。只读授权不允许恢复游戏写入；evaluation.request/export.request也必须分别有授权才可调用。公开能力session.command映射数据库commander.command，session.create是启动级能力，不冒充已有会话授权。

### 幂等与并发处理顺序

1. 验证令牌、Origin、请求格式及会话绑定；不能因知道某个旧 key 就绕过授权。
2. 查同 launch（创建）或整个session（其余命令）下该key的已成功回执。键在该范围唯一；hash覆盖method/path/runEpoch和规范化正文。相同请求返回原HTTP状态、正文和资源ID，`Idempotency-Replayed=true`；任一部分不同返回409 `IDEMPOTENCY_KEY_REUSED`。先查成功回执，再做会因时间推进而失效的版本检查。
3. 无旧成功回执时，获取会话串行锁，独立提交已到期的系统事件。随后命令被拒绝，也不能撤销刚到期的调查、截止或封存。
4. 检查 epoch、stateVersion、sceneId、阶段、额度、目标和版本关系。任何失败不花资源，不创建模型 job。
5. 一个数据库事务写规则状态、账本、内部事件、公开 outbox、任务/报告/上传、模型 manifest/job、决策快照和成功回执。持久化失败全部回滚，返回 503；不先给 UI 假成功。
6. 提交后启动外部模型或其他异步工作。成功回执随会话保存；接收前拒绝不占用成功幂等键。重试同一逻辑命令用相同 key/正文；修正正文视为新命令，使用新 key。

同一个玩法命令只在有实际变化时增加 stateVersion。时钟逐帧刷新、重复回执、重复上传同一版本不制造新版本。`inboxVersion` 只随新的授权上传改变；`assistantContextVersion` 只随模型获准上下文改变，不能随隐藏伤员、指挥官钟或 NPC 未上报卡改变。

## 3. 全部端点

所有未单独注明的调用者均为启动令牌下的指挥官。以下名称和代码精确定义于 OpenAPI；表格不是省略请求模式的替代品。

| 方法与路径（省略 `/api/v1`） | operationId | 成功 | 输入 → 输出 |
|---|---|---|---|
| GET `/health` | getHealth | 200 | 无 → HealthView；唯一匿名读 |
| GET `/bootstrap` | getBootstrap | 200 | 无 → BootstrapView |
| POST `/sessions` | createSession | 201 | CreateSessionRequest → SessionCreated |
| GET `/sessions/{sessionId}` | getSession | 200 | 无 → SessionProjection |
| POST `/sessions/{sessionId}/start` | startSession | 200 | StartRequest → SessionProjection |
| POST `/sessions/{sessionId}/tasks` | createTask | 202 | TaskRequest → TaskAccepted |
| GET `/sessions/{sessionId}/tasks/{taskId}` | getTask | 200 | 无 → TaskView |
| GET `/sessions/{sessionId}/reports/{reportId}` | getReport | 200 | 无 → ReportView |
| POST `/sessions/{sessionId}/uploads` | uploadReports | 200 | UploadRequest → UploadView |
| POST `/sessions/{sessionId}/questions` | askAdvisor | 202 | QuestionRequest → QuestionAccepted |
| GET `/sessions/{sessionId}/advice/{jobId}` | getAdvice | 200 | 无 → advisor AgentJobView |
| POST `/sessions/{sessionId}/actions` | commitAction | 202 | ActionRequest → ActionAccepted |
| GET `/sessions/{sessionId}/operations/{operationId}` | getOperation | 200 | 无 → OperationView |
| POST `/sessions/{sessionId}/display-receipts` | recordDisplay | 200 | DisplayReceiptRequest → ReceiptView |
| GET `/sessions/{sessionId}/provenance?sceneId=E2` | getProvenance | 200 | sceneId → ProvenanceView |
| GET `/sessions/{sessionId}/events` | streamEvents | 200 | 可选游标 → text/event-stream |
| POST `/sessions/{sessionId}/abandon` | abandonSession | 200 | AbandonRequest → OutcomeView |
| GET `/sessions/{sessionId}/outcome` | getOutcome | 200 | 无 → OutcomeView |
| POST `/sessions/{sessionId}/evaluations` | requestEvaluation | 202 | EvaluationRequest → EvaluationAccepted |
| GET `/sessions/{sessionId}/evaluations/{jobId}` | getEvaluation | 200 | 无 → evaluator AgentJobView |
| GET `/sessions/{sessionId}/replay` | getReplay | 200 | 可选 cursor → ReplayView |
| POST `/sessions/{sessionId}/exports` | createExport | 202 | ExportRequest → ExportAccepted |
| GET `/sessions/{sessionId}/exports/{exportId}` | getExport | 200 | 无 → ExportView |

### 错误契约

错误媒体类型 `application/problem+json`，固定字段：`type/title/status/code/requestId/retryable/currentStateVersion/detail/violations`。未能授权到会话时 currentStateVersion=null；错误内容不含案卷、未公开目标、原始来源根或未来后果。`Problem400` 等子模式限制状态与 code 的配对。

| HTTP | code 集合与处理 |
|---|---|
| 400 | INVALID_REQUEST：schema、参数组合或请求格式不合法 |
| 401 | UNAUTHORIZED：缺少/无效启动令牌 |
| 403 | CAPABILITY_DENIED、CURSOR_SCOPE_MISMATCH：能力、Origin或视图范围不符 |
| 404 | RESOURCE_NOT_FOUND：不存在或不属于本会话的公开资源 |
| 409 | STATE_VERSION_CONFLICT、SCENE_CONFLICT、RUN_EPOCH_CONFLICT、IDEMPOTENCY_KEY_REUSED、REVISION_CONFLICT；重新取投影后由用户发新命令 |
| 410 | CURSOR_EXPIRED：公开事件位置不可恢复；GET投影并从其lastViewCursor续接 |
| 413 | BODY_TOO_LARGE |
| 422 | PHASE_NOT_ALLOWED、POLICY_NOT_APPROVED、BUDGET_EXHAUSTED、ROLE_BUSY、TARGET_NOT_AVAILABLE、REPORT_LIMIT、UPLOAD_LIMIT、NOT_REPORTED、ACTION_NOT_AVAILABLE、SEALED_HASH_MISMATCH、NOT_TERMINAL、ALREADY_TERMINAL |
| 429 | RATE_LIMITED、MODEL_BUDGET_EXHAUSTED；带Retry-After，模型预算耗尽不锁死行动 |
| 503 | STORAGE_UNAVAILABLE、SERVICE_UNAVAILABLE；带Retry-After，重试原逻辑请求 |

结构正确不等于领域可执行。API 返回上述错误时，UI呈现明确原因，不把拒绝误记为玩家完成了一次调查或咨询。

## 4. 调查、NPC 选报和版本传播

### 4.1 接受任务

`investigate_and_report` 包含 `targetRole/topicId/targetId/investigationKind/sourceReportId/reasonAnnotation`。公开 taskOptions 对每个目标/调查类型给出 `resourceChannel` 与可见成本，不用一个模糊“调查”按钮让玩家事后才知道扣哪个额度。

- 分析员只用 satellite_scan/drone_observe；联络员用 agency_contact/witness_interview/provenance_trace。
- 服务器检查 targetId、topicId、调查类型是否在本场景公开目录。跨案卷保持相同公开 definitionId，不把私有变体编码进 URL 或图标。
- 有效调查先预留一个报告槽，再扣一次整局渠道；任一不足整体拒绝。一个岗位最多一个进行中任务（含request_report），两个岗位可以并行推进同一时钟。
- trace 必须引用指挥官已经收到、且模板允许追问的 sourceReportId。扣模板指定的 traceCostChannel（localAgency/witness），并在公开 TaskOption 中显示。来源卡的 channel=initial 不是可扣费渠道。
- 实际完成后才生成 EvidenceInstance。新核验/更正版不可覆写旧正文；实际上报消耗所预留槽。TaskView 在结果尚未上报前不含正文，reportId=null。
- 离场取消未完成调查：渠道已花不退，释放未用报告预留。技术失败使用独立 refund/release 账本事件补偿；网络重试不能再次补偿。

`request_report` 仅含 targetRole/topicId；它只从该岗位已取得且未正式上报的同主题资料中选择。匹配后预留一个报告槽、占用该岗位任务位，1000ms后交付；不消耗调查渠道。排序固定为公开主题相关性、作者公开优先级、取得顺序，不使用隐藏正确路线的效用。没有匹配资料时返回422 TARGET_NOT_AVAILABLE，不预留、不扣费、不即时编造观察。NPC选择记录为 npc，不写成玩家主动丢弃。

### 4.2 卡片与上传

公开 ReportView 包装 reportId、sourceRole、sceneId、reportedAtMissionMs 和 EvidenceCard；卡片含不可变 evidenceInstanceId/revision/正文/来源/范围、观察时间、已披露来源状态。报告ID、卡实例ID、revision必须相互一致且属于该会话；JSON Schema只验证各字段形状，这些关系由事务层验证。

上传使用 reportId+expectedRevision，后端取真实不可变快照，不信任前端正文。已上传同一实例/版本为no-op；新revision占新额度，不能通过更正就地替换绕限。整批先验证后写入：第六条不能造成前五条偷偷成功。

freshness是依据观察时刻和已经公开更正派生的投影状态，不是修改历史正文的许可。旧版本和旧上传一直可回看；新来源核验不能倒写旧决策快照。validUntil不是保证真实世界永远不变的免责期限。

每次成功新上传自动触发分析；250ms合并窗口只留最新获准上下文。显式提问立即执行，并吸收同版本尚未启动的自动分析。`uploadBatch`与问题在同一事务验证，先用上传前expectedInboxVersion检查，再绑定上传后的manifest。事务后模型失败不会撤回已授权上传。

辅助AI使用专门的 AdvisorInput，绝不直接序列化 EvidenceCard、SessionProjection 或全部日志。指挥官时间、伤员、资源、未上传差集及NPC私有库存不自动进入模型。主动自由文字是未核验 PlayerStatement，不能伪装成正式证据。

### 4.3 可选理由注记

ActionRequest与investigate_and_report可携带 reasonAnnotation；客户端无填写时显式发送null。非null结构为去重 reasonCodes、acknowledgedLimitation、comparedKnownCosts、declaredQuestionKey。`new_question`与`no_new_question`不可同时选。

这对应可折叠的“记录我的考虑”，不强迫问卷，不预选答案。它是明确自报证据；不能据一个勾选认定真实动机，也不能对自由reason做NLP后擅自补上这些标记。没有填写时，不作依赖动机的支持归责；已实际存在的客观机会数仍保留，未观察到支持也不等于行为不存在。

展示回执有report_opened/advice_displayed/consequence_seen/context_displayed四种。最后一种三个资源ID均为null，服务端以observedStateVersion/observedSceneId找到已保存的公开briefing，证明成本与能力信息确实呈现；不能只因UI存在一个折叠菜单入口就发送。折叠卡摘要不冒充report_opened。若无对应回执，依赖“已呈现成本/能力”的行为评价条件不成立。

## 5. 行动、封存和异步任务

ActionRequest的actionId必须在当前公开ActionOption中。客户端不提交routeId来绕过事件门控；服务器从已固定案卷和动作计划派生连续执行段。行动接受前保存当时合法选项、已知成本、已收到/已打开报告、上传与已显示建议，不能以后用最终库存回填。

WAIT只能选择15/30/60秒，waitDurationMs非null，cancelPendingInvestigations=false。它不离场，进行中调查照常完成；到时返回同场景。其他行动waitDurationMs=null；若离场时有未完成调查，必须明确cancelPendingInvestigations=true，否则422。UI确认页列出将失去的进行中结果，不能暗中取消。

OperationView只包含已发生的进度、公开位置与状态，不返回私有执行段、未来受阻坐标或精确隐藏ETA。操作状态 accepted/running/completed/cancelled/failed；任务使用相同状态集合；调查存储另允许queued。

达到终局立即封存。参考profile的到达成功记录arrivedAtMissionMs并停止局内规则；登记与检查待办分别保留，不能在结算动画或模型等待时扣额完成。handoffCompletedAtMissionMs只有真实交接完成事件才能赋值。之后局内调查、上传、追问、动作和行为display receipt均拒绝；结果读取、独立评价和导出可用。

评价以sealedHash+evaluationConfigId确定同一逻辑job，成功结果缓存，失败恢复共享Agent系统规定的两次实际模型调用额度。Job公共结果有角色与状态约束：advisor接口不允许evaluator结果；queued/running/failed/cancelled/superseded为null，succeeded/fallback必须有匹配角色结果。离线模板明确标mode，不能冒充实时模型。

ExportView在succeeded时返回artifact JSON，前端保存文件。导出最多2MiB；超限明确失败。includePlayerStatements必须显式选择；导出无任意文件路径、密钥、prompt、NPC未上报库存或隐藏案卷。它只记录允许公开的复盘，不能借“下载”端点读取工作目录。

## 6. 来源图与 SSE

来源图节点是公开图ID、标签与可选reportId。确认边必须指向实际已上报的disclosedByReportId；claimed/hypothesized/verified互相区分。免费打开图只读已知关系；真实AI可猜同源，但不能因此获得隐藏根ID。原始root_source永不作为ReportView的默认元数据。

浏览器用支持Authorization头的fetch读取SSE，不在URL放token。事件ID是`runEpoch:viewSequence`；sequence只在该公开视图单调递增，不暴露内部事件计数。`Last-Event-ID`与after二选一，两者并存400；cursor必须绑定会话、epoch和指挥官视图。

正常恢复：GET会话取得完整投影和lastViewCursor，再打开SSE从其后续接；没有提供游标时从本局公开序列起点重放。每局公开事件持久保存，不靠内存环形队列丢失已提交通知。若请求的位置已不可恢复，返回410，客户端改为重新取投影。客户端按cursor去重，不能靠重复SSE再次扣费或发模型请求。

| eventType | data的唯一模式 |
|---|---|
| projection.changed | SessionProjection |
| task.updated | TaskView |
| report.received | ReportView |
| uploads.changed | UploadView |
| advice.updated | advisor AgentJobView |
| operation.updated | OperationView |
| outcome.sealed | OutcomeView |
| evaluation.updated | evaluator AgentJobView |
| export.updated | ExportView |
| clock.sample | missionTimeMs/serverNow/missionDeadlineMs |

每个data envelope还含sessionId/runEpoch/viewSequence/stateVersion/eventType。`clock.sample`每秒写入公开view_events并取得viewSequence，不进入domain events、不增加stateVersion，保证重连游标连续；15秒无业务数据可发送`:keepalive`注释，不产生状态或资源变化。事件体经PublicSseEvent联合校验后才发布。内部InternalEvent含私有内容、内部seq与演员信息；ProjectionService必须构造全新白名单对象，禁止直接转发或仅删除几个字段。

## 7. 跨模块落地与写入边界

`contracts/ports.ts`固定协调器、单调时钟、会话锁、纯规则引擎、调度器、调查Broker、NPC选择、报告、上传、投影、SSE、Agent编排、模型适配、事实构造、导出和SQLite接口。catchUp接收sampledMonotonicMs，UTC Date只作记录/展示，不能推进任务。private ContentRegistry返回从content schemas派生的server-only类型；前端不得导入该文件。Advisor job绑定inputManifestId；Evaluator job直接绑定sealedHash与独立EvaluatorInput，不伪造Advisor manifest。

ModelAdapterPort直接引用`agents/modelAdapter.ts`的canonical ModelAdapter，只提供`generateStructured(StructuredRequest): Promise<StructuredResult>`；共享导出其ModelConfig、ModelUsage及请求/结果类型。请求保留requestKey、schema、模型与超时/输出限制，结果保留providerRequestId和实际token用量，包括失败时可获得的用量。编排器在调用前登记attempt和预算，在调用后做schema/引用/时效校验，不用简化的advisor()/evaluator()端口丢掉成本记录。

SQLite映射：camelCase接口→snake_case列。内部事件的eventType对应events.kind，data对应payload_json，missionTimeMs对应mission_ms；requestId是请求关联，causationEventId是同局前因事件，不能混作一个外键。actor.kind使用human/npc/rules/system；模型发布是system并携带agentRole/jobId，模型不拥有世界写权限。

### 7.1 游戏日志与终局管理记录分流

`InternalEvent`只供游戏日志使用；其中agent生命周期明确限定agentRole=advisor。终局seal冻结events与last_event_seq，数据库和写入边界拒绝继续追加。behavior.facts_built、export.*和evaluator生命周期已从该联合移除，不能套一个旧seq写回游戏历史。

独立的`PostgameAuditEvent`是封闭判别联合，envelope只有auditId/sessionId/sealedHash/createdAt/eventType/data；没有gameplay seq、missionTimeMs或伪造的玩家actor。七个eventType为behavior.facts_built、evaluator.job_queued、evaluator.attempt_started、evaluator.attempt_finished、evaluator.job_finished、export.queued、export.finished。每种data有独立字段，评价attempt完成记录保留实际或未知的token用量和providerRequestId。

`AuditStorePort.withTransaction`验证已存在的immutable seal，相关agent_jobs/agent_attempts、behavior_facts、evaluation_reports、export_jobs的管理写入，与append audit在同一个短事务完成。append将auditId写diagnostic_id、createdAt映射recorded_at_ms、完整封闭event写payload_json，category=postgame_audit；sessionId和sealedHash必须匹配事务与terminal_seals。同auditId重试只产生一条记录，不触碰events、last_event_seq、stateVersion或原行为seal。模型网络请求仍在事务之外。

管理任务可通过独立白名单投影生成evaluation.updated/export.updated的公开view_events，公开cursor可继续推进；它不改变游戏行为序列。ProjectionService.postgamePublishable接收独立audit与公开job/view，不直接转发私有audit。终局后晚到的旧Advisor响应只进入既有技术诊断流程，不能重新产生gameplay事件。

以下检查必须在写入事务内完成，不能以schema已通过为由跳过：

| 检查 | 必须成立的关系 |
|---|---|
| 额度 | remaining≥0；used+reserved≤limit；渠道余额总量只由已确认spend/refund改变；跨场景不补充调查资源 |
| 报告引用 | report/evidence/revision/sourceRole/scene/session一致；新版本独立报告槽 |
| 上传引用 | 已正式上报、当前场景、expectedRevision匹配；同版本去重；批量原子 |
| 任务 | targetRole/targetId/topicId/调查类型合法；trace引用可追问来源；同岗位唯一在途 |
| 行动 | 当前节点、事件门控、公开动作、恢复次数正确；WAIT不能被当离幕 |
| 建议 | job/manifest/scene/epoch/inputVersion对应；晚回不覆盖当前建议，不为不存在的卡赋引用 |
| 来源图 | 确认边关联的披露报告确已上报；AI所见边还需已上传 |
| 封存 | 相同sealedHash唯一不可变事实包；后续评价、重试和导出不写规则状态 |

## 8. 可运行验证与证据边界

Python依赖：jsonschema 4.26.0、referencing 0.37.0、openapi-spec-validator 0.9.0。运行：

```sh
python -m pip install -r verification/api-requirements.txt
python verification/validate_api_contracts.py
python verification/validate_types.py
```

命令在本包根目录执行；`tsc`本次用TypeScript 5.8.3。若编译器不在PATH，validate_types.py支持`--node <node路径> --tsc-js <typescript/bin/tsc路径>`。生成类型前须保证content和Agent schema已最终保存；更新schema后执行`python contracts/generate_types.py`。

类型生成覆盖运行ports实际引用的policy/scenario；author元数据`content/public-actions.schema.json`不被这些ports引用，因此不额外复制为TS。content目录全部schema与作者数据的验证由本包独立内容验证器负责。严格编译会随canonical import检查`agents/modelAdapter.ts`，验证报告列明覆盖文件；这不表示已进行真实模型网络调用。

验证脚本实际检查：OAS版本/结构、所有本地引用可解析、封闭对象、正反样例、23端点授权和幂等头、每个请求/响应示例及SSE示例。结果保存于`verification/api-contract-results.json`。类型派生一致性和严格编译另记录为type-contract-results.json。

这些检查证明设计工件的结构一致性，不证明运行时权限、真实时钟、事务竞争、LLM质量或整局可玩。实现阶段仍须运行越权ID、幂等并发、截止边界、双岗位并发、离幕取消、额度与更正版传播、晚到AI、封存屏障和恢复测试。本轮不将这些尚未实现的用例标成通过。
