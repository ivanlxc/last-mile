# 沙盘作者资产

本目录随 [LAST MILE 仓库](https://github.com/ivanlxc/last-mile)提供当前地图作者资料。团队可使用 `git clone https://github.com/ivanlxc/last-mile.git` 获取；安装与运行见[项目首页](../../README.md)。游戏运行不需要安装 Blender。

## 当前游戏沙盘

- [LAST_MILE_Master.blend](last-mile-v2/LAST_MILE_Master.blend)：当前 Blender 主文件。
- [全景沙盘](last-mile-v2/01_全景沙盘.png)与[俯视路线图](last-mile-v2/02_俯视路线图.png)：地图预览；三幕预览也随包提交。
- [last_mile_map.json](last-mile-v2/last_mile_map.json)：地图源数据。
- [地图设计与资产接入](last-mile-v2/地图设计与资产接入.md)：地图制作说明。
- [运行用 map.glb](../../client/public/assets/map.glb)：网页实际加载的 GLB。

仅修改 `.blend` 不会自动更新网页，需要重新导出并更新运行资源。地图包内故事与事件是早期作者资料；当前游戏剧情见[故事与关卡实装](../../docs/implementation/故事与关卡实装.md)及 `server/core/`。

`last-mile-v2/` 来自原地图交付包，包含 `SERVER_ONLY_events.json` 等作者数据。仓库为 Public，这些内容可被仓库访问者阅读；本目录不能作为网页静态根目录。游戏浏览器实际公开的静态资源位于 `client/public/`。

## 仅原开发机保留的内容

以下文件不删除，但由 Git 忽略，克隆时不会取得：

- `last-mile-v2/LAST_MILE_GameMap.glb`：重复导出；运行副本 `client/public/assets/map.glb` 提交。
- `last-mile-v2/地图设计与资产接入.pdf`：重复格式；同名 Markdown 提交。
- `wadi07-output-variant/`：早期沙盘的另一保存版本。
- 仓库根 `archive/wadi07-original/`：早期 WADI07 原件；整个 `archive/` 仅在本机保留。

两个早期 WADI07 版本存在字节差异，尚未比较模型语义，不依据修改时间指定谁更新。`last-mile-v2/SHA256SUMS.txt` 已更新为当前发布文件的校验清单，不包含未上传的重复 GLB／PDF。历史构建与验证报告仍保留当时完整交付包的范围，不等于当前 Git 文件清单。预览 PNG 已清除文件文本元数据中的本机路径，压缩像素数据保持不变。

API 密钥不属于作者资产；仅填写仓库根 `.env`。`.env`、本机数据库与 `.local-artifacts/` 不提交，详见[开发与 GitHub 指南](../../docs/开发与GitHub.md)。
