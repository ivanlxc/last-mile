# LAST MILE · 最后一程

一款单人、人机协作决策游戏。玩家护送二十名平民穿越虚构的萨赫尔河谷，在有限时间与调查额度内判断情报、选择提供给 AI 的资料并决定路线。三关、两套隐藏剧本、独立行为复盘可完整运行。当前版本支持完整中文和英文，首次进入默认英文。

## 项目入口与最新版本

**项目仓库：[ivanlxc/last-mile](https://github.com/ivanlxc/last-mile)。** 文档中的 `<repository-root>` 指你自己克隆到的项目目录；源码修改、运行和 Git 操作均在该目录进行。远程 `origin` 指向上述仓库。

- 当前游戏：`package.json` 的 **v0.3.0**，源代码直接位于 `client/`、`server/`、`scripts/`、`tests/`。
- 当前实现说明：[docs/implementation](docs/implementation/)；[验收结果](docs/implementation/验收结果.md)；[真实模型接入验收](docs/implementation/真实模型接入验收.md)。
- 工程设计基线：**v0.5**，见 [PRD](docs/engineering_v0.5/01_PRD.md)、[HLD](docs/engineering_v0.5/02_HLD.md)、[分册 LLD 与架构图导航](docs/README.md)。设计版本号与游戏版本号分别管理。
- [项目目录与版本说明](docs/项目目录与版本.md) · [API key 与 GitHub 操作指南](docs/开发与GitHub.md)。
- **本机密钥只填根目录 `.env`；云端密钥填 Render 环境变量**。公开模板不得填写真实密钥。
- 免费云端试玩部署：[Render + Neon 操作指南](docs/implementation/云端试玩部署.md)；[v0.3 验证记录](docs/implementation/云端改造验收.md)；[技术栈](docs/implementation/部署方案与技术栈.md)。

仓库当前为 **Public**。源码、工程文档与作者数据包含完整剧本和来源关系，任何访问仓库的人都能阅读；游戏内的浏览器信息隔离不等于源码保密。仓库公开也不代表游戏服务已上线。

运行必需文件均在仓库内，不依赖原作者的 Codex `outputs/` 或 `work/`。历史 `archive/`、部分重复作者资产和本机审计记录仅在原开发机保留，不随克隆提供。当前提交范围见[项目目录与版本](docs/项目目录与版本.md)。

## 克隆与启动

需要 **Git、Node.js 24、pnpm 11**。团队可在自己选择的目录执行：

```bash
git clone https://github.com/ivanlxc/last-mile.git
cd last-mile
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

浏览器打开 http://127.0.0.1:3111。默认仅监听本机，服务不对公网开放。游戏是单人单机模式，不需要其他队员登录。首次进入默认英文；标题页可通过 English / 中文 切换并保存语言偏好。每局开始后固定该局语言，刷新时按服务器记录恢复。两种语言覆盖场景、报告、顾问模板、复盘和操作提示；玩家自由输入保留原文。真实模型会收到与本局一致的输出语言指令。

新克隆不包含 `.env`、数据库或真实密钥；未配置模型时使用离线模板。`docs/engineering_v0.5` 中部分契约、剧情与 SQL 被程序直接读取，必须与源码一起保留。

Mac 用户安装上述工具后，也可双击根目录 **`启动 LAST MILE.command`**；保持终端窗口打开，结束服务按 `Ctrl+C`。如果服务已运行，启动器只会打开现有页面，不会重启或重新读取配置。

开发时：

```bash
pnpm dev
```

开发界面 http://127.0.0.1:5173；Vite 将 `/api` 代理到 3111。开发文件系统也禁止读取私有剧情、服务器源码、环境文件和存档。

## 接入真实 OpenAI 或 Anthropic 模型

1. 需要配置模型时，将根目录 `.env.example` 复制为 `.env`。已有 `.env` 时不要覆盖；保持 `MODEL_PROVIDER=offline` 可不使用密钥。
2. 选择一个供应商，填写自己账户可用、支持结构化输出的**精确模型 ID**和密钥。不要把密钥贴进聊天或前端源码。
3. 重启服务。进行一次新测试局，查看顾问卡片的 `LIVE MODEL` 标记；配置齐全只表示可尝试调用，不代表供应商权限或兼容性已验证。

本轮已验证 OpenAI `gpt-5.6-luna` 的真实接口：中英文 Advisor / Evaluator 合成测试成功，英文领域运行链路也通过有限测试。尚未进行真实模型参与的完整三关浏览器验收，Anthropic 仍只有模拟协议测试。详情与测试边界见[真实模型接入验收](docs/implementation/真实模型接入验收.md)。

OpenAI 已验证配置（模型仍须对自己的账户可用）：

```dotenv
MODEL_PROVIDER=openai
OPENAI_API_KEY=在本机填写
OPENAI_MODEL=gpt-5.6-luna
OPENAI_REASONING_EFFORT=low
AI_ADVISOR_TIMEOUT_MS=30000
AI_ADVISOR_MAX_OUTPUT_TOKENS=2500
AI_EVALUATOR_TIMEOUT_MS=45000
AI_EVALUATOR_MAX_OUTPUT_TOKENS=5000
```

Anthropic：

```dotenv
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=在本机填写
ANTHROPIC_MODEL=填写你账户支持的模型ID
```

恢复不调用模型的模式：`MODEL_PROVIDER=offline`。

密钥只在服务器内存读取，不进入网页、SQLite业务快照、日志或导出。Advisor 与 Evaluator 使用独立提示词和互不重用的输入；可以共用一个供应商账户。真实模式会在进入场景、上传材料和提问后分析，终局调用独立评价。每局最多 30 次 Advisor 实际发送，每个任务最多 2 次尝试；格式、引用或明显错语种输出最多允许一次修复，仍受剩余额度限制；网络失败不会自动重复收费重试。上面的已验证配置给 Advisor 每次请求 30 秒、2,500 输出 tokens，Evaluator 45 秒、5,000 输出 tokens。未设置四个 `AI_*` 参数时，代码仍回退为 8 秒／1,200 tokens 与 20 秒／3,000 tokens；本轮发现原 8 秒窗口过短，因此接入此模型时应显式填写配置。失败会明确切换到离线模板，时钟继续。

错语种检测只检查模型自己的 summary、顾问 rationale 和评价维度 explanations，并跳过显式引文；它是保守的文字特征检查，不保证完整语言质量，也不会自动翻译或改写玩家原话、模型原始输出。

**离线模板不是语言模型的替身。** 它整理信息边界、提供可核验的行为规则复盘，不生成虚假的最优路线建议。早期 v0.2 验收使用离线模板和模拟响应；此后已完成受控的 OpenAI 真实调用。最终配置的有限测试成功不等于稳定性承诺，仍需完整局验证延迟、双语表达、引用质量和实际费用。

接口说明：[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)。

## 中英文模式

- 新浏览器默认 English，不根据系统语言自动切换。
- 标题页选择中文后，后续访问记住偏好；选择 English 可切回。
- 单局语言固定。需要另一种语言时，在标题页重新开始；切换语言不会重置正在进行的任务或返还资源。
- 浏览器刷新恢复本局语言；中英文共享同一套规则、额度、时间和隐藏分支。
- 玩家输入、引用原话不会被自动翻译。模型通过可信系统指令按本局语言回复；中英文真实合成测试已通过，明显错语种会进入受限修复／离线回退。完整局的语言与引用质量仍需试玩。

## 怎么玩

- 简报页不计时；按“开始护送”后启动 600 秒真实时钟，先沿 R00 行驶 30 秒进入第一关。
- 每关可以向诺亚、萨米拉索取已有简报，或安排进一步调查；每人每关最多上报 3 条，调查开始即预留槽位。
- 卫星 2、无人机 3、当地机构 3、目击者 2 次，整局共享。
- 正式上传每关最多 5 张；AI 不会自动看到未上传报告、时钟、医疗状态或余额。自由输入是未核实的玩家陈述。
- 每次调查、溯源、更正都可能消耗新的时间/额度；离开场景取消尚未完成的任务，渠道成本保留。
- 可以随时切换二维路线图/三维沙盘。沙盘车辆按服务器位置推进；二维插画不是侦察证据。
- 选择路线前可以填写依据；八分钟后乘客需要优先转送，不会凭空产生死亡。恰好十分钟抵达算成功。
- 终局区分抵达、沿途手续与完整交接。当前在抵达时结束，没有假造人员交接完成时间。
- 行为复盘给出过度依赖、过度怀疑、过度谨慎、校准信任四个维度；证据不足时不强行分类。它不是心理测量工具。

## 本机存档与恢复

SQLite 默认保存在 `.last-mile/game.sqlite`，采用 WAL、事务、幂等命令和不可变终局记录。**浏览器刷新不会暂停时钟**；同一次服务启动中能恢复当前页面。

后端停机/重启会将未结束的局封存为技术中断，不让玩家利用重启暂停时间。不同服务启动有独立的本地授权。要在重启后重新打开一局已封存记录，可从导出文件取得 `outcome.sessionId`，运行：

```bash
pnpm exec tsx --env-file-if-exists=.env server/index.ts --resume-session 该局UUID
```

再打开 `http://127.0.0.1:3111/?session=该局UUID`。本机模式没有跨启动的历史存档选择列表；最方便的保留方式是在终局点击“导出完整复盘”。云端模式使用 PostgreSQL 和独立浏览器身份，提供本人历史记录列表，重启后仍可访问；详情见云端部署指南。

自定义位置：`LAST_MILE_DB`；端口：`PORT`。不要修改 `.env` 后期待正在运行的进程自动换模型。

## 验证与目录

```bash
pnpm build          # 严格类型检查 + 生产前端
pnpm test           # 核心、API、AI、安全、几何与显示文案一致性
pnpm test:ui        # Chrome真实操作；先启动 pnpm dev
pnpm verify:model   # 零模型调用：仅列安全配置、密钥是否存在与有效限制
```

需要付费接口复验时，显式运行以下命令；只发送合成测试数据，不读取玩家数据库。默认每个岗位最多一次，`--attempts=2` 才允许在该任务预算内进行一次修复。`--role` 可选 `advisor`／`evaluator`／`all`，`--locale` 可选 `en-US`／`zh-CN`；输出文件仅允许位于 Git 忽略的 `.local-artifacts/`。

```bash
pnpm verify:model --live --role=all --locale=en-US --attempts=1 --output=.local-artifacts/model-smoke-en.json
```

v0.3 最新回归为 20 个测试文件、281 项通过，生产构建及 4 项浏览器流程通过，包含真实本机 PostgreSQL 与双进程交接验证；详见[云端改造验收](docs/implementation/云端改造验收.md)。本轮未发送真实模型请求，既有有限真实请求结果见[真实模型接入验收](docs/implementation/真实模型接入验收.md)。旧版 158／192 项记录作为此前里程碑保留。

UI 自动化默认使用 macOS Chrome；其他系统可以设置 `PLAYWRIGHT_CHROME_PATH`，或安装 Playwright Chromium。真实时间流程与注入测试时钟的三幕浏览器流程分别记录，不混称为同一种测试。测试时钟只能在进程内注入，没有 HTTP 调速/跳关接口。

| 路径                    | 内容                                           |
| ----------------------- | ---------------------------------------------- |
| `client/src`            | React界面、Three.js沙盘、二维回退、可见性回执  |
| `client/public/assets`  | 地图GLB、开场与三关插画；都是公开静态资源      |
| `server/core`           | SQLite、剧情状态机、资源账本、快照、时钟与终局 |
| `server/http`           | Fastify、23个API、Ajv校验、认证、SSE、静态资源 |
| `server/ai`             | 两家模型适配、独立上下文/事实构建、守卫和模板  |
| `tests`                 | 领域、接口、模型、隔离、浏览器回归             |
| `docs/engineering_v0.5` | 原设计与可编辑draw.io图，作为版本化基线保留    |
| `docs/implementation`   | 实装故事、验收说明、差异、画面生成记录         |
| `assets/authoring`      | 当前 Blender 主文件、预览与地图源数据；重复导出不提交 |
| `docs/releases`        | 冻结的版本验收记录和界面截图                  |
| `archive`              | 仅原开发机保留的早期设计与沙盘；Git 忽略，不随克隆提供 |
| `.local-artifacts`     | 压缩包及重复散件；仅本机保留，Git 忽略        |

## 当前定位

这是可运行的本地首版，使用 v0.5 `SINGLE_PLAYER_REFERENCE` 的 `design_preview` 规则。实现授权不等于玩法数值已经通过玩家试测；保留冻结设计的 review 状态。下一阶段主要是真实模型完整局试玩、平衡与新手试玩、比赛现场机器验收。计划定向分享给团队和评委时，推荐单实例应用加 SQLite 持久卷；上线前必须补齐独立访客身份、会话所有权、访问门禁和模型费用限制。详见 `docs/implementation/部署方案与技术栈.md`。当前本机启动配置不直接作为公网部署配置。
