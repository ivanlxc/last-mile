# LAST MILE Unity Web 地图

这是真实 Unity C# 工程和 Web 构建入口。本机已安装 Unity Hub、Unity 6000.3.22f1（Apple Silicon）及 Web Build Support，并完成许可证激活。**真实 Unity Web player 已编译成功并在 Chrome 中运行通过**。网页仍保留原有地图与构建缺失时的提示。

2026-09-18 本机验证：Editor `-version` 返回 `6000.3.22f1`；`pnpm build:unity` 完成 C#、IL2CPP 和 WebAssembly 构建并发布 manifest；开发和生产网页均可加载真实 Unity 场景，生产 CSP 保持限制。真实热点选择、跨页面同一画布、任务时钟、地图展开/收起、网页键盘输入和切换 2D 已通过浏览器测试。首次运行发现并修正了 Unity 所需的 canvas ID。

## 本地构建

1. 自行通过 Unity Hub 安装 **Unity 6.3 LTS / 6000.3.22f1** 和该编辑器的 **Web Build Support**。打开编辑器完成自己的许可设置。这里的代码不下载或安装编辑器，也不自动处理账号或许可证。
2. 在仓库根目录运行 `pnpm build:unity`。等价命令：`node scripts/build-unity.mjs`。
3. 运行 `pnpm dev`，打开应用，选择地图区域的 Unity 选项。已经打开的页面请重新加载。

自定义安装路径：

```sh
UNITY_EDITOR_PATH='/Applications/Unity/Hub/Editor/6000.3.22f1/Unity.app/Contents/MacOS/Unity' pnpm build:unity
```

`node scripts/build-unity.mjs --check` 只检查是否能找到编辑器，不启动它；`--prepare-only` 从公开地图生成 Unity 的 JSON 资源，并同步已导出的 Blender FBX、材质清单和纹理。Hub 标准安装路径可以自动识别，优先使用固定版本，然后尝试其他 6000.3 版本。

构建前请关闭打开同一工程的 Unity Editor。失败详情位于 `unity/LastMile/Logs/web-build-*.log`。如果缺少 Web Build Support 或有效许可，先在自己的 Unity Hub 中解决，再重试。

成功时脚本验证非空 loader、framework、data、WASM 文件以及 WASM 文件头，先发布完整的新版本资源目录，最后原子替换 `client/public/unity/manifest.json`。构建失败不会替换上一份 manifest。旧版本资源保留，避免正在使用旧构建的页面失去资源。此原型输出未压缩、单线程构建，不需要压缩专用响应头或 SharedArrayBuffer。

生产静态包需要先 `pnpm build:unity`，再 `pnpm build`。开发服务器直接读取 `client/public/unity`。正常 TypeScript 构建不调用 Unity。

## 在编辑器中查看

使用 Unity Hub 添加目录 `unity/LastMile`。首次打开导入完成后，选择菜单 **Last Mile → Create or Reset Map Scene**，然后按 Play。该菜单会重建场景文件；如有自行编辑的场景，先另存。

场景从 `Assets/Resources/Art/LastMileMap.fbx` 加载 Blender 地形、道路、建筑、桥梁和车辆；公开路线及可点击节点由 `Assets/Resources/PublicMap.json` 生成。该 JSON 从 `client/src/lib/map-data.json` 白名单复制，不读取隐藏剧本、报告或 AI 输入。模型是虚构场景的美术表达，不代表现场侦察结果。

在纯编辑器预览中，没有浏览器的状态快照，因此车队默认隐藏；地形和镜头仍可操作。Web 构建由 `LastMile.Editor.WebBuild.Build` 创建同一场景。

镜头使用透视投影：左键拖动平移；右键拖动旋转；滚轮缩放；Home 复位；F 切换跟随车队，也可点击画布中的跟随按钮。点击节点向网页发出位置选择事件。节点使用 N00–N10 标识，网页显示完整的中英文地名。公共坐标的 `z` 轴向南，Unity 表现层将其取反；导入时检查公开地点锚点，避免道路、车辆和热点错位。

## Blender 美术工作流

原始工程保留在 `assets/authoring/last-mile-v2/LAST_MILE_Master.blend`；新版工程、预览和导出位于 `assets/authoring/last-mile-unity/`。Unity 使用 FBX 原生导入，不在玩家浏览器中运行 Blender。

```bash
pnpm build:art       # 需要 Blender：从原始工程重建新版、纹理和 FBX
pnpm build:unity     # 同步 FBX/纹理，校验锚点与车辆，生成 Web player
pnpm build           # 如需生产静态包
```

`BLENDER_PATH` 可指定 Blender 可执行文件。本机为 `/Applications/Blender.app/Contents/MacOS/Blender`。正常的 `build:unity` 使用已有导出，不要求安装 Blender。`build:art` 是从原始工程重建，会覆盖新版生成结果；手工编辑新版前先另存，或把修改加入 `scripts/refine-unity-scene.py`。

材质通过可导出的纹理和 Unity 材质映射还原；原始 Blender 程序材质不能直接在 Web player 中执行。静态模型合并以减少绘制次数，三辆车与车轮保留独立层级。Unity 只平滑至已收到的位置，车轮随实际位移转动，跟随镜头不改变游戏时间与路线。

## 数据与权限边界

- React 持有 REST/SSE 网络会话，Node 后端决定世界时间、资源、调查完成和行动结果。
- Unity 只接收渲染需要的公开子集。桥梁模型始终是中性示意符号，不表示当前安全状态。
- 车队按 `nodeId / routeId / progressPermille` 显示，只平滑到最新服务器位置，不自行推进任务或外推未来进度。
- 点击热点只产生 `select-location` 事件；是否开放调查以及执行什么操作仍由网页和后端决定。
- 资源中不包含新线索发现机制、伤亡视觉反馈或推测的危险区域。

## 浏览器桥接

游戏对象名为 `LastMileBridge`，公开方法如下：

```js
unityInstance.SendMessage('LastMileBridge', 'Configure', instanceId);
unityInstance.SendMessage('LastMileBridge', 'ApplyRenderState', JSON.stringify({
  schemaVersion: 1,
  instanceId,
  sessionId: 'session-id',
  runEpoch: 'run-epoch',
  stateVersion: 12,
  viewSequence: 38,
  sceneId: 'E1',
  phase: 'scene',
  locale: 'zh-CN',
  missionTimeMs: 52000,
  location: { nodeId: 'N01', routeId: null, progressPermille: 0 },
  selectedNodeId: 'N01'
}));
```

必须先 `Configure`，Unity 随后才回调 `ready`。`viewSequence` 在同一挂载实例内每次发送递增；状态版本不变时仍允许更新时间和位置。旧序号被丢弃；不同 session/runEpoch 使用新的完整快照。新实例用新的 instanceId，防止卸载期间的回调影响后来创建的实例。

Unity 经 `.jslib` 回调：

```js
window.dispatchEvent(new CustomEvent('last-mile-unity', {
  detail: { schemaVersion: 1, instanceId, type: 'ready' }
}));
// type 也可以为 select-location（携带 nodeId）或 error（携带 message）。
```

`client/public/unity/manifest.json` 只会在真实 Unity 构建成功后生成，包含 `schemaVersion`, `loaderUrl`, `dataUrl`, `frameworkUrl`, `codeUrl`, `companyName`, `productName`, `productVersion`。资源 URL 均位于同源 `/unity/releases/<build-id>/Build/`。

## 验证范围与待验证事项

已验证：Node 构建脚本、公开地图转换、缺失构建提示、真实 C#/IL2CPP/WebAssembly 构建、真实 Unity 在开发和生产网页加载。Unity 6 的启动画面已关闭，沿用 React 加载界面；地图标签按画布尺寸显示，避免紧凑地图上重叠。

运行真实引擎测试：先运行 `pnpm dev`，再执行 `pnpm exec playwright test tests/ui/unity-runtime.spec.ts`。该测试没有运行时/消息模拟；未生成真实构建时自动跳过。`unity-integration.spec.ts` 另用明确的协议替身覆盖故障和就绪门禁，两者分别报告。

仍需比赛前试玩：Unity 模式下完整三关与所有路线、切后台/恢复、不同屏幕及目标电脑性能、镜头手感和场景美术。当前为经过材质与细节加工的 Blender 场景，仍属于可继续迭代的游戏原型。

官方参考：

- [Unity 6000.3.22f1 发布说明](https://unity.com/releases/editor/whats-new/6000.3.22f1)
- [网页 JavaScript 与 Unity 交互](https://docs.unity3d.com/6000.3/Documentation/Manual/webgl-interactingwithbrowserscripting.html)
- [构建参数](https://docs.unity3d.com/6000.3/Documentation/ScriptReference/BuildPlayerOptions.html)
- [Web 多线程选项](https://docs.unity3d.com/6000.3/Documentation/ScriptReference/PlayerSettings.WebGL-threadsSupport.html)
