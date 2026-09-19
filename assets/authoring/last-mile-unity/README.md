# LAST MILE · Unity 用 Blender 精修资产

本目录从 `../last-mile-v2/LAST_MILE_Master.blend` 派生。旧母版和网页 `map.glb` 保留不变。这里是已有沙盘的可编辑精修版，不是真实测绘地图或摄影测量资产。

## 文件

- `LAST_MILE_Unity_Refined.blend`：可继续编辑的模型，保留独立建筑、材质和车辆细节；16 张图像已打包进母版，并使用相对外链路径，移动项目目录后仍可打开。
- `refined-scene-preview.png`：Blender 灯光下的美术检查图；Unity 的最终效果以网页运行画面为准。
- `exports/LastMileMap.fbx`：Unity 原生 FBX 导入文件，静态环境按材质合并，动态车辆独立。
- `exports/textures/`：16 张 512 × 512 原创程序纹理，8 组 Base Color / Normal。
- `exports/materials.json`：供 Unity 材质导入器读取的明确材质参数。
- `build-report.json`：源文件指纹、导出规模、车辆与坐标约定。

## 本版调整

地形、道路、建筑群、11 个地点和原有路线控制点都来自原地图。移除游戏场景不需要的展示标签、轮廓刻线和底座。原程序材质改为可导出的图像材质，包括细沙、砂岩灰泥、沥青、混凝土、土路、棚布和木材；贴图直接进入 Unity，不依赖 Blender Shader 节点。

建筑增加排水管、通风帽、空调格栅和少量砌石线；道路增加反光桩。河谷沿原季节性河床增加狭窄浅水面，南侧便道保留干地。它们仅用于表现公开环境，不表达关卡威胁、调查真相或道路是否允许通行。

集结院中两顶旧救援棚的布面和顶杆与运行时车队起步通道重叠，因此仅这 4 个道具从精修版渲染和导出中排除；院墙、建筑、集装箱、地板和路线未改变。

西门检查站的原横杆穿过 N01 停车点，因此沿原铰链静态抬起 80°，包括横杆和它的 4 个色条。该美术姿态仅保持车辆净空，不代表游戏中的通行许可或调查结果。

三辆原有车队模型增加后视镜、保险杠、散热格栅、门把、脚踏、尾灯、轮毂与天线；客车有屋顶通风口。车辆和轮轴单独导出，可由 Unity 根据服务器公开位置驱动。沿路线移动、到站停止、轮子转动由运行时代码处理，不在模型里添加自主驾驶逻辑。

## 重建

仓库根目录执行：

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --python scripts/refine-unity-scene.py
```

附加 `-- --skip-render` 可跳过预览，`-- --glb` 可额外导出兼容 GLB。脚本只读取原母版和 `client/src/lib/map-data.json`，不读取服务端事件资料。纹理由固定种子的数学噪声生成，无外部模型、贴图或字体下载。

精修母版保存独立对象；导出过程再将静态件按材质合并。修改原资产后重建会覆盖本目录的生成物。若手工修改精修母版，应先另存为新的作者文件，避免被脚本覆盖。

## 引擎契约

| 项目 | 约定 |
| --- | --- |
| 美术坐标 | Blender XY 地面、Z 向上，场景单位不是实际米数 |
| Unity 坐标 | Blender `(x,y,z)` → Unity `(x,z,y)`；公共 glTF 坐标 `(x,y,z)` → Unity `(x,y,-z)` |
| FBX 设置 | Forward `-Z`，Up `Y`，单位比例 1，无动画烘焙 |
| 校验锚点 | `LM_ANCHOR_N00`、`LM_ANCHOR_N01`、`LM_ANCHOR_N07`，使用公共地图中的精确地点位置 |
| 车队根节点 | `LM_CONVOY_01`、`LM_CONVOY_02`、`LM_CONVOY_03`；模型车头本地 +X |
| 轮轴 | `LM_WHEEL_01_00` 等；绕局部 X 轴转动；半径 0.13 |
| 车辆高度 | 路线高度已包含原车根偏移，运行时不再额外叠加 0.126 |
| 贴图 | Repeat；Albedo 为 sRGB，Normal 为法线数据；有 Albedo 时材质乘色用白色 |
| 粗糙度 | `materials.json` 中 `roughness` 对应 Unity Standard `smoothness = 1 - roughness` |

导出不包含摄影棚、相机、灯光、事件层、私有属性或作者自定义属性。运行时材质、镜头、阴影、热点选择和车辆动画由 Unity 工程统一实现。
