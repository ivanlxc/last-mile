# LAST MILE 文档导航

截至 2026-09-16：游戏 **v0.2.0** 已实现中英双语的本机可玩版本，默认英文。工程设计基线是 **v0.5**；这两个版本号不代表同一条发布序列。OpenAI 双语有限真实调用已通过，完整三关真实模型试玩和公网部署仍待验收。

## 开始使用与当前实现

- [根目录 README](../README.md)：安装、启动、游戏规则。
- [项目目录与版本](项目目录与版本.md)：每类文件的权威位置、历史迁移。
- [API key 与 GitHub](开发与GitHub.md)：密钥文件、Git 忽略、提交步骤。
- [当前验收结果](implementation/验收结果.md)、[中英文说明](implementation/双语版本说明.md)。
- [实装故事与关卡](implementation/故事与关卡实装.md)、[实现与设计差异](implementation/实施与设计映射.md)。
- [安全与模型接入](implementation/安全与模型接入验收.md)、[部署方案与完整技术栈](implementation/部署方案与技术栈.md)。
- [v0.2 冻结交付记录和截图](releases/playable_v0.2/README.md)。

## 当前工程设计基线 v0.5

| 内容 | 文档 |
| --- | --- |
| 总览 | [阅读与执行指南](engineering_v0.5/00_阅读与执行指南.md)、[网页版设计手册](engineering_v0.5/设计手册.html) |
| PRD | [产品需求](engineering_v0.5/01_PRD.md) |
| HLD | [系统架构](engineering_v0.5/02_HLD.md) |
| LLD：数据库 | [详细设计](engineering_v0.5/03_LLD_数据库.md)、[DDL](engineering_v0.5/database/001_initial.sql)、[数据字典](engineering_v0.5/database/DATA_DICTIONARY.md) |
| LLD：API / 契约 | [详细设计](engineering_v0.5/04_LLD_API与契约.md)、[OpenAPI](engineering_v0.5/api/openapi.json)、[契约目录](engineering_v0.5/contracts/) |
| LLD：Agent | [双 Agent 设计](engineering_v0.5/05_LLD_Agent系统.md)、[当前运行实现](../server/ai/README.md) |
| LLD：运行 / 前端 | [详细设计](engineering_v0.5/06_LLD_运行与前端.md) |
| 架构图 | [draw.io 主文件](engineering_v0.5/diagrams/LAST_MILE_Architecture.drawio)、[各图及预览说明](engineering_v0.5/diagrams/README.md) |
| 用户方案 | [CORE_GAMEPLAY 原文](engineering_v0.5/sources/CORE_GAMEPLAY.md)、[最初项目计划](sources/原始项目计划_用户提供.txt) |

v0.5 是版本化设计基线；其中“尚未开始实现”等时间表述是当时状态。当前行为以代码、测试及 `implementation/` 的实装差异为准。此目录中的 SQL、契约和剧情仍被运行时读取，不能只因为它在 `docs/` 下就从部署包删除。

已确认的玩法：一名玩家操作、其他岗位由游戏呈现；调查额度整局共享；新的溯源／更正占新传递额度且旧版本保留。原文中的不同提议不自动覆盖已确认要求。

## 作者资产与历史资料

- [作者资产](../assets/authoring/README.md)：当前沙盘 `.blend`、GLB、地图说明。
- 本机 `archive/` 保留 v0.2 规划、v0.3/v0.4 设计、原始 WADI07 沙盘与旧实现验收；这些历史副本不上传 GitHub，也不是运行依赖。

历史稿不与当前契约混用；Codex 外部交付目录只保留快照用途。
