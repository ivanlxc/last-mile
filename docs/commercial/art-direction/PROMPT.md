# 概念图生成记录

- 工具：内置 `image_gen.imagegen`，通过 imagegen skill 使用；未调用项目 `.env` 中的模型密钥。
- 输入：`docs/commercial/screenshots/market-courtyard-en.png`，作为待改造的灰盒截图。
- 输出：`market-cinematic-concept-v1.png`。
- 用途：美术目标讨论，非可运行游戏资产、非实际渲染性能证明。

## 完整提示词

```text
Use case: stylized-concept.
Asset type: clearly labeled ART DIRECTION CONCEPT, not an implemented game screenshot, for LAST MILE, a single-player humanitarian convoy investigation game.
Edit the supplied screenshot into a richly detailed cinematic photorealistic visual target. The source is a blockout: retain the human eye-height perspective and general navigable street/courtyard arrangement, close covered worktable with a crew member at left, a second crew member at a stall midway on the right, distant recon workstation and enclosing fictional Middle Eastern market architecture. Replace all placeholder geometry with convincing human-scale detailed forms. REMOVE the large software dashboard header/footer, floating name billboards and all existing interface text. Fill almost the entire image with the environmental scene, landscape wide composition. No player weapon.
Build a contemporary fictional Levantine market staging courtyard: layered aged pale limestone and lime-plaster facades, deep inset doors and shutters, subtle chipped wall edges revealing stone, realistically beveled architectural details, modest metal balconies and practical exterior wiring. Carefully arranged cloth awnings with natural folds, wooden produce crates, woven baskets, worn work surfaces, small coherent everyday props, believable door handles, radio equipment and paper folders on the left table. No plot-revealing readable evidence. Ground with uneven pale stone paving, fine dust accumulating at edges and realistic contact shadows. Two adult civilian aid-crew characters in practical clothing, natural anatomically correct proportions, convincing fabric and skin, standing casually rather than combat poses. The nearer male intelligence officer is beside a radio table; the farther female liaison is under a right canopy. Do not add crowds.
Look: prestigious high-end narrative PC game's aspirational art direction, physically plausible roughness and material variation, restrained micro-detail, excellent natural global illumination, warm late-afternoon raking sunlight against cool sky-lit shade, subtle dusty atmosphere and rich depth. Match a playable camera: eye height about 1.68 metres, 35mm-ish lens, natural perspective, foreground and background legible, no cinematic bokeh, no overblown bloom, no oversaturated teal-orange grade. Calm but tense, lived-in rather than bombed-out. Keep the central walkway clear and the set buildable as a small modular game environment. No giant monuments, no religious stereotypes, no gore, no warfare spectacle.
Text: add only a refined small dark editorial caption strip in the lower left with exact lines 'LAST MILE / VISUAL TARGET' and 'CONCEPT ART — NOT IN-GAME'. This disclaimer must be plainly readable. No other text or logos.
Deliver a polished wide image showing the concrete improvement in architecture, PBR materials, lighting, scene dressing and character quality over the blockout.
```
