# Unity 接入本地试用

本次改动提供真实 Unity C# 工程、Web 构建脚本和 React 接入。本机已安装并激活 Unity 6000.3.22f1，完成真实 Web Build Support 构建和 Chrome 浏览器验证。刷新网页，在地图工具栏选择 Unity 即可试用。

## 现在试用

在仓库根目录运行 `MODEL_PROVIDER=offline pnpm dev`，打开 `http://127.0.0.1:5173`。离线模式不调用模型 API。已配置真实模型的 `.env` 无需修改。

1. 选择中文，进入任务简报。地图可切换二维路线图、三维沙盘。
2. 点击地图下方的地点按钮，查看对应的公开地点信息；二维地图也支持点击节点。
3. 点击 Unity，等待加载完成；也可展开地图操作镜头和点击节点。其他未构建的机器会显示安装和构建说明，原游戏仍可开始。
4. 开始护送，实际等待首段 30 秒行程结束。选择「西门检查站」，点击「调查此地点」，选择调查渠道后查看原有成本确认弹窗。
5. 取消调查不会消耗资源；最终确认走原有后端命令、版本和幂等校验。选择其他地点不会让车队移动。

当前开发服务使用 `.last-mile/unity-preview.sqlite` 作为独立试用库。需要重现相同配置时：

```bash
MODEL_PROVIDER=offline LAST_MILE_DB=.last-mile/unity-preview.sqlite pnpm dev
```

## 安装 Unity 后

按照 [Unity 工程说明](../../unity/README.md) 安装 Editor 和 Web Build Support 并激活许可，执行 `pnpm build:unity`。构建成功后，打开地图「Unity 接入说明 → 重新检查构建 → 使用 Unity 场景」。生产前端还需再次运行 `pnpm build`。

Unity 场景已改为导入 Blender 模型的透视三维场景，包括地形、河流、聚落、桥梁及三辆独立车辆，并保留公开路线和可点击热点。左键平移、右键旋转、滚轮缩放；F 或画布中的跟随按钮切换车队视角，Home 返回全景。行驶由服务器进度驱动，车辆随路线转向，车轮随实际位移转动。

美术源文件在 `assets/authoring/last-mile-unity/`，原始工程仍保留。使用 `pnpm build:art` 重建新版 Blender 工程、纹理和 FBX，再运行 `pnpm build:unity` 接入网页。详情见 [Blender 美术工作流](../../unity/README.md#blender-美术工作流)。场景细化不增加侦察情报或新的战术规则。

## 实现边界

| 层 | 职责 |
| --- | --- |
| Node 核心及 REST/SSE | 原有的权威游戏状态、时间、资源、调查、AI 与复盘 |
| React `MapRendererProvider` | 切换渲染器、探测构建、出发前就绪门禁、跨页面保存 Unity 实例 |
| `UnityViewport` / `lib/unity.ts` | 加载真正的 Unity loader，公开字段白名单、实例 ID、递增消息序号、握手、超时和释放 |
| Unity `LastMileBridge` / `TacticalMapView` | 接收公开位置、显示地图和车队、回传地点选择 |
| `scripts/refine-unity-scene.py` / `build-art.mjs` | 从原始 Blender 工程生成新版模型、纹理和 FBX |
| `scripts/build-unity.mjs` | 查找 Editor，同步 Blender 导出与公开地图，构建 Web player，校验产物后发布 manifest |

Unity 只收到 session/run 标识、状态版本、任务时间、阶段、公开位置、所选地点和公开地图。报告、AI 上下文、资源账本、隐藏剧本和判定结果不会序列化到 Unity。桥接中的 session ID 是当前浏览器已有的游戏标识，不包含授权 token。

点击 Unity 地点只回传 `select-location`。React 校验实例 ID 和公开地点 ID；只有当前场景才显示调查入口，后续仍需在既有弹窗中确认。

同一实例的 `viewSequence` 每次发送递增；仅时钟变化、状态版本不变的更新也会同步。简报进入游戏保留同一画布和实例。退出、切换渲染器和失败时调用 `Quit`，丢弃过期实例回调。

连续运动使用服务端 `clock.sample` 中的公开 `location`。原实现只发送时间，导致健康 SSE 连接下车辆在两个规则事件之间停住；现在每个时钟采样同时发送由相同服务端时间计算的位置。客户端只合并同一 session、runEpoch、stateVersion 且时间不倒退的采样。旧持久消息允许缺少 location，必要时重新获取公开投影；Unity 不自行计算未来进度。这条修正也适用于原有二维与 Three.js 地图。

开发和生产服务器均为 `/unity/` 提供正确的 WASM/压缩文件类型；构建缺失返回 404，不返回 SPA HTML。生产 CSP 仅新增 `wasm-unsafe-eval`。当前 Unity 构建采用单线程、未压缩输出，不依赖 COOP/COEP。

## 验证

2026-09-18 本机验证：

- `pnpm build`：TypeScript 检查和生产前端构建通过。
- `pnpm test`：292 项通过；21 项依赖独立 PostgreSQL 的测试未配置环境，按测试条件跳过。
- 浏览器回归共 9 项通过（完整运行后定向重跑更新的地图测试）：包含真实 30 秒首段行程、报告/上传/AI/等待/复盘/导出，中英文完整三幕流程及 390px 布局。
- 新增 3 项 Unity 网页集成测试：就绪前禁止出发且服务端任务时间为 0；跨页面保留同一实例和画布；过滤未知地点/旧实例；运行错误释放实例并回退；构建缺失时仍可开始游戏。
- 中文三幕测试补充了地图选择、未来地点不提供调查、打开/取消调查不扣资源的验证。
- 构建脚本语法、公开地图 11 节点/13 路线坐标转换、`.jslib` 回调协议通过静态/脚本检查。
- `pnpm build:unity --check` 按预期报告未找到 Unity Editor；没有生成伪造的运行时产物。

同日后续真实引擎验证：Apple Silicon Editor 6000.3.22f1 和 Web Build Support 已安装到 `/Applications/Unity/Hub/Editor/6000.3.22f1`。用户完成 Personal 许可激活后，`pnpm build:unity` 成功编译 C#、IL2CPP 和 WebAssembly。开发及生产网页真实加载通过，浏览器无 pageerror。首次运行修正了 canvas 缺少独立 DOM ID 的问题。

新增 `tests/ui/unity-runtime.spec.ts` 使用真实引擎而非协议替身，已验证 C# 射线命中 N01 热点及回调、简报到任务保留同一画布、任务时间推进、镜头画布展开/收起、真实键盘输入和切换 2D 清理。构建后的生产静态资源隔离与 Unity 资源类型共 6 项定向测试通过。

`unity-integration.spec.ts` 使用协议替身验证故障及生命周期；`unity-runtime.spec.ts` 使用真实编译产物验证实际引擎。三幕快速流程使用进程内测试时钟；单独的 functional 测试验证真实 30 秒行程，两者分别计入上述范围。上述开发验证未调用付费模型 API；这部分记录完成时尚未提交或推送 Git，后续发布以仓库提交历史为准。

仍需比赛前验证：Unity 模式下完整三关与所有路线、镜头手感、浏览器切后台与恢复、目标电脑帧率和内存占用，以及场景美术调优。

## Blender 三维场景本机验证（2026-09-18）

- Blender 5.2.1 已安装；新版母版可编辑，16 张纹理打包并保留相对外链，原始母版与 GLB 未覆盖。
- 新 FBX 通过 Unity 原生导入：75 个 Renderer、约 36 万三角形，3 个地图锚点、3 辆车辆和 12 个轮轴通过构建校验。
- 真实 Unity Web 编译成功；当前运行数据包约 17 MB、WASM 约 14 MB，需考虑目标网络的首次加载时间。
- `pnpm build` 通过；`pnpm test` 为 301 项通过、21 项 PostgreSQL 环境测试跳过。
- 完整浏览器回归 10 项通过，包括中文三幕、真实 30 秒行程、调查/上传/AI/等待/复盘、三项 Unity 协议替身测试，以及真实 Unity 引擎测试。
- 真正的浏览器图像验证：R00 从 179‰ 进展至 381‰，对应两帧画面显著变化约 46.8%，人工核对三辆车移动、队形及跟随镜头。到达 N01 后时钟继续推进约 2 秒，两帧显著像素差仅约 0.0022%，车辆保持静止。浏览器 pageerror 和 console error 均为空。

本轮修复了时钟更新未携带位置而导致车辆静止的问题、Blender 法线图输出异常，以及 N00 停车坪的局部车辆高度，并清理起步车道的棚架穿插。新增画面属于可继续精修的风格化场景；没有新增战术规则、驾驶操作或隐藏情报。

最终美术复验：N01 原横杆改为固定抬起的中性场景道具，消除与车辆的穿插；横杆不表示许可或调查结果。重新构建 Unity 与生产前端后，真实引擎行驶/停车测试再次通过（约 40 秒）。最终帧的行驶像素差约 46.5%，停车像素差约 0.0020%；截图及公开位置证据保存在本机 `.local-artifacts/unity-blender-final/`。本地开发服务保持运行，刷新网页并新开一局即可试用。
