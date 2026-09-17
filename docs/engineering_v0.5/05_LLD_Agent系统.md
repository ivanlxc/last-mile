# 05 · Agent 系统低层设计 v0.5

## 1. 交付边界与实现入口

本包给出可实现、可离线校验的设计契约与参考函数；没有调用真实模型，没有实现游戏服务器。实现基线是 `SINGLE_PLAYER_REFERENCE`：一名真人指挥官，分析员与联络员由 NPC 执行请求。该 profile 为 `review`；三真人、自由文本、AI 自主程度、累计上传 5 条与四维混合画像等未决产品条件，不因本文件写到实现细节而成为用户确认。

已确认的硬约束：调查额度整局共卫星 2／无人机 3／当地机构 3／目击者 2；来源追踪和更正生成新记录，重新上报与上传各占新额度，原版本不可改写。Agent 不能替玩家执行调查、上传、行动或扣费。

工程入口：`agents/contracts.schema.json` 是唯一 Agent 数据源，API 通过 `$ref` 引用其中 `AdvisorInput`、`AdvisorOutput`、`EvaluatorInput`、`EvaluatorOutput` 和 `AgentJobView`。`agents/prompts/` 是可直接加载的完整系统提示词，不是提纲。`agents/modelAdapter.ts` 是网络适配接口的参考实现。其余 Python 文件是算法及测试参考，不代替 API/SQLite 的事务实现。

## 2. 运行角色与权限

|组件|允许读取|允许写入|禁止读取/行动|
|---|---|---|---|
|Advisor LLM|当前 job 冻结的任务、行动公开成本、通道能力、批准背景、正式上传卡、未核实玩家陈述|一个候选 `AdvisorOutput`|世界真相、case/root ID、NPC 原始库存、指挥官倒计时/伤情/资源余额；执行操作|
|AdvisorOrchestrator|当前上下文版本、job/attempt 与权限清单|job、attempt、验收后的建议事件|把完整 session/world 对象串行化给模型|
|FactBuilder|封存局的操作日志、当时快照、显示回执、结构化自报理由|带截止点的事实、机会、反例与排除表|用后来真相替换过去知识，用 NLP 猜真实动机|
|Evaluator LLM|一局一人的 `EvaluatorInput`，四维上界|一个候选 `EvaluatorOutput`|剧本真相、最终输赢、Advisor 会话记忆、工具或执行权限|
|OutcomeRenderer|封存结果和已允许揭示的剧本真相|确定性的结果解释视图|把事后解释反馈给行为归因|

两个 LLM 可以使用同一供应商或同一模型，但必须分别发起无历史消息的调用，系统提示词、输入、缓存和权限分开。终局无需第三个 LLM。真相只用于确定性的结果解释；行为评价 Agent 不接收真相，因此不会因结局不佳倒推“你盲信了”。

## 3. Advisor 严格投影

### 3.1 字段来源

ProjectionService 从正式 `uploads → reports → evidence_instances` 的 session-scoped 外键解析资料，逐字段构造下表。禁止 `{...card}`、整行 JSON 或序列化 ORM 关联对象。

|Advisor 字段|唯一来源与规则|
|---|---|
|`sessionId / sceneId`|当前 job 的绑定；运行期随机 UUID 不编码情节分支|
|`contextVersion`|只由 AI 获准信息变化递增的 `assistantContextVersion`|
|`publicTask.objective/currentNodeId`|公开任务和当前地点|
|`publicTask.actions`|公开选项、已告知的固定/基础成本及限制；不发送根据隐含 case 计算的完整预计到达时间|
|`channelCapabilities`|静态能力及公开 target/topic；不含剩余次数、忙闲或伤情优先级|
|`backgrounds`|该场景批准的背景白名单，最多 5 条；补齐 revision=1、fictional=true、来源、适用时期、范围和限制|
|`evidence[].instanceId/revision`|被正式上传的运行期实例；不取 author definitionId 作为 citation ID|
|`text/sourceLabel/scope`|公开 body/sourceLabel/observationScope；不改写为“真实原因”或增添隐藏线索|
|`observationAgeMs`|该报告形成时附带的观测年龄；如历史卫星帧 600000。null 表示未知，不等于实时|
|`freshness`|该次正式信息快照的 current/historical/superseded/unknown 标记；不是根据现在 missionTime 重新计算|
|`observationType`|observation+satellite→historical_image；observation+其他→direct_observation；testimony+机构→official_statement；其他 testimony→witness_statement；provenance/correction 对应同名类型；brief→official_statement（必须在 limitations 标明任务简报，不是现场核验）|
|`limitations`|公开观察范围和通道限制的固定文本，至少一项；不能凭模型编造|
|`knownSourceEdges`|仅从已正式上传的溯源记录生成，端点和 findingRef 都必须位于当前允许清单|
|`statements`|玩家主动提交、最多保留当前幕最近 12 条；一律 verification=unverified|
|`question`|该次允许的问题及被选中的已上传 ref；非玩家主动声明的私有数据不得注入|

Commander 的 `receivedAtMissionMs`、`validUntilMissionMs`、游戏时钟、健康、预算不进入上述投影。observationAgeMs 与等待时间不同；等 10 秒不会把 600000 自动变成 610000，也不发送“刚过期了”的隐含计时通知。只有显式新上报/上传的信息改变年龄和时效说明。来源追踪先在 Commander 可见也不等于 Advisor 已获知；新的 finding 必须占用正式上传单位。

公开定义 ID 必须跨 case 相同，不能包含 A/B 或正确答案编码。根源 `hiddenRootId/root_source` 永不投影。对关系两端未全部获准的 edge，整条不发送，不通过“还有未展示来源”数量暴露库存。`possibly_related` 是已提供的假设，不冒充确认关系；确认关系必须有已上传 findingRef。

### 3.2 上下文构造算法

1. 在 session 串行锁内完成 scheduler catch-up，验证当前幕与未封存状态。
2. 从当前幕累计上传列表按 commit sequence 取全部正式单位（review profile 上限 5），解析不可变实例及版本。重复 idempotent 上传不重复计数；新更正/溯源是新单位，不能替换原条目腾出容量。
3. 读取该幕批准的背景、公开行动/通道能力和最近 12 条玩家陈述。每条输入来自白名单 projection；不足不补隐藏字段。
4. 删除不满足端点与 finding 授权的来源边；所选问题引用必须是允许的证据版本。正式卡片正文、范围、标签分别不得超过 2200/400/160 字符；启动内容检查即拒绝过长素材，不截断可能改变含义的正文。
5. 参考 profile 每次 `priorAnalysis=null`，不将模型自己写的结论循环当新证据。`changeSummary` 只报告“本次新增信息支持什么”，不要求模型猜上一轮的心态。schema 保留 nullable priorAnalysis 供后续版本，当前构造器不使用非空分支。
6. 依 `context_reference.py` canonical JSON：递归 key 排序、数组保留授权提交顺序、UTF-8、无空格、无 NaN。去掉 inputHash 后 SHA-256，写回 inputHash。schemaVersion、session、scene、contextVersion 都参与。server secret、当前时钟与配置密钥不参与。
7. 执行 2020-12 schema + `guard_advisor_input`；保存不可变 input_manifest、成员、statement refs 和 JSON，再创建 job。网络调用必须在事务提交后进行。

背景是虚构演习背景，不联网检索现实事件。背景检索只按已批准 scene→backgroundIds 表，无向量搜索全库，没有“隐藏正确资料”。自由文本允许玩家复述未上传情报；标记为未核实不能从语义上阻止其影响建议。因此这是一条待确认产品取舍：参考 profile 保留陈述能力，正式卡片计数仍严格执行，不能宣称完全封死信息漏斗绕过。若产品选择严格漏斗，需关闭 free_text，而不是假称文字过滤器能识别所有绕过。

## 4. 只读端口与模型请求

`tools.schema.json` 为以下端口给出闭合 JSON 输入和成功/错误输出，`contract_guards.readonly_tool` 提供参考。调用者的 job capability 包含 sessionId、jobId、manifestId、inputHash；不是模型可自填的参数。

|端口|输入|成功输出|权限检查|
|---|---|---|---|
|`readUploadedEvidence`|evidenceRef(instanceId,revision)|当前 manifest 的完整 Advisor Evidence|精确版本匹配，不能按全库 ID 查找|
|`readBackgroundRecord`|backgroundId,revision|当前批准 Background|属于本 job 白名单|
|`listPublicActions`|闭合空对象|本 job 的 PublicAction[]|返回冻结公开集合|
|`listChannelCapabilities`|闭合空对象|本 job 的 ChannelCapability[]|没有余额/实时任务状态|

拒绝码仅 `REFERENCE_NOT_AUTHORIZED / STALE_JOB / TOOL_BUDGET_EXHAUSTED`，不区别“存在但秘密”与“不存在”。每逻辑分析最多 2 次按需读取。参考执行路径已经把资料放进一个完整 input，所以通常为 0 次；这四个端口是服务端构造/读取端口，不开启 provider 多轮工具循环，也不额外消耗模型调用额度。Evaluator 无任何工具。将来新增 LLM tool loop 属于契约版本变更。

Adapter 每次接收：role、model、完整 systemPrompt、input、目标 JSON Schema、requestKey(UUID)、maxOutputTokens、timeoutMs、取消 signal。`http_json` 明确定义为自有后端网关协议，不是假设所有供应商支持同一请求：

```text
POST configuredEndpoint
Authorization: Bearer <backend-injected key>
Idempotency-Key: <attempt.request_key>  // 仅 supportsIdempotency=true
{model,messages:[{role:"system",content:prompt},{role:"user",content:JSON.stringify(input)}],
 responseSchema,maxOutputTokens,idempotencyKey}
→ {structured:<object>,usage:{inputTokens:<int>,outputTokens:<int>},requestId?:<string>}
```

生产供应商适配器必须把其返回映射成 `StructuredResult`；外部 SDK 不得暗中重试。endpoint 必须 HTTPS（本机网关可 loopback HTTP）；密钥只从后端注入，配置文件保存 env 名而不是密钥值。当前配置 provider=mock；不读密钥、不发请求。缺配置直接离线，不算模型调用。HTTP 429/5xx 可恢复；错误正文不进入玩家视图或 Agent prompt。

## 5. 调度、缓存、超时与预算

### 5.1 固定参数

|项|参考值|
|---|---:|
|上传/新增陈述触发去抖|最后一次获准变化后 250 ms|
|同一 session 逻辑活跃 Advisor|1 个 queued/running|
|相同封存与配置的活跃 Evaluator|1 个|
|Advisor 单次请求超时/输出|8000 ms / 1200 tokens|
|Evaluator 单次请求超时/输出|20000 ms / 3000 tokens|
|每个逻辑 job 实际调用总额度|2 次：首次 + 1 次恢复|
|每局 Advisor 总发送额度|30 次，含失败、超时、格式修复、发送结果未知|
|输入序列化字节上限|Advisor 65536，Evaluator 393216；超限直接规则回退，不能静默删关键证据|
|只读按需读取|每 job 至多 2 次；参考路径 0 次|

显式 why/compare/uncertainties/next_check/free_text 问题绕过去抖立即排队，吸收相同版本尚未执行的自动分析，但不能绕过总调用额度。只读 UI 打开、计时 tick、健康变化、资源消耗不触发 Advisor 自动重算。改变情景、正式上传、新陈述/新问题等获准内容变化才产生新上下文版本。进入新幕清空上一幕的模型上下文；session 审计仍保留历史。

计时为真实时间：模型等待期间唯一 mission clock 正常前进，不另扣一个“分析耗时”。deadline_at_ms 是后台技术 UTC 时间，不发送给模型。

### 5.2 Job 状态及提交步骤

```text
queued → running → succeeded
   │         ├→ fallback / failed
   ├─────────┴→ superseded / cancelled
fallback / failed → queued   // 仅尚有恢复额度且输入仍有效
succeeded / superseded / cancelled：历史终态，不原地重采样
```

attempt 独立为 `sending → running → succeeded|failed|timeout|unknown`；允许 sending 直接落终态。一个 job 只能有一条 sending/running attempt。attemptCount 从持久化 attempt COUNT 派生。

事务 A：校验未过期与额度，置 job=running，先插入 sending attempt 并占发送额度，再提交。此后才调用 ModelAdapter。即使进程在网络附近崩溃也不自动退款；旧 attempt 标 unknown，迟到诊断写 diagnostic_records，不改写其历史。Adapter 无循环重发。

事务 B：检查 session、当前 scene/context、输入 hash 和 job 状态。过期响应不产生当前 adviceReady，不写决策快照；保留 attempt 用量与诊断。当前响应先 schema，再 ID/权限/引用守卫，最后原子写 result、job 与公开事件。

schema/引用格式第一次失败可立即用第二次额度修复：只发送相同原始输入、完整原系统提示词及固定“按 schema 重试，不添加未提供信息”说明，不把不可信整段坏输出嵌为系统消息。第二次再失败回退。临时网络失败/超时先回退，允许玩家显式恢复一次；格式修复和临时失败恢复共用该第二次，不能各获一次。每次激活执行有技术截止：Advisor 当前激活 18 秒，Evaluator 42 秒；显式恢复可以重新设技术截止，但不重置 attempts。

`mode=live_model` 仅成功实际模型结果；`fallback` 固定 `mode=offline_template`。离线结果不是成功缓存。后续恢复仍复用同一个 job，清空公开 result/error，转 queued，且只在剩余额度与输入仍有效时允许。未配置时生成的 fallback 有 0 attempts；配置启用是显式管理操作，不自动在后台批量追发。

缓存键：Advisor=(session,scene,contextVersion,inputHash,configHash)，Evaluator=(session,sealedHash,configHash)。configHash 是规范化模型配置（不含密钥）+提示词文件 SHA-256+schema SHA-256+rubricVersion 的 SHA-256；整局锁定配置。相同键成功直接返回相同 job/result，不允许点击“重新评价”反复采样。切换供应商/提示词须建立显式新配置审计，不允许拿它绕过 session 调用限制；正常游戏不开放此开关。

一次成功历史建议后来可能已不适用：数据库不修改其 succeeded 行，UI 按当前 scene/context 判定“历史建议”，不得显示为当前建议或用于新决策的“已显示当前建议”关系。只有非成功待处理 job 能转 superseded。封存 barrier 取消未完成 Advisor，再冻结局；Evaluator 的 seal 不随浏览复盘改变。

## 6. 建议验收与展示

1. JSON Schema 严格禁止额外字段，并验证精确类型、长度、枚举、UUID、引用形态。
2. `guard_advice` 验证 session/inputHash、唯一 claimId、evidence/background/statement 的精确版本来源、claimRefs 与公开 action/target。
3. observed 事实不得引用 statement 伪装证据；background 不得伪装当下观测。inference 必须显式标成推测；schema 无法证明自然语言遵守该语义，需内容测试而非声称已保证。
4. claim、summary、rationale 与条件仍可能产生语义幻觉；UI 显示引文入口、范围和不确定性，不显示数值置信概率或“系统认证正确”。当前设计不强制固定一幕误判。
5. 前端只渲染转义文本，无模型 HTML/Markdown 执行。显示建议主体后发送 advice_displayed；行动成本与通道能力面板完整呈现后发送 context_displayed（三个实体引用全 null），服务端绑定 observedStateVersion/SceneId 对应已留存 briefing。仅后台生成成功不算玩家看到。回执证明可观察到的呈现，不证明理解。

## 7. FactBuilder：从日志到可观察事实

### 7.1 冻结上下文

封存后按 event sequence 重放，只抽取真人接受的 route action、WAIT 和 `investigate_and_report` 请求。NPC 自动挑选或漏报不归责玩家；同一个请求不同时当作“真人作出证据选择”。失败校验和重发不构成新行为机会。

每个 context 的 cutoff 是命令提交前的已知世界快照，加该命令同期的选择与自报理由。记录：真人 binding、scene、当时合法 actions、已呈现卡片 refs、Advisor 当时 uploaded refs、已显示建议及显示时间、已呈现成本、选择和可空结构化理由。发生在 cutoff 后才收到的卡片、建议或来源关系不得倒灌。动作提交本身的事实 availableAt=cutoff，不得用后续执行结果作它的证据。

Action/调查请求的 `reasonAnnotation` 是可空自报 UI，含 reasonCodes、acknowledgedLimitation、comparedKnownCosts、declaredQuestionKey。null 或空 reasonCodes→`no_reason`。不从自由文本 reason 用 NLP 补这些代码；引用卡片必须同时有该决策前 display receipt。勾选“仅因 AI 这样说”记录的是玩家这次自报，不能证明内心唯一动机。允许跳过，缺理由时排除依赖动机的行为归责。

单机无法监测团队在屏幕外的口头沟通。`not_collected` 不表示“没有沟通”；每项评价保留该限制。如果玩家明确报告有相关但未记录的外部交流，则 `unobservedCommunication=true`，排除依赖缺乏理由的负向支持。单机默认不能从“没录到”推出另一玩家传递或没有传递。多真人模式尚未确认，不增加假装可观测的口头日志。

参考游戏最大 600 秒、WAIT 最小 15 秒、调查整局至多 10 次、路线决定最多 4 次，故候选 contexts 上界 54，schema 容量 64；每 context 至多 12 个合并事实，容量 768。不采样丢弃后半局；若未来规则突破上界，则拒绝启动该 profile 或明确技术回退，不截断后继续给完整画像。

### 7.2 具体特征判定

`public-fact-catalog.json` 使用公开 definitionId + 可见 body 的 SHA-256 精确匹配，标注该文字回答的问题及支持/反对的局部通行条件。它不读取 case、隐藏 truth/root、未来结果。未收录或修改的文字一律 unknown；在更新内容时必须重新审查相应匹配项。匹配仅表示“这段当时可见陈述如何支持推理”，不表示陈述真实。

|特征|确定性计算；缺信息的默认值|
|---|---|
|adviceShownBefore|存在绑定当时 context 的有效 display receipt，时间≤cutoff；否则 false|
|adviceHasAction / recommendationLegal|已验收建议的 action 非空，且在当时 legalActionIds；否则 false|
|chosenMatchesAdvice|chosenActionId 与该建议 action 精确相同；不等于依赖|
|visibleGapPresent|该 action 的 public question keys 中至少一个未被当时已显示且 current 的匹配记录回答，并且已打开卡片的 catalog.exposedGapQuestionKeys 明确包含它；否则 false|
|availableRelevantCheckCount|对缺口 question，public catalog 提供匹配 scene/channel/topic；当时玩家可用且资源足够、角色空闲、报告空间足够的任务数。不查看将会查到什么|
|checkKnownAffordable|玩家已显示调查时间、资源/报告成本；当时余额足够且剩余时间大于已告知最大固定耗时。成本范围未知或未显示→false|
|adequateVisibleAdviceSupport|已显示 current 卡，精确 ref 被已显示建议引用，catalog 对推荐 action 有 positiveLocalActionSupport；没有已显示相反记录；否则 false。仅局部条件支持，不代表建议最优|
|visibleCurrentCounterEvidence|已显示卡的 negativeLocalActionSupport 匹配建议 action，或玩家自报 current_conflict；保守作为反例，不自动证明冲突正确|
|costDisplayed|操作成本与通道能力完整呈现后，有绑定当时 observedStateVersion 的 context_displayed 回执；阅读慢不能由此认定“浪费”|
|checkLowValueByPublicRule|见下一表，未知一律 false|
|checkRefreshesExpiredEvidence|明确请求更新观测窗口或刷新已标旧资料；不是看到总耗时后倒推|
|usedEvidenceInReason|referencedReportIds 至少一项已显示，且 reasonCodes 包含 evidence_supported/accepted_uncertainty_for_time；不解析文字猜引用|
|acknowledgedLimitation / comparedKnownCosts|只取明确 reasonAnnotation 自报，并要求对应限制/成本实际呈现；默认 false|
|technicalIssue / coverageComplete|回执缺口、版本不符、前端断连造成的信息覆盖不明→技术限制；不因坏结局设 true|

公开低增量规则：

|规则|必要条件|排除|
|---|---|---|
|PV-01|同一已回答 question、相同目标与观测时间窗；旧回答已显示、仍具适用性，无新公开矛盾|新时间窗、刷新、改目标、源独立性未知→不认定低价值|
|PV-02|玩家 declaredQuestionKey 明确落在已显示通道的 cannotConfirm 表；没有另一个声明的可回答问题|没有明确问题或未显示能力限制→未知|
|PV-03|前两者均无法完全证成|返回 unknown，不能根据最终没有发现线索而称其“多余”|

当前任务 API 不显式固定 observation time window，所以实际实时重查默认为新窗口，PV-01 不得仅因相同 target 就触发。PV-02 可按已交付 question/channel 表执行。WAIT 若没有声明且可判定的检查目的则没有低增量支持；不能把谨慎等待本身计为过度谨慎。

### 7.3 四维机会、支持与反例

`fact_rules_reference.py` 是可执行判定表；先执行全局排除：NPC、技术问题或信息覆盖不完整时所有维度不作支持。

|维度|有评估机会|支持必须同时成立|排除/反例|
|---|---|---|---|
|complacency|真人路线决定、看见有效建议、已显示缺口、存在相关且可承担检查|行动同建议，显式自报 ai_said_so|未知相关口头信息、无理由；已记录证据理由或接受时间取舍排除|
|distrust|真人路线决定、已显示建议和当前局部支持依据|行动异于建议，显式自报 prior_ai_error_only|当前矛盾、未共享证据、合理风险/时间取舍、无理由或未知相关交流|
|overCaution|真人调查/等待、看见成本且可承担、公开规则证实本次不能增加所选问题的信息|自报 no_new_question|刷新旧证据、新问题、时间窗改变、渠道价值未知、无理由|
|calibratedTrust|真人路线决定、引用当时可见资料、承认限制并比较已知成本|evidence_supported 或 accepted_uncertainty_for_time|自报只因 AI 或只因过去错误；不要求与 AI 一致或结局成功|

每个支持/反例/排除记录具有 factId、contextId、ruleId、来源 event UUID、对应 evidence refs、availableAt 和 cutoff。事实文本由固定模板插入已验证标签/数字，不能让 LLM先写“事实”再给另一LLM评分。每维机会数按真实 eligible context 数，不用上传数或同意 AI 次数。一个维度在同一幕最多一个支持单元；按 event sequence 取首个支持 context，防止反复点击制造“重复观察”。

机会有而未选支持→not_observed，不表示该行为不存在；无机会→not_assessable；一个场景有支持→observed_once；两个以上不同场景→repeated_observation。四维独立，可混合，非概率且不求和。仅这局的观察不是临床人格/信任量表，阈值是待评审游戏规则。

## 8. Evaluator 输入、验收与回退

FactBuilder 生成 `bounds`：每维 eligibleContextRefs/数量、supportCandidates（只含合格真人 context 与对应支持事实）、counterevidenceRefs、exclusionRefs、允许等级。`allowedSupportLevels` 必须为当前最多支持数允许的前缀：0机会只 not_assessable；有机会至少 not_observed；1个场景最多 observed_once；≥2场景可 repeated_observation。Evaluator 可以保守少选，不能增加机会或越过上界。

Evaluator 输入只含单个封存局、单个真人主体，最多 64 contexts/768 facts。终局类型只说明正常结束/弃局/技术中断/演示，不含输赢、伤亡或路线真相。模型输出四维、关键时刻、下一轮练习建议与限制。`summary` 仅总结已有引用；“你导致了失败”“你一定因为害怕”等不可证明归因不允许。

验收顺序：schema → session/seal/rubric 相同 → 每项事实的 context/subject 绑定 → availableAt≤该 context cutoff → 引用证据确实在当时 playerVisibleRefs → 已显示 advice 时间合法 → 机会数等于 bounds → 支持 context 属于该维候选且每个都有支持事实 → 同幕不重复 → 支持等级与数量相符 → keyMoments 只能引用自身 context。单纯在全局日志找到同一个卡 ID 不足以通过。

最终 overallPattern：0 个有支持维度→insufficient_evidence，1 个→limited_pattern，2 个以上→mixed。它是报告呈现方式，不选一个人格类型。反例优先展示；未选支持的理由写不确定性。

`offline_fallback.py` 两个函数输出同一 schema：Advisor abstain，不选行动；Evaluator 使用规则已有支持和反例生成明确标为离线的摘要，不假称独立AI分析。缺 provider、输入超限、超时、预算耗尽、最终格式失败都可触发；输入本身非法则 failed 并写技术诊断，不能把非法数据送进模板。缓存/恢复政策与 §5 相同。

## 9. 测试、可验证范围与交接

`agents/fixtures/` 给出完整 Advisor/Evaluator 输入输出、事实判定正反例和可执行负例。运行 `agents/validate_agents.py` 校验 2020-12 schema、引用与时点、私有字段拒绝、NPC 排除、合理时间取舍反例、刷新不算过度谨慎、同幕重复、只读权限和发送预算；结果写 `agents/validation-results.json`。测试没有调用真实模型。

通过这些测试说明结构和参考规则可重复，不说明模型自然语言一定真实、提示注入已完全防住或行为规则经心理学验证。落地验收还须在固定模型/提示词版本上用作者评审样例测试：正常、空证据、转述同源、旧图像、玩家诱导、恶意卡片文本、冲突更正、未共享资料、超时/晚到、跨局复用和终局样本。模型候选验收失败时必须走固定回退，不能为了演示而给它一份隐藏正确答案。

最小落地顺序：先接投影与 fixtures →接 SQLite job/attempt 事务 →接 MockModelAdapter →把 UI display receipts/可空自报写入快照 →接 FactBuilder 与离线AAR →最后在 profile 已获批准且供应商配置有效时启用真实模型。正常游戏不提供查看 system prompt、全库搜索或手动改分接口。
