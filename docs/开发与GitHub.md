# API key、启动与 GitHub

## 1. 填写真实 API key

填写位置：`<repository-root>/.env`，其中 `<repository-root>` 是你克隆到的目录。新克隆默认使用离线模板；开发机已完成 OpenAI `gpt-5.6-luna` 真实接口及中英文合成测试，并于 2026-09-16 重启为 OpenAI 模式。详情见[真实模型接入验收](implementation/真实模型接入验收.md)。密钥是否可用于另一账户、电脑或模型，仍需独立检查。

**只编辑 `.env`，不要把真实 key 填进 `.env.example`。** 后者是团队可以共享的空模板。

Finder 中按 `Command + Shift + .` 可显示以点开头的文件。也可以用编辑器打开项目，选择 `.env`。

先选择一家供应商。OpenAI 可使用本轮验证通过的配置；密钥须在本机自行填写：

```dotenv
MODEL_PROVIDER=openai
OPENAI_API_KEY=在本机填写真实key
OPENAI_MODEL=gpt-5.6-luna
OPENAI_REASONING_EFFORT=low
AI_ADVISOR_TIMEOUT_MS=30000
AI_ADVISOR_MAX_OUTPUT_TOKENS=2500
AI_EVALUATOR_TIMEOUT_MS=45000
AI_EVALUATOR_MAX_OUTPUT_TOKENS=5000
```

Anthropic 填这三项：

```dotenv
MODEL_PROVIDER=anthropic
ANTHROPIC_API_KEY=在本机填写真实key
ANTHROPIC_MODEL=填写准确模型ID
```

另一家字段可以为空。需要同时填写供应商、key、模型 ID；当前适配器没有偷偷选择默认模型。不要发 key 到聊天、截图或 README；不要创建 `VITE_OPENAI_API_KEY` 之类的前端变量。

保存后需要**停止并重启后端**，旧进程不会读取新的 `.env`。直接再点启动器只会打开已运行的服务，不等于重启。正在进行的局会在后端停止时封存为技术中断，因此请先结束试玩再重启。

若不确定自己的模型权限，保持 `MODEL_PROVIDER=offline`。上面的 low / 30 秒／2,500 tokens / 45 秒／5,000 tokens 是有限真实测试通过的配置，不代表所有账户或负载下都稳定。未填写四个 `AI_*` 参数时，代码回退默认仍为 Advisor 8 秒／1,200 tokens、Evaluator 20 秒／3,000 tokens；不是上面的推荐值。Anthropic 当前只有模拟协议验收。

查看配置但不调用模型：

```bash
pnpm verify:model
```

该命令仅打印供应商、模型、密钥是否存在和配置限制，不输出密钥；默认实际调用数为 0。确需付费验证时显式执行：

```bash
pnpm verify:model --live --role=all --locale=zh-CN --attempts=1 --output=.local-artifacts/model-smoke-zh.json
```

`--role` 支持 `advisor`、`evaluator`、`all`；`--locale` 支持 `en-US`、`zh-CN`；`--attempts` 支持 `1` 或 `2`，默认每岗位一次，选择 2 才为一次受限修复保留额度。只发送合成 fixture，不读取玩家数据库；报告仅允许写入被 Git 忽略的 `.local-artifacts/`。真实模型 fallback 会使验收失败，不冒充成功。普通测试与服务启动不做付费探活。

格式、引用或明显错语种不合格最多修复一次，修复失败后明确回退离线模板。错语种检测仅检查模型自己的 summary、rationale 和维度 explanations，不改写原话，也不保证完整语言质量。完整三关真实模型试玩与公网部署仍待验收。

## 2. 启动项目

项目远程地址为 `https://github.com/ivanlxc/last-mile.git`。在自己选择的父目录克隆，再进入项目根目录：

```bash
git clone https://github.com/ivanlxc/last-mile.git
cd last-mile
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

需要 Node.js 24+、pnpm 11。本机也可以双击根目录 `启动 LAST MILE.command`。开发热更新使用 `pnpm dev`。

新克隆的电脑不会收到 `.env`；从 `.env.example` 创建自己的 `.env` 即可。已有配置时不要覆盖它。

## 3. 哪些同步到 GitHub

提交：源码与运行资源 `client/`、`server/`、`scripts/`，全部测试、根配置、锁文件、`.env.example`、启动器，当前 `docs/`（包括工程基线和发布验收），以及当前 Blender 主文件、地图预览和源数据。下列本机资料与重复文件例外，不删除但不上传。

仓库当前为 **Public**。任何人可阅读已提交的服务端剧本、工程内容和作者数据；不要将“玩家在浏览器内看不到”误认为“源码保密”。运行时只有 `client/public/` 的资源供网页直接读取。GitHub 源码公开不等于已经部署游戏服务。

已在 `.gitignore` 中排除：

- `.env`、`.env.*`（仅放行 `.env.example`）；
- `.last-mile/`、SQLite / DB 存档及 WAL 文件；
- `.local-artifacts/` 中的 ZIP、重复旧文件和本地备份；
- `node_modules/`、`dist/`、测试临时结果、日志、系统缓存、Blender 自动备份；
- 常见私钥文件 `*.pem`、`*.key`；
- `/archive/`、`/docs/repository-audit/` 和 `/assets/authoring/wadi07-output-variant/`：原开发机历史资料；
- `assets/authoring/last-mile-v2/LAST_MILE_GameMap.glb`：重复导出，运行副本 `client/public/assets/map.glb` 提交；
- `assets/authoring/last-mile-v2/地图设计与资产接入.pdf`：重复格式，同行的 Markdown 说明提交。

忽略规则防止这些文件被普通 `git add .` 加入；不要使用 `git add -f` 强行添加私有配置。

## 4. 首次提交与推送

维护者的 `origin` 指向 `https://github.com/ivanlxc/last-mile.git`，仓库为公开仓库。以下说明首次提交与推送的操作方式；后续协作见第 5 节。克隆后的团队成员无需再次添加 `origin`。

先检查：

```bash
git remote get-url origin
git status --short
git check-ignore .env .last-mile/game.sqlite .local-artifacts/packages/example.zip
```

需要时用你自己的身份设置当前仓库的 `user.name` / `user.email`。随后在你准备提交时执行：

```bash
git add .
git diff --cached --stat
git status --short
git commit -m "Prepare LAST MILE bilingual playtest project"
```

确认暂存内容符合上述范围、提交已生成后，推送到已关联的远程：

```bash
git push -u origin main
```

GitHub 登录／授权使用你自己的账号；不把 GitHub token 放进 remote URL、代码或聊天。远程仓库如已有内容，不直接执行覆盖式推送，应先检查历史。

## 5. 团队后续工作流

新成员使用第 2 节的克隆命令。已有副本先确认没有未处理修改，再更新并创建自己的工作分支：

```bash
git switch main
git pull --ff-only
git switch -c feature/your-change
```

修改后运行相关测试与 `pnpm build`，检查 `git diff` 和暂存内容再提交，随后 `git push -u origin feature/your-change`，通过 Pull Request 合并。没有仓库写权限的成员可使用 Fork 和 Pull Request；公开访问并不授予推送权限。

每台电脑独立维护 `.env` 和 `.last-mile/`；Git 拉取不会同步密钥或玩家存档。只维护自己的仓库副本，不把 Codex 的整份 `outputs/`、`work/` 或本机历史归档嵌套复制进来。
