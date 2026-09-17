# 工程基线与当前契约

PRD、HLD、LLD、draw.io 和验证资料的设计版本为 v0.5，当前游戏版本为 v0.2.0。完整入口见上级 [文档导航](../README.md)。

此目录同时包含运行必需的 SQL、JSON Schema、剧情和类型，不能从游戏部署包中删去，也不要直接用 Codex 的旧交付目录覆盖它。

与原工程交付相比，`contracts/public.schema.json`、`contracts/public.types.ts` 已增加当前双语实现需要的 `locale`、`defaultLocale`、`supportedLocales` 等兼容字段。现有 `MANIFEST.sha256` 是**原 v0.5 交付基线**的哈希记录，不是当前修改后的完整性清单；两项差异是已知的实现增补。本 README 是目录整理时新增说明。

运行行为和后续增补见 [实现与设计映射](../implementation/实施与设计映射.md)、[双语版本说明](../implementation/双语版本说明.md)。历史设计中“尚未实现”是当时状态；当前游戏已经可玩，模型实测及云端部署仍待完成。
