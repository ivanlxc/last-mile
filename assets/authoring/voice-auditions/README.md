# English narrator auditions · v1

本轮提供游戏朗读音色候选，尚未替换游戏配置。检查时本机配置为 `aura-2-thalia-en`；当前游戏服务端仅允许 Thalia 与 Apollo，选定其他候选后需扩展服务端允许列表并更新配置。

所有候选通过已有 Deepgram 连接实际生成，同一段虚构英文线索、默认语速与音高。只发送下列试听文字，没有发送私有剧情、存档或其他用户数据。API key 仅从本机环境读取，不写入资产、manifest 或日志。

> West Gate checkpoint. The main road is visible, but permission to pass has not been confirmed. Check the latest report before choosing your route.

## 合集与单独试听

[四种音色连续试听](v1/voice-comparison.mp3)，约43秒。每段之间间隔1秒，仅以固定增益将响度匹配至约 −21 LUFS，没有改变语速、音高或声音特征。具体时间及增益见 [comparison.json](v1/comparison.json)。

| 开始 | 音色 | 官方声线描述的中文概括 | 原始单独样本 |
| --- | --- | --- | --- |
| 00:00 | Athena | 美式女声；沉稳、流畅、专业 | [Athena](v1/athena.mp3) |
| 00:10 | Orion | 美式男声；平静、亲和 | [Orion](v1/orion.mp3) |
| 00:23 | Draco | 英式男中音；温暖、亲和 | [Draco](v1/draco.mp3) |
| 00:33 | Helena | 美式女声；自然、友好、略带沙哑 | [Helena](v1/helena.mp3) |

声线信息来源：[Deepgram Aura voices](https://developers.deepgram.com/docs/tts-models)，核对日期2026-09-19。适合游戏哪位角色、哪种信息属于创作选择，应以实际试听为准。

## 重建与保存

`scripts/generate-voice-auditions.mjs` 使用现有服务器侧 `DEEPGRAM_API_KEY` 生成这四份短样本；只请求官方 `https://api.deepgram.com/v1/speak`，已存在的文件会跳过。运行时会调用已配置账户的合成接口：

```sh
node --env-file-if-exists=.env scripts/generate-voice-auditions.mjs
```

模型名、试听文本和来源见 [manifest.json](v1/manifest.json)。合集由四个原始样本按 manifest 顺序拼接，按 comparison.json 增益调整、段间插入1秒静音后编码为48kHz单声道 MP3；单独样本保留供应商原始输出。

四段原始样本与合集均可解码，时长、有限采样和非削波峰值检查通过。本轮与西门 v2 一起保存在 `checkpoint/audio-auditions-02`；游戏的朗读默认配置保持原状，等待音色选择。
