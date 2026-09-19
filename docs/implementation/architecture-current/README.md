# LAST MILE 当前实现架构图

源码基线：[`e31f79453dd4cfcc07636fdb79229406594a1357`](https://github.com/ivanlxc/last-mile/tree/e31f79453dd4cfcc07636fdb79229406594a1357)；游戏版本 v0.3.0。绘制日期：2026-09-18。

本组图保留为接入 Unity 前的实现快照。后续新增的 Blender → Unity 渲染、浏览器桥接及车队位置同步见 [Unity 接入实现说明](../Unity接入本地试用.md)；图中的原有游戏规则、网络和 AI 分工仍可作参考。

## 使用

用 draw.io Desktop 或 diagrams.net 打开 `LAST_MILE_Current_Architecture.drawio`。总文件包含三页，节点、文字、分组与连线均为原生可编辑对象。

| 页 | 单页源文件 | PNG 预览 | SVG 矢量图 |
|---|---|---|---|
| 系统总览 | [01-system.drawio](01-system.drawio) | [PNG](previews/01-system.png) | [SVG](svg/01-system.svg) |
| 信息边界与双 AI | [02-information.drawio](02-information.drawio) | [PNG](previews/02-information.png) | [SVG](svg/02-information.svg) |
| 调查、上传与 AI 分析时序 | [03-sequence.drawio](03-sequence.drawio) | [PNG](previews/03-sequence.png) | [SVG](svg/03-sequence.svg) |

PNG / SVG 使用 draw.io Desktop 31.4.5 导出，内嵌对应单页图数据。源文件、预览和矢量图放在同一包中，方便设计评审与文档使用。

## 图中的实现边界

- 服务端为同一 Node.js 进程中的 Fastify、CoreGameService、World、AI Gateway 和 Store；图中逻辑模块不代表独立部署服务。
- REST 负责操作与查询，SSE 负责公开事件推送。前端也有断线后的重新查询与终局评价轮询。
- 当前 `startScheduler()` 间隔为 **1,000 ms**。命令与模型结果发布前也会补齐到期事件；不是按帧推进的物理引擎。
- 玩家收到报告后，需要主动上传才能进入 Advisor。输入包含公开任务、背景与已授权材料；不自动传入完整私有倒计时或资源快照。
- Advisor 和 Evaluator 使用独立输入与提示词，可共用一个模型供应商配置。Evaluator 的内容输入不包括隐藏剧本与 Outcome；封存哈希和终局类型作为关联、覆盖信息保留。
- 调查、行动、资源、状态变更和最终结果由规则引擎决定；语言模型不直接写入世界状态。
- 时序图展示主要成功路径，省略普通函数返回和上传接口的即时返回。模型调用的持久化 attempt 只在实际尝试实时供应商请求时消耗；离线模板不消耗发送次数。过期结果保留调用记录，不再发布。
- 本地使用 SQLite。云端配置使用 PostgreSQL；仓库提供 Render + Neon 部署说明，并以数据库锁约束单个活动引擎。图纸不代表已检查线上部署。
- 这些图是对当前实现的源码梳理，不替换 `docs/engineering_v0.5` 中的历史设计基线。

## 主要源码依据

| 内容 | 代码 |
|---|---|
| 启动、存储、AI 注入、调度启动 | [server/index.ts](../../../server/index.ts) |
| 前端状态、API、SSE | [useGame.ts](../../../client/src/lib/useGame.ts)、[api.ts](../../../client/src/lib/api.ts) |
| HTTP、权限、契约与事件流 | [app.ts](../../../server/http/app.ts)、[contracts.ts](../../../server/http/contracts.ts) |
| 命令、资源、调度、投影、AI job、终局 | [implementation.ts](../../../server/core/implementation.ts) |
| 隐藏剧本与路线规则 | [world.ts](../../../server/core/world.ts)、[state.ts](../../../server/core/state.ts) |
| 模型输入、输出和调用 | [context.ts](../../../server/ai/context.ts)、[guards.ts](../../../server/ai/guards.ts)、[index.ts](../../../server/ai/index.ts) |
| 行为事实与独立评价 | [facts.ts](../../../server/ai/facts.ts)、[Debrief.tsx](../../../client/src/components/Debrief.tsx) |
| 存储与云端部署 | [store.ts](../../../server/core/store.ts)、[postgres.ts](../../../server/core/postgres.ts)、[render.yaml](../../../render.yaml) |

## 重生成

```bash
python3 docs/implementation/architecture-current/generate.py
```

在项目根目录，用实际安装位置替换 `drawio`：

```bash
drawio --export --format png --theme light --scale 1.5 --border 24 --embed-diagram \
  --output docs/implementation/architecture-current/previews/01-system.png \
  docs/implementation/architecture-current/01-system.drawio

drawio --export --format svg --theme light --border 24 --embed-diagram --embed-svg-fonts false \
  --output docs/implementation/architecture-current/svg/01-system.svg \
  docs/implementation/architecture-current/01-system.drawio
```

其他两页使用对应文件名重复导出。重运行生成器会覆盖图纸中的手工修改，手工编辑后应另存或同步更新生成器。
