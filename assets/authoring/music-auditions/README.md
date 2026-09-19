# LAST MILE — Music auditions

原创编排的虚拟乐器试听小样，供确定配乐方向使用。当前为独立音频资产，尚未接入游戏播放器，也不是最终循环母带。版本目录保留音符编排、MP3 和实测混音数据，后续修改另建版本以便比较。

## 已确认的整体方向

用户要求所有任务关卡的背景音乐都偏深沉、克制，不能滑稽、搞笑或呈现轻快的侦探喜剧感。章节差异通过持续音的层次、和声张力、空间与密度表现；结尾可以相对舒缓、释然。已认可的开场 **Last Light v1** 保持原样。

## v4 · 补齐市集、主桥与结尾 · 2026-09-19

用户认可西门 v3 后，继续完成另外三段。五个阶段的独立音乐文件已齐备；当前仍为带淡入淡出的试听母带，游戏播放与无缝循环尚未接入。

| 阶段 | 采用／试听文件 | 时长 | 编排重心 |
| --- | --- | --- | --- |
| 开场／简报 | [Last Light · v1](v1/last-light.mp3)，已认可 | 1:07 | 钢琴主题、温暖长音，旅途开始 |
| E1 西门 | [Weight of Passage · v3](v3/west-gate.mp3)，已认可 | 0:59 | 深沉低音与暗色弦乐，缓慢的张力 |
| E2 市集 | [Unsettled Accounts · v4](v4/market.mp3)，本轮完成 | 1:12 | 稀疏的低音区钢琴与交错悬置和声，留下信息未明的感觉 |
| E3 主桥 | [The Weight Across the Water · v4](v4/bridge.mp3)，本轮完成 | 1:17 | 开阔的持续弦乐、缓慢上行的大提琴，承载最后一段责任感 |
| 结尾 | [A Place to Rest · v4](v4/ending.mp3)，本轮完成 | 1:13 | 开场主题重新出现，从小调逐渐落向柔和的相对大调，克制地释然 |

市集与主桥通过音区、层次与空间区分，保持长音与留白；结尾的放松来自和声落定和柔和钢琴，不使用轻快舞步、滑稽木管或庆典式节奏。音乐不随隐藏真相或路线答案变化。

- 当前五段文件索引：[collection.json](v4/collection.json)。开场与西门引用原文件，不覆盖已认可版本。
- 三段新谱面均保存在 `v4/*.score.json`，沿用现有 Swift 离线渲染与 Python 双遍响度匹配脚本。
- 每段48kHz双声道、约−19 LUFS；编码后的响度报告见各自 `*.mix.json`。
- [文件验证记录](v4/verification.json)：时长、可解码、有限采样、峰值、淡入淡出边界和音符重叠检查通过；音乐气质由实际试听判断。
- 本轮前检查点：`checkpoint/pre-score-collection-20260919`；完成版：`checkpoint/audio-04-complete-cues`。

重建新段落时，将已有命令中的版本与名称改为 `v4/market`、`v4/bridge`、`v4/ending`，原始 WAV 仍写到 `.local-artifacts/music-auditions/`。

## v3 · 西门深沉方向 · 2026-09-19

[Weight of Passage · 西门 v3](v3/west-gate.mp3) 长约59秒。重新编排为低音提琴长音、低音区弦乐、暗色音垫与少量慢速大提琴内声部；56 BPM，D minor / suspended harmony。和声约每8拍移动，旋律退到背景，不使用 v2 的短促拨弦、马林巴或跳跃木管，也没有反复催促的节拍。

- 53个较长音符；3.4kHz低通与34%大厅混响，使音色更暗、起伏更缓慢。
- 完整编排：[west-gate.score.json](v3/west-gate.score.json)。
- 编码实测：[west-gate.mix.json](v3/west-gate.mix.json)，−19 LUFS、−7.09 dBTP。
- v1、v2 均保留；v2 已由用户明确否定，不能作为后续关卡的风格参考。
- 本轮同时启用 Draco 朗读；检查点 `checkpoint/audio-03-somber-draco`。

## v2 · 西门差异化 · 2026-09-19

**不采用：用户反馈听感滑稽，与主题不符。下方仅保留这次试验记录。**

用户认可开场 **Last Light v1**，继续保留该版本；原西门 v1 与开场太相似，因此本次只重做西门。

[Papers and Pauses · 西门 v2](v2/west-gate.mp3) 长约 51 秒。改用拨奏弦乐、马林巴、低音提琴与单簧管；86 BPM、E Dorian、较干的房间混响。部分小节采用 3+3+2 重音与半小节停顿，中间留一整小节空白，只有一次简短主题变形。区别体现在配器、音符长短、节奏密度和结构，保持适合阅读与调查的空间。

- 完整编排：[west-gate.score.json](v2/west-gate.score.json)。
- 编码后实测：[west-gate.mix.json](v2/west-gate.mix.json)，约 −19 LUFS、−2.6 dBTP。
- `v1/` 的全部文件保持原样，未替换已认可的开场音频。
- 本轮检查点：`checkpoint/audio-auditions-02`。

## v1 · 2026-09-19

| 试听 | 时长 | 音色与意图 |
| --- | --- | --- |
| [Last Light](v1/last-light.mp3) · 开场／简报 | 1:07 | 稀疏钢琴主题、缓慢大提琴、逐渐展开的弦乐与柔和铺底；责任感中保留温暖 |
| [A Place to Wait](v1/west-gate.mp3) · 西门 | 1:03 | 同一主题的短句、较少的和声层、低弦乐和不规则柔和脉冲；等待与不确定感 |

两段共用 A–E–B–C 的短主题。开场为 A minor 并使用 Dorian 色彩；西门更多使用 Dorian 和声与悬置九度。全曲无歌词，不含真实环境录音、战斗声或倒计时提示。配乐只表现公开剧情阶段，不暗示隐藏路线状态。

### 保存内容

- `v1/*.score.json`：完整原创音符编排，时间单位为四分音符，16 小节、4/4 拍。
- `v1/*.mp3`：48 kHz 双声道试听文件，统一至约 −19 LUFS；实测峰值低于 −2.6 dBTP。
- `v1/*.mix.json`：编码后重新测量的响度、峰值、动态范围和时长。
- `scripts/render-music-audition.swift`：macOS 离线乐器渲染器；不启用麦克风或系统扬声器。
- `scripts/master-music-audition.py`：双遍响度匹配、1.2 秒渐入与4秒渐出、MP3 编码。

渲染器使用本机 macOS 的 General MIDI / DLS 乐器库，包含钢琴、大提琴、弦乐和暖音垫。系统乐器库本身没有复制或打包进项目。虚拟乐器音色属于风格验证阶段；确认方向后可以更换音源和混音，并制作无缝循环与分轨。

### 重建

需要 macOS 自带 Swift / AVFoundation 与乐器库，以及 Python 3、FFmpeg（含 libmp3lame）。在仓库根目录运行：

```sh
mkdir -p .local-artifacts/music-auditions
swift scripts/render-music-audition.swift assets/authoring/music-auditions/v1/last-light.score.json .local-artifacts/music-auditions/last-light.raw.wav
python3 scripts/master-music-audition.py assets/authoring/music-auditions/v1/last-light.score.json .local-artifacts/music-auditions/last-light.raw.wav assets/authoring/music-auditions/v1/last-light.mp3
swift scripts/render-music-audition.swift assets/authoring/music-auditions/v1/west-gate.score.json .local-artifacts/music-auditions/west-gate.raw.wav
python3 scripts/master-music-audition.py assets/authoring/music-auditions/v1/west-gate.score.json .local-artifacts/music-auditions/west-gate.raw.wav assets/authoring/music-auditions/v1/west-gate.mp3
```

Swift 原始渲染文件位于被 Git 忽略的 `.local-artifacts/`；可分享的 MP3 和可编辑的编排文件随本版本保存。

### 验证与版本

- 两份编排均完成离线渲染，检查了音符时间、MIDI 范围，以及同轨同音高的重叠。
- 编码后检查了两段时长、双声道、响度和真峰值；风格与试听满意度仍由实际试听决定。
- 开始前检查点：`checkpoint/pre-music-auditions-20260919`。
- 本轮试听检查点：`checkpoint/music-auditions-01`。

实现参考：[Apple AVAudioUnitSampler](https://developer.apple.com/documentation/avfaudio/avaudiounitsampler)、[Apple offline audio processing](https://developer.apple.com/documentation/avfaudio/performing-offline-audio-processing)。
