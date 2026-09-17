# SQLite 设计附件

这些文件是可执行的数据库设计与验证附件；没有启动游戏服务器、浏览器或模型服务。

| 文件 | 用途 |
|---|---|
| `001_initial.sql` | 空数据库初始迁移；完整表、索引、约束、触发器；事务失败整体回滚 |
| `transactions.sql` | 八个按 `-- name:` / `-- end` 划分的独立参数化事务模板 |
| `queries.sql` | 幂等、投影、调度、对账、恢复的命名查询 |
| `DATA_DICTIONARY.md` | 逐字段类型、空值、默认值、语义、主外键、索引 |
| `fixtures/reference_seed.sql` | 两局合成测试数据，`mode=test`；没有公开私人世界真相 |
| `fixtures/ids.json` | fixture 的确定性 UUID/哈希；仅为测试输入定位 |
| `../verification/test_database.py` | 标准库 unittest；每例独立内存数据库 |
| `../03_LLD_数据库.md` | 事务边界、隔离、故障恢复与迁移说明 |

从交付包根目录运行：

```sh
python3 verification/test_database.py
```

Python 自带 SQLite 需 **3.38+**；所有连接显式启用 `PRAGMA foreign_keys=ON`。文件数据库设置 `journal_mode=WAL`、`busy_timeout=500`；可靠提交参考设置 `synchronous=FULL`。迁移只对空数据库执行一次，不能把 fixture 载入正常游戏数据库。测试只使用 `:memory:`，不改动现有游戏数据。

事务模板使用驱动参数绑定。读取一个命名块，按 SQLite 完整语句边界逐条 `execute(statement,bindings)`，遇到任何错误（包括 COMMIT 的 deferred FK 错误）必须 `ROLLBACK`。不要直接对整份文件执行 `executescript`，也不要把用户内容拼入 SQL。`tx_assert` 是每连接 TEMP CHECK 表，用于在持有写锁后再次验证前提；生产服务将失败映射为 API 定义的错误。

调用模板前完成授权、schema、内容与 policy 校验；幂等命中优先返回旧成功回执；到期系统事件先单独提交。模板中的事件、公开投影、快照、哈希、AI 输入均来自对应服务的白名单构建器。SQLite 不负责证明自然语言含义、隐藏信息没有被字符串透露、模型引用真实，或 schema 附件已经校验。

参考 profile 为 `review`，正常模式被 SQL 拒绝；仅整局资源及更正另占额度为确认要求。模板的累计上传与 NPC 自动上报是待评审参考方案，不能当作用户批准。
