# 图纸使用

- `LAST_MILE_Architecture.drawio`：八页总图，原生可编辑mxCell结构。
- `01_*.drawio`～`08_*.drawio`：独立单页，适合单独评审。
- `previews/*.png`：实际draw.io导出的预览。
- `svg/*.svg`：实际draw.io导出的矢量图，适合放大，内嵌可编辑图数据。

生成器编写XML后，使用官方draw.io Desktop 31.4.5导出，并逐图视觉检查；调查流与状态图的穿框连线已修正。颜色：蓝=玩家/界面，绿=受控服务/证据，橙=世界/代价，紫=模型，灰=持久化，红=禁止/终局。

示例导出命令（在安装draw.io后执行）：

```bash
drawio --export --format png --theme light --border 20 --scale 1.2 --output previews/01_Context.png 01_Context.drawio
drawio --export --format svg --theme light --embed-diagram --output svg/01_Context.svg 01_Context.drawio
```

图7是关系概览，不是完整物理ER图；所有物理列、FK、CHECK、索引、触发器以数据库LLD、DATA_DICTIONARY及迁移SQL为准。
