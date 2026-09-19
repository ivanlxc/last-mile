# 2D 卫星风格地图

这是一张用于 LAST MILE 虚构河谷的静态卫星风格底图。它与现有公开地图共用布局，不是真实卫星影像，也不提供实时侦察或关卡真相。

## 资产与生成方式

- 游戏资产：`client/public/assets/valley-satellite-v1.webp`。
- 作者原图：本目录的 `valley-satellite-v1.png`。
- 参考场景：`assets/authoring/last-mile-unity/LAST_MILE_Unity_Refined.blend`，保持原文件不变。
- 俯视参考脚本：`scripts/render-satellite-reference.py`。运行结果存放在被 Git 忽略的 `.local-artifacts/satellite/`。
- 美术生成：内置 imagegen 工具，以 Blender 正交俯视图为编辑参考。完整提示词见 [prompt.txt](prompt.txt)。WebP 仅做网页压缩，不修改地理内容。

构图为北向上、3:2，1536×1024 像素。摄影质感包含沙土、屋顶、植被、道路与自然阴影；不烘焙地点文字、路线覆盖线、车辆或关卡状态。路线、地点和车队由网页实时叠加，来自原有公开 `map-data.json` 与服务器下发的公开位置。

## 投影约定

| 属性 | 约定 |
| --- | --- |
| Blender 平面 | X 向右、Y 向北 |
| 公共 glTF 坐标 | X 向右、Z 向南，Y 是高度 |
| 画幅 | X ∈ [-24, 24]；公共 Z ∈ [-16, 16] |
| 像素映射 | x = (X + 24) × 32；y = (Z + 16) × 32 |
| 高度 | 2D 投影不使用高度 |

这里使用游戏美术单位，界面不虚构现实经纬度或米制比例尺。图像是风格化的摄影表现，玩法位置始终以公开地图坐标为准。

## 本地重建与历史

```sh
blender --background --python-exit-code 1 --python scripts/render-satellite-reference.py
```

重新生成影像时，保留原始视角、比例、画幅和地理锚点，再按 [prompt.txt](prompt.txt) 用内置 imagegen 编辑。检查桥梁两端、检查站、市集、南侧便道和曙光站的叠加位置，随后压缩为 WebP 并更新网页资产。生成结果具有随机性，当前已检查版本随 Git 保存。

当前网页版本使用如下压缩参数（需安装 `cwebp`）：

```sh
cwebp -q 91 -m 6 -mt assets/authoring/satellite-map/valley-satellite-v1.png -o client/public/assets/valley-satellite-v1.webp
```

本轮前的回滚点：`checkpoint/pre-satellite-map-20260919`。完成版：`checkpoint/satellite-map-01`。代码和资产只保存在本地分支，本轮不推送 GitHub。
