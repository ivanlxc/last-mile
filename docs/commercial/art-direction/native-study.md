# 原生 URP 市集样板：环境与接入记录

日期：2026-09-26。分支：`feature/market-first-person-slice`。

## 本轮范围与状态

用户批准在有限磁盘空间下采用最小 Unity 安装，并开始独立原生美术样板。当前交付是**编辑器环境 + 待编译的样板工程**，尚不是完整原生游戏，也未达到商业美术验收标准。

| 项目 | 实际状态 |
| --- | --- |
| Unity Hub | 3.21.3 ARM64，已安装；官方签名检查通过 |
| Unity Editor | 6000.3.22f1 Apple Silicon，已安装并注册到 Hub |
| 安装包 | 官方发布包；Unity Technologies SF 签名及 MD5 `adebcef69687bf1864227ec1cd66fa04` 核对通过 |
| Editor 完整性 | `codesign --verify --deep --strict` 通过；首次启动显示 Editor Software Terms |
| 账号许可 | Hub 显示已激活的 Personal 许可；编辑器版本条款待用户确认 |
| 额外模块 | 未安装 Web、Android、iOS、IL2CPP 等模块 |
| 编辑器磁盘占用 | 安装目录约 9.1 GiB；清理本轮安装缓存后可用约 8.2 GiB，动态变化 |
| 资产准备脚本 | 已执行成功：18 个材质记录、11 张贴图、FBX，约 15 MiB 暂存目录 |
| Node 脚本与差异检查 | 语法检查、资产准备、`git diff --check` 通过 |
| C#、URP、macOS 构建 | **未验证**；等待 Editor 条款确认后实际编译 |
| 实机画面与性能 | **未验证**；不得将 Blender/概念图当作原生运行证据 |

安装器一度同时留下旧版入门引导安装残留和新安装压缩数据，导致磁盘不足。只清理了本轮 Unity 安装包及已确认版本的临时压缩数据，并用已校验的 6.3 数据补全 Editor，再验证代码签名。未删除个人文件或项目历史资产。

## 工程与数据流

独立工程：`unity/LastMileArt`。原有 `unity/LastMile` 战略沙盘工程及 Web 构建流程保持独立。

1. `scripts/prepare-native-art.mjs` 从既有 FBX、贴图和 GLB 材质参数准备中性美术资产；相同文件不重复写入。
2. `NativeArtImporter` 配置米制比例、法线、贴图色彩空间和纹理尺寸。
3. `NativeArtBuilder` 将材质映射至 URP Lit，转换 roughness → smoothness alpha，建立灯光、碰撞、相机、ACES 调色和场景。
4. `ArtWalkthrough` 提供第一人称行走、鼠标释放/复位、中英文提示、滚动帧时间及截图。
5. `scripts/build-native-art.mjs` 封装准备、打开与 macOS ARM64 Mono 开发构建，启动前检查最少 3 GiB 工作空间。

原始复制资产不重复提交；导入后的 `.meta` 文件需提交以保持资源 GUID 稳定。角色、对话、剧情、调查、联网身份、存档和 AI 在该样板中尚未连接。美术不读取后端隐藏剧本或 `.env`。

## 条款确认后的执行顺序

```sh
pnpm prepare:native-art
pnpm build:native-art
```

先处理真实编译/导入错误，确认 18 个材质完成映射以及建筑比例检查通过；随后启动 `unity/LastMileArt/Builds/LastMileArt.app`，检查行走、碰撞、鼠标释放与双语文字，保存原生截图。成功后更新本记录，并提交 Unity 生成的必要场景、设置和 `.meta` 文件。

此后再精做人物、环境细节、间接照明，按固定路线测量 M4 与 M4 Pro。1080p 下的 30/60 FPS 是目标，当前没有持续测试结果。没有以概念图承诺实际运行效果，也没有把这一静态样板当作所有关卡的原生移植。

操作细节见 [工程 README](../../../unity/LastMileArt/README.md)。
