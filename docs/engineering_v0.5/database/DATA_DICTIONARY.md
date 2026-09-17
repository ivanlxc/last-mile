# 数据字典 · SQLite v0.5

由 `001_initial.sql` 实际加载后读取 PRAGMA 生成列/键/索引，再附明确业务语义。DDL 为可执行约束真源。

## 全局约定

- 所有 runtime ID 由后端生成 UUID；SQL 主要检查长度，API/内部 schema 校验完整格式。作者 E1/N01 等标识不混入 UUID。
- INTEGER 时间均毫秒；`*_at_ms` 为 UTC 技术时间，`*_mission_ms`/`mission_ms` 为任务时间。单调钟只在同进程解释。
- JSON 存 TEXT；SQL 只证明 JSON 合法和顶层类型，完整 schema/白名单/哈希/角色权限由服务层验证。
- `—` 默认值表示没有 DEFAULT，不表示自动填写空字符串；可空字段的 NULL 含义见语义。
- 主键成员即便 PRAGMA 未显式列 NOT NULL，也按 STRICT 主键非空解释。
- 所有业务 FK 均绑定同局 `(session_id,…)`；表间引用不得只凭第二个 UUID 查询。
- 表下列出索引与外键；所有 CHECK 和 trigger 的完整定义见迁移 SQL，文档不隐藏额外约束。

## schema_migrations

迁移账本。只追加，版本随交付包固定。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `version` | INTEGER | 否 | — | PK1 | 数据库迁移顺序版本，正整数 |
| `name` | TEXT | 否 | — | UQ | 数据库迁移稳定名称 |
| `applied_at_ms` | INTEGER | 否 | — | — | 迁移应用 UTC Unix 毫秒；初始设计脚本 0 表示离线基线，运行器另记真实部署记录 |

**外键**

无。

**索引 / 唯一键**

- UNIQUE `(name)`（SQLite 自动索引）。

**相关触发器**：`schema_migrations_immutable_delete`、`schema_migrations_immutable_update`。

## content_versions

隐藏世界/作者规则注册表。仅私有内容域；公共 UI 不可 SELECT *。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `content_version_id` | TEXT | 否 | — | UQ | 全局内容注册版本的不透明 UUID；公共 contentVersionId 与内部 RegistryPort 均使用此列，一对一映射私有 content_hash，不从 JSON 或哈希截取得出 |
| `content_hash` | TEXT | 否 | — | PK1 | 固定内容包的 SHA-256；包含世界定义与事件规则，绝不发给模型作为暗示 |
| `schema_version` | TEXT | 否 | — | — | 内容注册包所遵循的契约版本 |
| `registry_json` | TEXT | 否 | — | — | 私有内容注册包快照；应用须按 ContentRegistry 契约验证 |
| `created_at_ms` | INTEGER | 否 | — | — | 记录创建时 UTC Unix 毫秒；用于审计，不用于任务倒计时 |

**外键**

无。

**索引 / 唯一键**

- PRIMARY KEY `(content_hash)`（SQLite 自动索引）。
- UNIQUE `(content_version_id)`（SQLite 自动索引）。

**相关触发器**：`content_versions_immutable_delete`、`content_versions_immutable_update`。

## policy_profiles

规则与批准状态注册表。评审配置可用于 demo/test；normal 必须批准版本。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `policy_hash` | TEXT | 否 | — | PK1 | 局创建时绑定的不可变 policy 版本哈希 |
| `profile_id` | TEXT | 否 | — | UQ | 稳定 policy 名称；本版 SINGLE_PLAYER_REFERENCE |
| `profile_version` | INTEGER | 否 | — | UQ | 同名 policy 的递增版本；批准需要新增版本而不是改旧行 |
| `approval_status` | TEXT | 否 | — | — | review/approved/retired；仅 approved 可创建 normal 局 |
| `policy_json` | TEXT | 否 | — | — | 不可变 policy 完整配置；额度与参考规则从本行读取 |
| `created_at_ms` | INTEGER | 否 | — | — | 记录创建时 UTC Unix 毫秒；用于审计，不用于任务倒计时 |

**外键**

无。

**索引 / 唯一键**

- UNIQUE `(profile_id, profile_version)`（SQLite 自动索引）。
- PRIMARY KEY `(policy_hash)`（SQLite 自动索引）。

**相关触发器**：`policy_profiles_immutable_delete`、`policy_profiles_immutable_update`。

## launches

本机进程启动与授权上下文。没有联网账号或多人房间。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `launch_id` | TEXT | 否 | — | PK1 | 本机后端启动批次 UUID；创建局幂等与 bearer token 生命周期边界 |
| `token_hash` | TEXT | 否 | — | — | 本机临时 bearer token 的单向摘要；不保存明文 token，不进入导出或模型 |
| `started_at_ms` | INTEGER | 否 | — | — | 后端启动 UTC Unix 毫秒 |
| `ended_at_ms` | INTEGER | 是 | — | — | 启动批次结束 UTC Unix 毫秒；NULL 表示尚未登记结束 |

**外键**

无。

**索引 / 唯一键**

- PRIMARY KEY `(launch_id)`（SQLite 自动索引）。

**相关触发器**：无。

## sessions

局状态、时钟锚点与私有世界主行。SessionCoordinator 单写；公共视图使用 ProjectionService。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `run_epoch` | TEXT | 否 | — | UQ | 本次运行世代 UUID；旧窗口命令携带旧值时拒绝，原局不可续改世代 |
| `launch_id` | TEXT | 否 | — | FK | 本机后端启动批次 UUID；创建局幂等与 bearer token 生命周期边界 |
| `mode` | TEXT | 否 | — | — | 局方式 normal/demo/test；normal 的 policy 必须 approved，fixture 使用 test |
| `lifecycle` | TEXT | 否 | `'briefing'` | — | 局生命周期：briefing/running/completed/abandoned/interrupted |
| `phase` | TEXT | 否 | `'briefing'` | — | 局内部阶段：briefing/decision/coordinating/travelling/resolving/terminal |
| `scene_id` | TEXT | 是 | — | FK | 公开场景键 E1/E2/E3；与 session_id 组成引用边界 |
| `content_hash` | TEXT | 否 | — | FK | 固定内容包的 SHA-256；包含世界定义与事件规则，绝不发给模型作为暗示 |
| `policy_hash` | TEXT | 否 | — | FK | 局创建时绑定的不可变 policy 版本哈希 |
| `private_case_id` | TEXT | 否 | — | — | 隐藏预写世界变体键；仅 WorldEngine/私有内容域读取 |
| `state_version` | INTEGER | 否 | `0` | — | 有意义状态提交版本；同一命令/到期批次仅加一，画面帧及显示回执不递增 |
| `inbox_version` | INTEGER | 否 | `0` | — | 上传集合版本；仅成功新增上传批次递增，非卡片个数 |
| `assistant_context_version` | INTEGER | 否 | `0` | — | AI 实际允许输入改变才递增的上下文版本；私有时钟/生命/资源不触发 |
| `last_event_seq` | INTEGER | 否 | `0` | — | 本局内部事件最后序号；仅事件插入触发器推进 |
| `mission_ms` | INTEGER | 否 | `0` | — | 本局已落实的任务时间毫秒；服务器内部，不能直接进入 AdvisorInput |
| `anchor_monotonic_ms` | INTEGER | 是 | — | — | 本进程单调钟基准，供运行中计算未落实经过时间；重启不可继续解释 |
| `world_state_json` | TEXT | 否 | `'{}'` | — | WorldEngine 私有当前状态快照；API/AI 禁止直接序列化 |
| `terminal_seal_id` | TEXT | 是 | — | FK, UQ | 当前终局封存 UUID；仅 terminal lifecycle 非空 |
| `created_at_ms` | INTEGER | 否 | — | — | 记录创建时 UTC Unix 毫秒；用于审计，不用于任务倒计时 |
| `updated_at_ms` | INTEGER | 否 | — | — | 记录最后修改时 UTC Unix 毫秒 |

**外键**

- `(session_id, terminal_seal_id) → terminal_seals(session_id, seal_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, scene_id) → session_scenes(session_id, scene_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(policy_hash) → policy_profiles(policy_hash)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(content_hash) → content_versions(content_hash)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(launch_id) → launches(launch_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- UNIQUE `(session_id, terminal_seal_id)`（SQLite 自动索引）。
- UNIQUE `(session_id, run_epoch)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id)`（SQLite 自动索引）。

**相关触发器**：`sessions_insert_policy`、`sessions_no_delete`、`sessions_update_guard`。

## session_scenes

已知场景及局内顺序/进入关闭记录；跨场景重置只影响相应 scene 账户。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `scene_id` | TEXT | 否 | — | PK2 | 公开场景键 E1/E2/E3；与 session_id 组成引用边界 |
| `ordinal` | INTEGER | 否 | — | UQ | 场景顺序，局内唯一正整数 |
| `entered_mission_ms` | INTEGER | 是 | — | — | 实际进入场景的任务时刻；未进入为空 |
| `closed_mission_ms` | INTEGER | 是 | — | — | 场景关闭任务时刻；未关闭为空 |

**外键**

- `(session_id) → sessions(session_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- UNIQUE `(session_id, ordinal)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id, scene_id)`（SQLite 自动索引）。

**相关触发器**：`session_scenes_no_delete`、`session_scenes_terminal_insert`、`session_scenes_terminal_update`。

## actor_bindings

角色控制者映射，局内每角色唯一；不可变绑定防止客户端改角色越权。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `binding_id` | TEXT | 否 | — | PK2 | 本局已授权角色绑定 UUID；由服务端身份解析，不相信请求自报角色 |
| `role` | TEXT | 否 | — | UQ | 本局角色 commander/analyst/liaison；资源及可见域必须匹配 |
| `controller_kind` | TEXT | 否 | — | — | 角色由 human 或 npc 控制；参考单人局 commander=human，其余 npc |
| `created_at_ms` | INTEGER | 否 | — | — | 记录创建时 UTC Unix 毫秒；用于审计，不用于任务倒计时 |

**外键**

- `(session_id) → sessions(session_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- UNIQUE `(session_id, role)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id, binding_id)`（SQLite 自动索引）。

**相关触发器**：`actor_bindings_immutable_delete`、`actor_bindings_immutable_update`、`actor_bindings_terminal_insert`。

## launch_session_access

启动批次对局的访问授权；历史只读打开复用原角色 binding，不能新建行为主体或恢复运行。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `launch_id` | TEXT | 否 | — | PK1, FK | 本机后端启动批次 UUID；创建局幂等与 bearer token 生命周期边界 |
| `session_id` | TEXT | 否 | — | PK2, FK | 局 UUID；所有本局实体及查询的第一隔离键 |
| `binding_id` | TEXT | 否 | — | FK | 本局已授权角色绑定 UUID；由服务端身份解析，不相信请求自报角色 |
| `capability` | TEXT | 否 | — | PK3 | 本启动批次在该历史局获授的 commander.read/commander.command/evaluation.request/export.request 能力 |
| `granted_at_ms` | INTEGER | 否 | — | — | 创建访问授权的 UTC Unix 毫秒；终局可新增只读/评价/导出授权 |

**外键**

- `(session_id, binding_id) → actor_bindings(session_id, binding_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id) → sessions(session_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(launch_id) → launches(launch_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- PRIMARY KEY `(launch_id, session_id, capability)`（SQLite 自动索引）。

**相关触发器**：`access_grant_guard`、`access_grant_immutable_delete`、`access_grant_immutable_update`。

## session_creations

创建局幂等成功回执，键为 (launch,request)；防重试创建两局。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `launch_id` | TEXT | 否 | — | PK1, FK | 本机后端启动批次 UUID；创建局幂等与 bearer token 生命周期边界 |
| `request_id` | TEXT | 否 | — | PK2 | API Idempotency-Key UUID；命令/创建回执中的作用域由复合主键决定 |
| `payload_hash` | TEXT | 否 | — | — | 规范化创建接口方法/路径/请求体的 SHA-256；同 key 异摘要返回 409 |
| `session_id` | TEXT | 否 | — | FK, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `response_json` | TEXT | 否 | — | — | 当时接受命令的不可变 HTTP 响应 JSON；重试原样返回，不改写为当前视图 |
| `created_at_ms` | INTEGER | 否 | — | — | 记录创建时 UTC Unix 毫秒；用于审计，不用于任务倒计时 |

**外键**

- `(session_id) → sessions(session_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(launch_id) → launches(launch_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- PRIMARY KEY `(launch_id, request_id)`（SQLite 自动索引）。
- UNIQUE `(session_id)`（SQLite 自动索引）。

**相关触发器**：`session_creations_immutable_delete`、`session_creations_immutable_update`。

## commands

局内成功命令幂等回执，键为 (session,request)；仅持久化成功响应。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK | 局 UUID；所有本局实体及查询的第一隔离键 |
| `request_id` | TEXT | 否 | — | PK2 | API Idempotency-Key UUID；命令/创建回执中的作用域由复合主键决定 |
| `run_epoch` | TEXT | 否 | — | FK | 本次运行世代 UUID；旧窗口命令携带旧值时拒绝，原局不可续改世代 |
| `binding_id` | TEXT | 否 | — | FK | 本局已授权角色绑定 UUID；由服务端身份解析，不相信请求自报角色 |
| `command_kind` | TEXT | 否 | — | — | 内部规范操作名（如 task.create/upload.create）；加入幂等 payload 哈希 |
| `payload_hash` | TEXT | 否 | — | — | 规范化方法、路径、主体绑定、runEpoch、请求体的 SHA-256；同 key 异摘要返回 409 |
| `accepted_state_version` | INTEGER | 否 | — | — | 成功接受命令后的状态版本；回执属于这一历史提交 |
| `response_status` | INTEGER | 否 | — | — | 原成功 HTTP 状态 200/201/202/204 |
| `response_json` | TEXT | 否 | — | — | 当时接受命令的不可变 HTTP 响应 JSON；重试原样返回，不改写为当前视图 |
| `accepted_at_ms` | INTEGER | 否 | — | — | 接受命令的服务器 UTC Unix 毫秒 |

**外键**

- `(session_id, binding_id) → actor_bindings(session_id, binding_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, run_epoch) → sessions(session_id, run_epoch)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- PRIMARY KEY `(session_id, request_id)`（SQLite 自动索引）。

**相关触发器**：`commands_immutable_delete`、`commands_immutable_update`。

## events

内部游戏行为事件日志，严格连续 seq；它不是可直接发送的 SSE。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, IX 部分, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `seq` | INTEGER | 否 | — | PK2 | 内部事件严格连续序号，仅本局递增 |
| `event_id` | TEXT | 否 | — | UQ | 内部事件 UUID；同局唯一且可作为因果父事件引用 |
| `kind` | TEXT | 否 | — | — | 内部事件类型；完整封闭联合见 internal.schema.json，不依赖任意字符串拼接 |
| `mission_ms` | INTEGER | 否 | — | — | 本局已落实的任务时间毫秒；服务器内部，不能直接进入 AdvisorInput |
| `state_version` | INTEGER | 否 | — | — | 有意义状态提交版本；同一命令/到期批次仅加一，画面帧及显示回执不递增 |
| `actor_kind` | TEXT | 否 | — | — | human/npc/rules/system；模型结果发布归 system，不能伪装玩家 |
| `binding_id` | TEXT | 是 | — | FK | 本局已授权角色绑定 UUID；由服务端身份解析，不相信请求自报角色 |
| `request_id` | TEXT | 是 | — | IX 部分 | 关联触发此事件的 API 请求 UUID，可空；创建请求作用域为 launch，故不设统一 commands 外键 |
| `causation_id` | TEXT | 是 | — | FK | 直接因果父事件 UUID；为空表示无单一父事件，不能代替 request_id |
| `payload_json` | TEXT | 否 | — | — | InternalEvent.data；按 kind 匹配完整封闭 schema；不得原封公开 |
| `recorded_at_ms` | INTEGER | 否 | — | — | 事件/诊断入库 UTC Unix 毫秒 |

**外键**

- `(session_id, causation_id) → events(session_id, event_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, binding_id) → actor_bindings(session_id, binding_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id) → sessions(session_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- `CREATE INDEX ix_events_request ON events(session_id,request_id) WHERE request_id IS NOT NULL`
- UNIQUE `(session_id, event_id)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id, seq)`（SQLite 自动索引）。

**相关触发器**：`event_sequence`、`event_sequence_advance`、`events_immutable_delete`、`events_immutable_update`、`events_terminal_insert`。

## view_events

按角色过滤并重新编号的 SSE/回放日志；只装公开契约。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK | 局 UUID；所有本局实体及查询的第一隔离键 |
| `view_role` | TEXT | 否 | — | PK2 | 投影视角；view_events 仅三角色，public_records 还允许 all |
| `cursor` | INTEGER | 否 | — | PK3 | 本局且本视角连续游标；不能用内部 seq 暴露隐藏事件间隔 |
| `source_seq` | INTEGER | 否 | — | FK | 产生此记录的内部事件序号，必须同局 |
| `event_type` | TEXT | 否 | — | — | 公开 SSE 事件类别；与内部 kind 显式映射，不原样转发私有事件 |
| `public_payload_json` | TEXT | 否 | — | — | 明确白名单公开数据；底层私有定义、根源等不在此对象 |

**外键**

- `(session_id, source_seq) → events(session_id, seq)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- PRIMARY KEY `(session_id, view_role, cursor)`（SQLite 自动索引）。

**相关触发器**：`view_cursor`、`view_events_immutable_delete`、`view_events_immutable_update`。

## quota_accounts

余额投影。调查渠道整局一次建账；报告和上传按参考 profile 每场景建账。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, UQ 部分 | 局 UUID；所有本局实体及查询的第一隔离键 |
| `account_id` | TEXT | 否 | — | PK2 | 某局资源账户 UUID；固定 scope、角色、资源，不能靠更新扩容 |
| `quota_scope` | TEXT | 否 | — | — | 资源范围 session 或 scene；调查渠道必须 session，报告/上传当前参考为 scene |
| `scene_id` | TEXT | 是 | — | FK, UQ 部分 | 公开场景键 E1/E2/E3；与 session_id 组成引用边界 |
| `role` | TEXT | 否 | — | UQ 部分 | 本局角色 commander/analyst/liaison；资源及可见域必须匹配 |
| `resource` | TEXT | 否 | — | UQ 部分 | satellite/drone/localAgency/witness/report/upload |
| `capacity` | INTEGER | 否 | — | — | 账户初始总额；已确认渠道固定 2/3/3/2，报告/上传取本局 policy |
| `available` | INTEGER | 否 | — | — | 当前可用数量；只能由追加合法 ledger 触发更新 |
| `reserved` | INTEGER | 否 | `0` | — | 已预留尚未实际完成消耗数量；任务取消释放 |
| `spent` | INTEGER | 否 | `0` | — | 累计净消费；技术补偿 refund 可减少，离开场景不退款调查渠道 |
| `account_version` | INTEGER | 否 | `0` | — | 账本应用次数，等于该账户 ledger 行数，用于防重复/过期余额 |
| `last_entry_id` | TEXT | 是 | — | FK | 最后应用账本 UUID；账户更新必须由此新增账目证明 |

**外键**

- `(session_id, last_entry_id) → quota_ledger(session_id, entry_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, scene_id) → session_scenes(session_id, scene_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id) → sessions(session_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- `CREATE UNIQUE INDEX ux_quota_scene ON quota_accounts(session_id,scene_id,role,resource) WHERE quota_scope='scene'`
- `CREATE UNIQUE INDEX ux_quota_session ON quota_accounts(session_id,role,resource) WHERE quota_scope='session'`
- PRIMARY KEY `(session_id, account_id)`（SQLite 自动索引）。

**相关触发器**：`quota_account_initial`、`quota_account_mutation_guard`、`quota_accounts_no_delete`、`quota_accounts_terminal_insert`、`quota_accounts_terminal_update`。

## quota_ledger

资源与信息额度追加账本，原子驱动余额。补偿以新 refund 记录表示。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, IX 部分, IX, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `entry_id` | TEXT | 否 | — | PK2 | 账本追加记录 UUID；不可更新删除 |
| `account_id` | TEXT | 否 | — | FK, IX, UQ | 某局资源账户 UUID；固定 scope、角色、资源，不能靠更新扩容 |
| `operation_id` | TEXT | 否 | — | UQ | 本次账目幂等因果组 UUID；可取 command/task/release ID，不是 operations 表外键 |
| `entry_kind` | TEXT | 否 | — | UQ | reserve/spend/release/refund；状态变换由 CHECK 限定 |
| `source_bucket` | TEXT | 否 | — | UQ | available/reserved/spent；预留消费/释放必须有父记录 |
| `amount` | INTEGER | 否 | — | — | 该条正整数数量；0 或负数不能入账 |
| `delta_available` | INTEGER | 否 | — | — | 本次可用余额增量；必须匹配 entry_kind 与 amount |
| `delta_reserved` | INTEGER | 否 | — | — | 本次预留余额增量 |
| `delta_spent` | INTEGER | 否 | — | — | 本次已花费余额增量 |
| `account_version_before` | INTEGER | 否 | — | — | 本条入账前版本；必须等于当前账户版本 |
| `parent_entry_id` | TEXT | 是 | — | FK, IX 部分 | 预留的消费/释放指向 reserve；退款指向 spend；禁止超出父金额 |
| `reason_code` | TEXT | 否 | — | — | 服务器定义的入账原因码；玩家不能自行创建技术退款 |
| `mission_ms` | INTEGER | 否 | — | — | 本局已落实的任务时间毫秒；服务器内部，不能直接进入 AdvisorInput |
| `created_at_ms` | INTEGER | 否 | — | IX | 记录创建时 UTC Unix 毫秒；用于审计，不用于任务倒计时 |

**外键**

- `(session_id, parent_entry_id) → quota_ledger(session_id, entry_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, account_id) → quota_accounts(session_id, account_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- `CREATE INDEX ix_ledger_parent ON quota_ledger(session_id,parent_entry_id) WHERE parent_entry_id IS NOT NULL`
- `CREATE INDEX ix_ledger_account ON quota_ledger(session_id,account_id,created_at_ms)`
- UNIQUE `(session_id, operation_id, account_id, entry_kind, source_bucket)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id, entry_id)`（SQLite 自动索引）。

**相关触发器**：`quota_apply`、`quota_ledger_guard`、`quota_ledger_immutable_delete`、`quota_ledger_immutable_update`、`quota_ledger_terminal_insert`。

## task_requests

指挥官任务与 NPC 接受/交付状态；每岗最多一个活跃任务，包括 request_report。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, IX 部分, UQ 部分, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `task_id` | TEXT | 否 | — | PK2 | 指挥官给某一调查岗位的任务 UUID |
| `scene_id` | TEXT | 否 | — | FK | 公开场景键 E1/E2/E3；与 session_id 组成引用边界 |
| `commander_binding_id` | TEXT | 否 | — | FK | 授权发起任务的 commander 绑定 |
| `target_role` | TEXT | 否 | — | UQ 部分 | 任务接收岗位 analyst 或 liaison；不是客户端权限角色 |
| `task_kind` | TEXT | 否 | — | — | investigate_and_report 或 request_report |
| `topic_id` | TEXT | 否 | — | — | 公开议题键；NPC 按公开议题/优先级/获取顺序选卡 |
| `target_id` | TEXT | 否 | — | — | 公开调查目标键；不能传入私有证据定义 ID |
| `option_id` | TEXT | 是 | — | — | 已校验的调查选项键；request_report 为 NULL |
| `status` | TEXT | 否 | `'accepted'` | — | 实体状态；枚举与转移约束按本表 CHECK/trigger 限定 |
| `report_reservation_id` | TEXT | 否 | — | FK, UQ | 为本任务单独预留的一格报告额度；不得被另一任务共用 |
| `accepted_mission_ms` | INTEGER | 否 | — | — | 此任务/操作正式接受时的任务时刻 |
| `due_mission_ms` | INTEGER | 否 | — | IX 部分 | 此任务/调查/操作应完成的任务时刻；实时经过抵达，不再额外扣 authored duration |
| `created_at_ms` | INTEGER | 否 | — | — | 记录创建时 UTC Unix 毫秒；用于审计，不用于任务倒计时 |
| `completed_at_ms` | INTEGER | 是 | — | — | 终态提交 UTC Unix 毫秒；活跃状态为空 |
| `failure_code` | TEXT | 是 | — | — | 取消/失败的结构化原因；正常完成一般为空 |

**外键**

- `(session_id, report_reservation_id) → quota_ledger(session_id, entry_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, commander_binding_id) → actor_bindings(session_id, binding_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, scene_id) → session_scenes(session_id, scene_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- `CREATE INDEX ix_task_due ON task_requests(session_id,due_mission_ms) WHERE status IN ('accepted','running')`
- `CREATE UNIQUE INDEX ux_task_active_role ON task_requests(session_id,target_role) WHERE status IN ('accepted','running')`
- UNIQUE `(session_id, report_reservation_id)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id, task_id)`（SQLite 自动索引）。

**相关触发器**：`task_authorization`、`task_payload_immutable`、`task_requests_no_delete`、`task_requests_status_guard`、`task_requests_terminal_insert`、`task_requests_terminal_update`。

## investigations

真实观察作业，渠道先扣额，到期才产出证据；两岗可并行。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, IX 部分, UQ 部分, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `investigation_id` | TEXT | 否 | — | PK2 | 真实观察过程 UUID；不同于接受任务/上报动作 |
| `task_id` | TEXT | 否 | — | FK, UQ | 指挥官给某一调查岗位的任务 UUID |
| `scene_id` | TEXT | 否 | — | FK | 公开场景键 E1/E2/E3；与 session_id 组成引用边界 |
| `role` | TEXT | 否 | — | UQ 部分 | 本局角色 commander/analyst/liaison；资源及可见域必须匹配 |
| `option_id` | TEXT | 否 | — | — | 已校验的调查选项键；request_report 为 NULL |
| `resource_key` | TEXT | 否 | — | — | 本次观察实际消耗渠道；溯源由 authored traceCostChannel 指定 |
| `resource_charge_id` | TEXT | 否 | — | FK, UQ | 已扣调查渠道账本行；每次调查专用，不能重复引用免费观察 |
| `status` | TEXT | 否 | `'running'` | — | 实体状态；枚举与转移约束按本表 CHECK/trigger 限定 |
| `accepted_mission_ms` | INTEGER | 否 | — | — | 此任务/操作正式接受时的任务时刻 |
| `due_mission_ms` | INTEGER | 否 | — | IX 部分 | 此任务/调查/操作应完成的任务时刻；实时经过抵达，不再额外扣 authored duration |
| `finished_mission_ms` | INTEGER | 是 | — | — | 调查在任务时钟上的结算时刻；终态非空 |
| `failure_code` | TEXT | 是 | — | — | 取消/失败的结构化原因；正常完成一般为空 |

**外键**

- `(session_id, resource_charge_id) → quota_ledger(session_id, entry_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, scene_id) → session_scenes(session_id, scene_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, task_id) → task_requests(session_id, task_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- `CREATE INDEX ix_investigation_due ON investigations(session_id,due_mission_ms) WHERE status IN ('queued','running')`
- `CREATE UNIQUE INDEX ux_investigation_active_role ON investigations(session_id,role) WHERE status IN ('queued','running')`
- UNIQUE `(session_id, resource_charge_id)`（SQLite 自动索引）。
- UNIQUE `(session_id, task_id)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id, investigation_id)`（SQLite 自动索引）。

**相关触发器**：`investigation_authorization`、`investigation_payload_immutable`、`investigations_no_delete`、`investigations_status_guard`、`investigations_terminal_insert`、`investigations_terminal_update`。

## operations

行进或原地等待作业，单局一个活跃操作；路线已由 WorldEngine 解析。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, UQ 部分 | 局 UUID；所有本局实体及查询的第一隔离键 |
| `operation_id` | TEXT | 否 | — | PK2 | 操作 UUID；在业务操作表为主键，账本中表示本次入账的幂等因果组 |
| `scene_id` | TEXT | 否 | — | FK | 公开场景键 E1/E2/E3；与 session_id 组成引用边界 |
| `operation_kind` | TEXT | 否 | — | — | action 为行进/路线操作；wait 为原场景等待 |
| `action_id` | TEXT | 否 | — | — | 当前场景已授权动作键；服务端由此导出路线 |
| `status` | TEXT | 否 | `'accepted'` | — | 实体状态；枚举与转移约束按本表 CHECK/trigger 限定 |
| `private_plan_json` | TEXT | 否 | — | — | WorldEngine 已解析的完整路线、阶段及效果计划；前端不能指定跳过路线 |
| `public_progress_json` | TEXT | 否 | — | — | 允许前端展示的行进/等待进度；不承载私有路线结果 |
| `accepted_mission_ms` | INTEGER | 否 | — | — | 此任务/操作正式接受时的任务时刻 |
| `due_mission_ms` | INTEGER | 否 | — | — | 此任务/调查/操作应完成的任务时刻；实时经过抵达，不再额外扣 authored duration |
| `created_at_ms` | INTEGER | 否 | — | — | 记录创建时 UTC Unix 毫秒；用于审计，不用于任务倒计时 |
| `completed_at_ms` | INTEGER | 是 | — | — | 终态提交 UTC Unix 毫秒；活跃状态为空 |

**外键**

- `(session_id, scene_id) → session_scenes(session_id, scene_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- `CREATE UNIQUE INDEX ux_operation_active ON operations(session_id) WHERE status IN ('accepted','running')`
- PRIMARY KEY `(session_id, operation_id)`（SQLite 自动索引）。

**相关触发器**：`operation_payload_immutable`、`operations_no_delete`、`operations_status_guard`、`operations_terminal_insert`、`operations_terminal_update`。

## evidence_instances

角色库存信息域。获得证据不等于 commander 已收到，也不等于 Advisor 已上传。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, IX | 局 UUID；所有本局实体及查询的第一隔离键 |
| `instance_id` | TEXT | 否 | — | PK2 | 已获得的具体证据实例 UUID；私有模板 ID 另存 |
| `revision` | INTEGER | 否 | — | PK3 | 正整数版本；更正产生新记录并明确链接旧版本，不能覆写旧文案 |
| `scene_id` | TEXT | 否 | — | FK, IX | 公开场景键 E1/E2/E3；与 session_id 组成引用边界 |
| `owner_role` | TEXT | 否 | — | IX | 此证据实际进入的分析/联络库存；不代表已上报给 commander |
| `private_definition_id` | TEXT | 否 | — | — | 内容作者的私有证据模板键；禁止进入公共卡片或 AI |
| `observation_type` | TEXT | 否 | — | — | directObservation/reportedStatement/provenanceFinding/historicalRecord |
| `acquired_mission_ms` | INTEGER | 否 | — | IX | 角色实际获得证据时刻；调查来源不能早于观察完成 |
| `observed_mission_ms` | INTEGER | 是 | — | — | 被观察现象本身发生时刻，可未知；与获取时刻不同 |
| `acquisition_investigation_id` | TEXT | 是 | — | FK | 产生此卡的观察过程 UUID；NULL 仅允许作者定义预置资料，由应用校验 |
| `supersedes_instance_id` | TEXT | 是 | — | FK | 更正/后续版本被取代的旧证据实例 UUID；无更正为空 |
| `supersedes_revision` | INTEGER | 是 | — | FK | 旧证据版本；与 supersedes_instance_id 同时为空或非空 |
| `public_payload_json` | TEXT | 否 | — | — | 明确白名单公开数据；底层私有定义、根源等不在此对象 |
| `payload_hash` | TEXT | 否 | — | — | 公共证据快照规范化摘要；与上报快照字节共同验证 |

**外键**

- `(session_id, supersedes_instance_id, supersedes_revision) → evidence_instances(session_id, instance_id, revision)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, acquisition_investigation_id) → investigations(session_id, investigation_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, scene_id) → session_scenes(session_id, scene_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- `CREATE INDEX ix_evidence_inventory ON evidence_instances(session_id,owner_role,scene_id,acquired_mission_ms)`
- PRIMARY KEY `(session_id, instance_id, revision)`（SQLite 自动索引）。

**相关触发器**：`evidence_acquisition_guard`、`evidence_instances_immutable_delete`、`evidence_instances_immutable_update`、`evidence_instances_terminal_insert`。

## provenance_disclosures

实际获得的溯源知识；不储存为隐蔽真实 root 的公开捷径。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK | 局 UUID；所有本局实体及查询的第一隔离键 |
| `finding_id` | TEXT | 否 | — | PK2 | 一次获知溯源关系的 UUID；不代表全局真实根源自动公开 |
| `evidence_instance_id` | TEXT | 否 | — | FK | 承载该关系发现的证据实例 UUID |
| `evidence_revision` | INTEGER | 否 | — | FK | 承载关系发现的证据版本 |
| `subject_instance_id` | TEXT | 否 | — | FK | 溯源关系所讨论的另一证据实例 UUID |
| `subject_revision` | INTEGER | 否 | — | FK | 被讨论证据版本 |
| `relation_type` | TEXT | 否 | — | — | 已授权公开的来源身份/一手转述/同源/内容印证关系类型 |
| `verification_state` | TEXT | 否 | — | — | unknown/reported/hypothesized/verified；仅规则验证可升级已核实 |
| `public_relation_json` | TEXT | 否 | — | — | 角色实际获得的关系措辞与可引用证据；不能复制私有 rootSource |

**外键**

- `(session_id, subject_instance_id, subject_revision) → evidence_instances(session_id, instance_id, revision)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, evidence_instance_id, evidence_revision) → evidence_instances(session_id, instance_id, revision)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- PRIMARY KEY `(session_id, finding_id)`（SQLite 自动索引）。

**相关触发器**：`provenance_disclosures_immutable_delete`、`provenance_disclosures_immutable_update`、`provenance_disclosures_terminal_insert`。

## reports

岗位→指挥官的不可变卡片快照。原版本不改，新版本另付一次额度。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, IX, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `report_id` | TEXT | 否 | — | PK2, UQ | 一次不可变上报 UUID；公共 refs 的合法来源 |
| `scene_id` | TEXT | 否 | — | FK, IX, UQ | 公开场景键 E1/E2/E3；与 session_id 组成引用边界 |
| `sender_role` | TEXT | 否 | — | — | 上报角色 analyst/liaison；与证据 owner 和实际 binding 一致 |
| `source_instance_id` | TEXT | 否 | — | FK, UQ | 报告引用的证据实例 UUID |
| `source_revision` | INTEGER | 否 | — | FK, UQ | 报告所固化证据版本；公共 ReportView.revision 映射此字段 |
| `actor_binding_id` | TEXT | 否 | — | FK | 真正发送报告的本局 NPC/人员角色绑定 |
| `task_id` | TEXT | 是 | — | FK, UQ | 指挥官给某一调查岗位的任务 UUID |
| `charge_entry_id` | TEXT | 否 | — | FK, IX | 本记录使用的报告/上传消费账本；记录数量不得超过其 amount |
| `reported_mission_ms` | INTEGER | 否 | — | IX | 报告确实进入 commander 信息域的任务时刻 |
| `immutable_payload_json` | TEXT | 否 | — | — | 上报时逐字节复制的证据公共卡片快照 |
| `immutable_payload_hash` | TEXT | 否 | — | — | 上述卡片快照 SHA-256；与源证据相同 |

**外键**

- `(session_id, charge_entry_id) → quota_ledger(session_id, entry_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, task_id) → task_requests(session_id, task_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, actor_binding_id) → actor_bindings(session_id, binding_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, source_instance_id, source_revision) → evidence_instances(session_id, instance_id, revision)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, scene_id) → session_scenes(session_id, scene_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- `CREATE INDEX ix_reports_commander ON reports(session_id,scene_id,reported_mission_ms)`
- `CREATE INDEX ix_reports_charge ON reports(session_id,charge_entry_id)`
- UNIQUE `(session_id, task_id)`（SQLite 自动索引）。
- UNIQUE `(session_id, report_id, source_revision)`（SQLite 自动索引）。
- UNIQUE `(session_id, scene_id, source_instance_id, source_revision)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id, report_id)`（SQLite 自动索引）。

**相关触发器**：`report_guard`、`reports_immutable_delete`、`reports_immutable_update`、`reports_terminal_insert`。

## uploads

指挥官→Advisor 的明确授权记录；引用已收到且同场景的报告。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, IX, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `upload_id` | TEXT | 否 | — | PK2 | 一次经 commander 授权的上传 UUID |
| `scene_id` | TEXT | 否 | — | FK, UQ | 公开场景键 E1/E2/E3；与 session_id 组成引用边界 |
| `report_id` | TEXT | 否 | — | FK, UQ | 一次不可变上报 UUID；公共 refs 的合法来源 |
| `report_revision` | INTEGER | 否 | — | FK, UQ | 本次上传引用的报告所对应证据版本 |
| `charge_entry_id` | TEXT | 否 | — | FK, IX | 本记录使用的报告/上传消费账本；记录数量不得超过其 amount |
| `authorization_binding_id` | TEXT | 否 | — | FK | 批准上传的 commander 绑定 |
| `uploaded_mission_ms` | INTEGER | 否 | — | — | 卡片真正进入 Advisor 允许输入域的任务时刻；不作为模型输入 |

**外键**

- `(session_id, authorization_binding_id) → actor_bindings(session_id, binding_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, charge_entry_id) → quota_ledger(session_id, entry_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, report_id, report_revision) → reports(session_id, report_id, source_revision)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, scene_id) → session_scenes(session_id, scene_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- `CREATE INDEX ix_uploads_charge ON uploads(session_id,charge_entry_id)`
- UNIQUE `(session_id, scene_id, report_id, report_revision)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id, upload_id)`（SQLite 自动索引）。

**相关触发器**：`upload_guard`、`uploads_immutable_delete`、`uploads_immutable_update`、`uploads_terminal_insert`。

## input_manifests

完整冻结 AI 允许输入；子清单先写、父行最后写封口，单事务提交。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `manifest_id` | TEXT | 否 | — | PK2 | 一次冻结的 Advisor 允许输入清单 UUID |
| `scene_id` | TEXT | 否 | — | FK, UQ | 公开场景键 E1/E2/E3；与 session_id 组成引用边界 |
| `inbox_version` | INTEGER | 否 | — | — | 上传集合版本；仅成功新增上传批次递增，非卡片个数 |
| `context_version` | INTEGER | 否 | — | UQ | 该 manifest/job 的 assistantContextVersion；只描述允许输入变化 |
| `context_epoch` | TEXT | 否 | — | — | 当前场景语义上下文世代 UUID；用于阻断旧场景结果误发布 |
| `background_hash` | TEXT | 否 | — | — | 获批背景知识包版本哈希，不是隐蔽真相哈希 |
| `input_hash` | TEXT | 否 | — | — | 规范化完整允许模型输入的 SHA-256；用于缓存和结果归属 |
| `permitted_input_json` | TEXT | 否 | — | — | 已经白名单构建并 schema 校验的完整 AdvisorInput；禁止时间/资源/伤员/未上传列表 |
| `created_at_ms` | INTEGER | 否 | — | — | 记录创建时 UTC Unix 毫秒；用于审计，不用于任务倒计时 |

**外键**

- `(session_id, scene_id) → session_scenes(session_id, scene_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- UNIQUE `(session_id, scene_id, context_version)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id, manifest_id)`（SQLite 自动索引）。

**相关触发器**：`input_manifests_immutable_delete`、`input_manifests_immutable_update`、`input_manifests_terminal_insert`、`manifest_finalize`。

## input_manifest_members

manifest 的具体上传成员；不能指向未上传卡，完成后不可补成员。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK | 局 UUID；所有本局实体及查询的第一隔离键 |
| `manifest_id` | TEXT | 否 | — | PK2, FK | 一次冻结的 Advisor 允许输入清单 UUID |
| `upload_id` | TEXT | 否 | — | PK3, FK | 一次经 commander 授权的上传 UUID |

**外键**

- `(session_id, upload_id) → uploads(session_id, upload_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, manifest_id) → input_manifests(session_id, manifest_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- PRIMARY KEY `(session_id, manifest_id, upload_id)`（SQLite 自动索引）。

**相关触发器**：`input_manifest_members_immutable_delete`、`input_manifest_members_immutable_update`、`input_manifest_members_terminal_insert`、`manifest_members_before_seal`。

## player_statements

玩家明确提交的未核验陈述，来源身份不会伪装为系统观测。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK | 局 UUID；所有本局实体及查询的第一隔离键 |
| `statement_id` | TEXT | 否 | — | PK2 | 玩家明确上传的未核验陈述 UUID |
| `scene_id` | TEXT | 否 | — | FK | 公开场景键 E1/E2/E3；与 session_id 组成引用边界 |
| `binding_id` | TEXT | 否 | — | FK | 本局已授权角色绑定 UUID；由服务端身份解析，不相信请求自报角色 |
| `statement_text` | TEXT | 否 | — | — | 玩家原文陈述，1–2000 字符；必须按未核验数据处理 |
| `trust` | TEXT | 否 | `'unverified'` | — | 固定 unverified；不允许更新成 verified |
| `created_mission_ms` | INTEGER | 否 | — | — | 该玩家陈述被服务端接受的任务时刻 |

**外键**

- `(session_id, binding_id) → actor_bindings(session_id, binding_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, scene_id) → session_scenes(session_id, scene_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- PRIMARY KEY `(session_id, statement_id)`（SQLite 自动索引）。

**相关触发器**：`player_statement_commander`、`player_statements_immutable_delete`、`player_statements_immutable_update`、`player_statements_terminal_insert`。

## manifest_statements

本次模型输入真正包含的陈述引用；不能自动把聊天全量混入。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK | 局 UUID；所有本局实体及查询的第一隔离键 |
| `manifest_id` | TEXT | 否 | — | PK2, FK | 一次冻结的 Advisor 允许输入清单 UUID |
| `statement_id` | TEXT | 否 | — | PK3, FK | 玩家明确上传的未核验陈述 UUID |

**外键**

- `(session_id, statement_id) → player_statements(session_id, statement_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, manifest_id) → input_manifests(session_id, manifest_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- PRIMARY KEY `(session_id, manifest_id, statement_id)`（SQLite 自动索引）。

**相关触发器**：`manifest_statements_before_seal`、`manifest_statements_immutable_delete`、`manifest_statements_immutable_update`、`manifest_statements_terminal_insert`。

## agent_jobs

逻辑 Agent 工作与不可变输入绑定。status=queued/running/succeeded/fallback/failed/cancelled/superseded；mode=live_model/offline_template。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, UQ 部分 | 局 UUID；所有本局实体及查询的第一隔离键 |
| `job_id` | TEXT | 否 | — | PK2 | 逻辑模型工作 UUID；恢复重试复用同一个 job，不增调用上限 |
| `agent_role` | TEXT | 否 | — | — | advisor 或 evaluator；两者隔离输入、上下文、权限与结果 |
| `scene_id` | TEXT | 是 | — | FK, UQ 部分 | 公开场景键 E1/E2/E3；与 session_id 组成引用边界 |
| `manifest_id` | TEXT | 是 | — | FK | 一次冻结的 Advisor 允许输入清单 UUID |
| `seal_hash` | TEXT | 是 | — | FK, UQ 部分 | Evaluator 绑定的同局终局封存哈希；Advisor 必须 NULL |
| `status` | TEXT | 否 | `'queued'` | IX 部分 | 实体状态；枚举与转移约束按本表 CHECK/trigger 限定 |
| `mode` | TEXT | 否 | — | — | 本次结果路径 live_model/offline_template；离线不能伪装模型结果 |
| `input_hash` | TEXT | 否 | — | UQ 部分 | 规范化完整允许模型输入的 SHA-256；用于缓存和结果归属 |
| `config_hash` | TEXT | 否 | — | UQ 部分 | 模型、提示词、schema、工具、guardrail、规则配置规范化摘要 |
| `input_version` | INTEGER | 否 | — | — | 公开 AgentJobView 输入版本；Advisor 取允许上下文版本，Evaluator 固定事实版本 1 |
| `inbox_version` | INTEGER | 是 | — | — | 上传集合版本；仅成功新增上传批次递增，非卡片个数 |
| `context_version` | INTEGER | 是 | — | UQ 部分 | 该 manifest/job 的 assistantContextVersion；只描述允许输入变化 |
| `evaluator_input_json` | TEXT | 是 | — | — | 独立事实生成器的白名单 EvaluatorInput；不得含 Outcome、私有真相或实时 Advisor 内存 |
| `max_attempts` | INTEGER | 否 | `2` | — | 最多实际尝试次数，默认 2 且范围 1–2；恢复不能重置 |
| `deadline_at_ms` | INTEGER | 否 | — | IX 部分 | 技术调用截止 UTC 毫秒；不传给 Advisor，不改变任务倒计时 |
| `result_json` | TEXT | 是 | — | — | 通过相应输出校验的结果或明确离线模板；状态 succeeded/fallback 必须非空 |
| `error_code` | TEXT | 是 | — | — | 稳定技术失败码；不给玩家泄露供应商密钥或隐藏世界 |
| `created_at_ms` | INTEGER | 否 | — | — | 记录创建时 UTC Unix 毫秒；用于审计，不用于任务倒计时 |
| `updated_at_ms` | INTEGER | 否 | — | — | 记录最后修改时 UTC Unix 毫秒 |

**外键**

- `(session_id, seal_hash) → terminal_seals(session_id, sealed_hash)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, manifest_id) → input_manifests(session_id, manifest_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, scene_id) → session_scenes(session_id, scene_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id) → sessions(session_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- `CREATE INDEX ix_agent_jobs_dispatch ON agent_jobs(status,deadline_at_ms) WHERE status IN ('queued','running')`
- `CREATE UNIQUE INDEX ux_evaluator_active ON agent_jobs(session_id,seal_hash,config_hash) WHERE agent_role='evaluator' AND status IN ('queued','running')`
- `CREATE UNIQUE INDEX ux_advisor_active ON agent_jobs(session_id) WHERE agent_role='advisor' AND status IN ('queued','running')`
- `CREATE UNIQUE INDEX ux_evaluator_seal_config ON agent_jobs(session_id,seal_hash,config_hash) WHERE agent_role='evaluator'`
- `CREATE UNIQUE INDEX ux_advisor_input ON agent_jobs(session_id,scene_id,context_version,input_hash,config_hash) WHERE agent_role='advisor'`
- PRIMARY KEY `(session_id, job_id)`（SQLite 自动索引）。

**相关触发器**：`agent_job_input_guard`、`agent_job_update_guard`、`agent_jobs_no_delete`。

## agent_attempts

真实模型请求次数、计费与技术终态。sending/running/succeeded/failed/timeout/unknown；先记账后联网。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, UQ 部分 | 局 UUID；所有本局实体及查询的第一隔离键 |
| `job_id` | TEXT | 否 | — | PK2, FK, UQ 部分 | 逻辑模型工作 UUID；恢复重试复用同一个 job，不增调用上限 |
| `attempt_no` | INTEGER | 否 | — | PK3 | 某 job 的实际请求序号，从 1 连续递增；最多 max_attempts |
| `request_key` | TEXT | 否 | — | UQ | 向模型供应商发起该尝试的独立 UUID；全局唯一 |
| `status` | TEXT | 否 | `'sending'` | — | 实体状态；枚举与转移约束按本表 CHECK/trigger 限定 |
| `sent_at_ms` | INTEGER | 否 | — | — | sending 先持久化占额时刻；网络调用必须在事务 COMMIT 以后 |
| `finished_at_ms` | INTEGER | 是 | — | — | 本次尝试成为终态的 UTC 毫秒；unknown 同样是终态 |
| `provider_request_id` | TEXT | 是 | — | — | 供应商返回的请求标识，未知时为空；仅技术诊断使用 |
| `input_tokens` | INTEGER | 是 | — | — | 供应商确认输入 token；NULL 表示未知，不能冒填 0 |
| `output_tokens` | INTEGER | 是 | — | — | 供应商确认的输出 token 数 |
| `billed_microunits` | INTEGER | 是 | — | — | 已确认费用微单位；未知 NULL；货币/计价语义由 config 固定 |
| `error_code` | TEXT | 是 | — | — | 稳定技术失败码；不给玩家泄露供应商密钥或隐藏世界 |
| `response_hash` | TEXT | 是 | — | — | 原供应商响应经留存策略处理后的摘要；不直接公开原文本 |

**外键**

- `(session_id, job_id) → agent_jobs(session_id, job_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- `CREATE UNIQUE INDEX ux_attempt_active ON agent_attempts(session_id,job_id) WHERE status IN ('sending','running')`
- UNIQUE `(request_key)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id, job_id, attempt_no)`（SQLite 自动索引）。

**相关触发器**：`agent_attempts_no_delete`、`attempt_insert_guard`、`attempt_update_guard`。

## public_records

用于展示和 FactBuilder 引用的公开记录；与内部事件分开。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK | 局 UUID；所有本局实体及查询的第一隔离键 |
| `public_record_id` | TEXT | 否 | — | PK2 | 可以被展示/打开/引用的不可变投影记录 UUID |
| `revision` | INTEGER | 否 | — | PK3 | 正整数版本；更正产生新记录并明确链接旧版本，不能覆写旧文案 |
| `view_role` | TEXT | 否 | — | — | 投影视角；view_events 仅三角色，public_records 还允许 all |
| `record_kind` | TEXT | 否 | — | — | report/advice/briefing/sceneFeedback |
| `source_seq` | INTEGER | 否 | — | FK | 产生此记录的内部事件序号，必须同局 |
| `public_payload_json` | TEXT | 否 | — | — | 明确白名单公开数据；底层私有定义、根源等不在此对象 |

**外键**

- `(session_id, source_seq) → events(session_id, seq)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id) → sessions(session_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- PRIMARY KEY `(session_id, public_record_id, revision)`（SQLite 自动索引）。

**相关触发器**：`public_records_immutable_delete`、`public_records_immutable_update`、`public_records_terminal_insert`。

## display_receipts

客户端展示事件的服务器收据；不能证明阅读理解，只证明相应展示行为被收到。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `receipt_id` | TEXT | 否 | — | PK2 | 显示行为回执 UUID，服务器接收时间与日志顺序为准 |
| `binding_id` | TEXT | 否 | — | FK, UQ | 本局已授权角色绑定 UUID；由服务端身份解析，不相信请求自报角色 |
| `public_record_id` | TEXT | 否 | — | FK, UQ | 可以被展示/打开/引用的不可变投影记录 UUID |
| `record_revision` | INTEGER | 否 | — | FK, UQ | 被展示的 public_records 固定版本 |
| `receipt_kind` | TEXT | 否 | — | UQ | displayed/opened/usedInReason；可见、打开、使用三种事实不互相推断 |
| `recorded_mission_ms` | INTEGER | 否 | — | — | 服务端收到回执时采样的任务时刻；客户端不能回填过去 |
| `received_at_ms` | INTEGER | 否 | — | — | 服务端接收回执 UTC 毫秒 |

**外键**

- `(session_id, public_record_id, record_revision) → public_records(session_id, public_record_id, revision)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, binding_id) → actor_bindings(session_id, binding_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- UNIQUE `(session_id, binding_id, public_record_id, record_revision, receipt_kind)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id, receipt_id)`（SQLite 自动索引）。

**相关触发器**：`display_owner_guard`、`display_receipts_immutable_delete`、`display_receipts_immutable_update`、`display_receipts_terminal_insert`。

## decision_snapshots

各次决策/岗位选择的信息截面，阻止评价事后全知。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK | 局 UUID；所有本局实体及查询的第一隔离键 |
| `snapshot_id` | TEXT | 否 | — | PK2 | 一次决策/岗位选择当时的信息截面 UUID |
| `scene_id` | TEXT | 否 | — | FK | 公开场景键 E1/E2/E3；与 session_id 组成引用边界 |
| `binding_id` | TEXT | 否 | — | FK | 本局已授权角色绑定 UUID；由服务端身份解析，不相信请求自报角色 |
| `snapshot_kind` | TEXT | 否 | — | — | task/investigation/report/upload/action；FactBuilder 使用相应规则 |
| `source_seq` | INTEGER | 否 | — | FK | 产生此记录的内部事件序号，必须同局 |
| `mission_ms` | INTEGER | 否 | — | — | 本局已落实的任务时间毫秒；服务器内部，不能直接进入 AdvisorInput |
| `state_version` | INTEGER | 否 | — | — | 有意义状态提交版本；同一命令/到期批次仅加一，画面帧及显示回执不递增 |
| `snapshot_hash` | TEXT | 否 | — | — | 不可变决策截面规范化摘要 |
| `snapshot_json` | TEXT | 否 | — | — | 当时可见记录、已上传引用、所选动作/理由等白名单事实；不含事后结局反推 |

**外键**

- `(session_id, source_seq) → events(session_id, seq)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, binding_id) → actor_bindings(session_id, binding_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, scene_id) → session_scenes(session_id, scene_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- PRIMARY KEY `(session_id, snapshot_id)`（SQLite 自动索引）。

**相关触发器**：`decision_snapshots_immutable_delete`、`decision_snapshots_immutable_update`、`decision_snapshots_terminal_insert`。

## terminal_seals

不可逆游戏终止屏障。与 session 激活互相 deferred FK；后续评价不修改这里。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `seal_id` | TEXT | 否 | — | PK2, FK | 终局封存记录 UUID；与 sessions.terminal_seal_id 必须同事务激活 |
| `sealed_hash` | TEXT | 否 | — | UQ | 终局核心内容规范化 SHA-256；评价和导出以此绑定固定事实 |
| `terminal_lifecycle` | TEXT | 否 | — | — | 本次终止原因 completed/abandoned/interrupted |
| `terminal_seq` | INTEGER | 否 | — | FK | 封存包含的最后内部行为事件序号 |
| `terminal_state_version` | INTEGER | 否 | — | — | 封存所对应终局状态版本 |
| `terminal_mission_ms` | INTEGER | 否 | — | — | 游戏结束时已经落实的任务时刻 |
| `outcome_json` | TEXT | 否 | — | — | 单独展示的任务结果；OutcomeRenderer 使用，禁止 Evaluator 读取 |
| `immutable_behavior_json` | TEXT | 否 | — | — | 封存内行为证据集合，评价输入还须再次白名单投影 |
| `content_hash` | TEXT | 否 | — | FK | 固定内容包的 SHA-256；包含世界定义与事件规则，绝不发给模型作为暗示 |
| `policy_hash` | TEXT | 否 | — | FK | 局创建时绑定的不可变 policy 版本哈希 |
| `sealed_at_ms` | INTEGER | 否 | — | — | 封存 UTC Unix 毫秒 |

**外键**

- `(session_id, seal_id) → sessions(session_id, terminal_seal_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, terminal_seq) → events(session_id, seq)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(policy_hash) → policy_profiles(policy_hash)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(content_hash) → content_versions(content_hash)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id) → sessions(session_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- UNIQUE `(session_id, sealed_hash)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id, seal_id)`（SQLite 自动索引）。
- UNIQUE `(session_id)`（SQLite 自动索引）。

**相关触发器**：`terminal_seal_guard`、`terminal_seals_immutable_delete`、`terminal_seals_immutable_update`。

## behavior_facts

封存后由确定性规则生成的事实，按主体/上下文/规则唯一。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `fact_id` | TEXT | 否 | — | PK2 | 规则生成的行为事实 UUID；不是模型自行猜测的事实 |
| `seal_hash` | TEXT | 否 | — | FK, UQ | Evaluator 绑定的同局终局封存哈希；Advisor 必须 NULL |
| `context_id` | TEXT | 否 | — | FK, UQ | 对应 decision_snapshots.snapshot_id；固定当时信息截面 |
| `rule_id` | TEXT | 否 | — | UQ | 确定性 FactBuilder 规则版本键 |
| `subject_binding_id` | TEXT | 否 | — | FK, UQ | 被评价行为主体的本局角色绑定 |
| `cutoff_seq` | INTEGER | 否 | — | FK | 事实的证据截止内部序号，必须等于该截面 source_seq |
| `cutoff_state_version` | INTEGER | 否 | — | — | 事实证据截止状态版本，必须等于截面且不超过 seal |
| `fact_payload_json` | TEXT | 否 | — | — | 预计算可核对行为事实；禁止以任务成败奖励替代行为评价 |
| `visible_refs_json` | TEXT | 否 | — | — | 在该截面可引用的实际已展示/获知记录列表；数组 |

**外键**

- `(session_id, cutoff_seq) → events(session_id, seq)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, subject_binding_id) → actor_bindings(session_id, binding_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, context_id) → decision_snapshots(session_id, snapshot_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, seal_hash) → terminal_seals(session_id, sealed_hash)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- UNIQUE `(session_id, seal_hash, context_id, rule_id, subject_binding_id)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id, fact_id)`（SQLite 自动索引）。

**相关触发器**：`behavior_cutoff_guard`、`behavior_facts_immutable_delete`、`behavior_facts_immutable_update`。

## evaluation_reports

独立 Evaluator 经校验结果的历史版本；不授予任何写游戏世界权限。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `evaluation_id` | TEXT | 否 | — | PK2 | 一次保存评价版本 UUID |
| `job_id` | TEXT | 否 | — | FK | 逻辑模型工作 UUID；恢复重试复用同一个 job，不增调用上限 |
| `sealed_hash` | TEXT | 否 | — | FK, UQ | 终局核心内容规范化 SHA-256；评价和导出以此绑定固定事实 |
| `config_hash` | TEXT | 否 | — | UQ | 模型、提示词、schema、工具、guardrail、规则配置规范化摘要 |
| `revision` | INTEGER | 否 | — | UQ | 正整数版本；更正产生新记录并明确链接旧版本，不能覆写旧文案 |
| `mode` | TEXT | 否 | — | — | 最终报告使用 live_model 或明确标注 offline_template，与 job 一致 |
| `report_json` | TEXT | 否 | — | — | 与 job 结果逐字节一致的评价报告；不修改封存行为 |
| `created_at_ms` | INTEGER | 否 | — | — | 记录创建时 UTC Unix 毫秒；用于审计，不用于任务倒计时 |

**外键**

- `(session_id, sealed_hash) → terminal_seals(session_id, sealed_hash)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id, job_id) → agent_jobs(session_id, job_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- UNIQUE `(session_id, sealed_hash, config_hash, revision)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id, evaluation_id)`（SQLite 自动索引）。

**相关触发器**：`evaluation_reports_immutable_delete`、`evaluation_reports_immutable_update`、`evaluation_result_guard`。

## export_jobs

封存数据的导出作业与服务器生成文件索引；不是公开任意文件读取器。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK, UQ | 局 UUID；所有本局实体及查询的第一隔离键 |
| `export_id` | TEXT | 否 | — | PK2 | 服务器创建的导出工作 UUID |
| `sealed_hash` | TEXT | 否 | — | FK | 终局核心内容规范化 SHA-256；评价和导出以此绑定固定事实 |
| `request_id` | TEXT | 否 | — | UQ | API Idempotency-Key UUID；命令/创建回执中的作用域由复合主键决定 |
| `export_kind` | TEXT | 否 | — | — | public_replay/team_spoilers/diagnostics；后三者可见性与内容不同 |
| `status` | TEXT | 否 | `'queued'` | — | 实体状态；枚举与转移约束按本表 CHECK/trigger 限定 |
| `relative_output_path` | TEXT | 是 | — | — | 服务端生成的包内相对缓存路径；API 不接受用户文件系统路径 |
| `output_hash` | TEXT | 是 | — | — | 生成导出文件的 SHA-256 |
| `error_code` | TEXT | 是 | — | — | 稳定技术失败码；不给玩家泄露供应商密钥或隐藏世界 |
| `created_at_ms` | INTEGER | 否 | — | — | 记录创建时 UTC Unix 毫秒；用于审计，不用于任务倒计时 |
| `completed_at_ms` | INTEGER | 是 | — | — | 终态提交 UTC Unix 毫秒；活跃状态为空 |

**外键**

- `(session_id, sealed_hash) → terminal_seals(session_id, sealed_hash)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- UNIQUE `(session_id, request_id)`（SQLite 自动索引）。
- PRIMARY KEY `(session_id, export_id)`（SQLite 自动索引）。

**相关触发器**：`export_jobs_no_delete`。

## diagnostic_records

技术侧旁路审计，接收 late callback/unknown/recovery；不属于可修改世界输入。

| 字段 | SQL 类型 | 可空 | DEFAULT | 键/索引 | 语义 |
|---|---|---|---|---|---|
| `session_id` | TEXT | 否 | — | PK1, FK | 局 UUID；所有本局实体及查询的第一隔离键 |
| `diagnostic_id` | TEXT | 否 | — | PK2 | 追加技术诊断 UUID；终局后仍可记录，但不能反写游戏世界 |
| `category` | TEXT | 否 | — | — | late_callback/transport_unknown/storage_failure/recovery/validation_rejection/postgame_audit |
| `job_id` | TEXT | 是 | — | FK | 逻辑模型工作 UUID；恢复重试复用同一个 job，不增调用上限 |
| `attempt_no` | INTEGER | 是 | — | FK | 某 job 的实际请求序号，从 1 连续递增；最多 max_attempts |
| `recorded_at_ms` | INTEGER | 否 | — | — | 事件/诊断入库 UTC Unix 毫秒 |
| `payload_json` | TEXT | 否 | — | — | 脱敏技术诊断；postgame_audit 时为完整 PostgameAuditEvent envelope，auditId/sessionId/sealedHash 必须匹配该行及已激活 seal，不增加 gameplay seq |

**外键**

- `(session_id, job_id, attempt_no) → agent_attempts(session_id, job_id, attempt_no)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。
- `(session_id) → sessions(session_id)`；ON UPDATE NO ACTION，ON DELETE NO ACTION。

**索引 / 唯一键**

- PRIMARY KEY `(session_id, diagnostic_id)`（SQLite 自动索引）。

**相关触发器**：`diagnostic_records_immutable_delete`、`diagnostic_records_immutable_update`、`postgame_audit_seal_guard`。

## 延迟外键与写入顺序

`sessions.scene_id`、`sessions.terminal_seal_id`、`quota_accounts.last_entry_id`、`input_manifest_members.manifest_id`、`manifest_statements.manifest_id`、`terminal_seals → sessions.terminal_seal_id` 使用 DEFERRABLE INITIALLY DEFERRED。它们允许同事务构建完整循环引用，不能在 COMMIT 时留下悬空引用。其余外键即时检查。

完整事务执行和限制见 [数据库 LLD](../03_LLD_数据库.md)。
