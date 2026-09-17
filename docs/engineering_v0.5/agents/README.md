# Agent 交付内容

本目录是可校验的工程设计与参考代码，不是已运行的游戏服务。`SINGLE_PLAYER_REFERENCE` 仍为 review profile；未启用真实模型调用。

- `contracts.schema.json`：Advisor/Evaluator 入参与结果、公共 Job 视图，JSON Schema 2020-12。
- `tools.schema.json`：只读资料访问端口的闭合输入与结果协议。
- `prompts/*.system.md`：实际完整系统提示词。加载原文后只追加一条经过校验的 JSON user message。
- `modelAdapter.ts`、`model-config.example.json`：无供应商绑定的 HTTP JSON 网关与 mock 接口，默认不调用网络。
- `context_reference.py`、`contract_guards.py`：确定性输入组装、精确引用与时点验证。
- `fact-rules.json`、`public-fact-catalog.json`、`fact_rules_reference.py`：公开资料判定、机会与反例、四维观察参考规则。
- `offline_fallback.py`、`orchestration_reference.py`：离线输出及重试/缓存/过期关键状态参考。
- `fixtures/`：完整正例、可执行负例与行为反例；`validate_agents.py`、`validation-results.json`：离线验证与结果。

从项目根目录运行（需 Python 3 与 jsonschema 4.18+）：

```bash
python -B outputs/LAST_MILE_ENGINEERING_v0.5/agents/validate_agents.py
```

完整实现顺序、投影映射、未确认产品条件和边界见上一级 `05_LLD_Agent系统.md`。自然语言正确性、提示注入抵抗能力和心理评价效度不由本契约测试证明。
