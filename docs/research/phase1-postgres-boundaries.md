# 一期 PostgreSQL 事务与执行器互斥证据

状态：2026-09-25 初稿，2026-09-26 审核补充。当前仓库经 `mise exec -- bun --version` 核对为 Bun 1.4.2。下文 PostgreSQL 18 容器观察来自前次研究记录；实验脚本未留存，本次没有重新运行实验。本文提出一期规格的候选方案，不代替后续讨论票的决定。

## 结论与理由

一期可先选 Bun 内建 `SQL` 作为唯一 PostgreSQL 客户端。Bun 1.4.2 已提供连接池、`sql.begin()` 事务、`sql.reserve()` 独占连接、`release()` 和 `sql.close()`，当前需求尚未显示必须引入另一客户端的缺口。[Bun 1.4.2 SQL 文档](https://github.com/oven-sh/bun/blob/bun-v1.4.2/docs/runtime/sql.mdx)。

这是对当前一期需求的比较：内建客户端已经覆盖短事务、固定会话和连接池；`pg` 或 `postgres.js` 也可用，但会增加一个客户端依赖，当前没有具体缺失能力足以抵消它。若实施验证发现 `reserve()`、断连或关闭行为不能满足下述锁安全条件，再针对观察到的缺口选替代客户端，不同时维护两套实现。[Bun 官方 SQL 文档的客户端比较](https://github.com/oven-sh/bun/blob/bun-v1.4.2/docs/runtime/sql.mdx#why-not-just-use-an-existing-library)。

执行器互斥建议使用 PostgreSQL **会话级** `pg_try_advisory_lock`，把持锁的 `reserved` 连接从开始处理一直保留到退出。该锁立即返回是否取得，连接断开时由 PostgreSQL 释放；普通事务结束不会释放。单次读写状态使用短事务，不能为了跨越浏览器请求或文件写入而持有长事务。[PostgreSQL advisory lock 语义](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS)、[函数定义](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)。后一句是基于工作边界的设计建议。

**`reserved.release()` 不是解锁。** 它仅把连接还给 Bun 连接池；会话级锁继续留在 PostgreSQL 后端。正常退出必须在同一 `reserved` 连接上执行一次 `pg_advisory_unlock`，确认返回 `true`，随后才 `release()` 并关闭池。连接已经失败时不能假设解锁成功，更不能继续发起远端或文件副作用；应停止执行器并关闭该池，让服务端在会话结束时回收锁。前次隔离实验记录称，释放给池后竞争者仍得不到锁；这与 PostgreSQL 官方语义一致，实施验收须独立重现。

若连接路径有 PgBouncer transaction/statement pooling，会话状态可能在事务后换到不同服务端连接，因而这个设计要求直连 PostgreSQL 或经过 session pooling。当前用户本机 PostgreSQL 运行方式应在接入时核对；一期不需要为了潜在代理另建兼容方案。[PgBouncer pooling 特性](https://www.pgbouncer.org/features.html)、[配置说明](https://www.pgbouncer.org/config)。

## 官方语义与实现约束

| 事项 | 已核对事实 | 对一期的约束 |
| --- | --- | --- |
| 事务 | Bun `sql.begin(callback)` 为 PostgreSQL 保留专用连接；回调成功提交，抛错回滚。[Bun 1.4.2 SQL 文档](https://github.com/oven-sh/bun/blob/bun-v1.4.2/docs/runtime/sql.mdx) | 一组状态变化用短事务提交；事务回调不执行网络下载、文件发布等外部操作。 |
| 会话锁 | PostgreSQL 会话锁不随事务回滚释放，可以重复取得且每次取得都需要相应解锁；会话结束会释放。[PostgreSQL 显式锁](https://www.postgresql.org/docs/current/explicit-locking.html#ADVISORY-LOCKS) | 固定一个命名空间和 key；只取得一次，解锁一次；不要把普通事务连接当作长期锁连接。 |
| 非等待互斥 | `pg_try_advisory_lock` 立即返回布尔值。[PostgreSQL 管理函数](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS) | 第二执行器得到 `false` 时清楚报告正在运行，且不开始 Post 工作。 |
| 连接池 | Bun 首次执行查询时建连；`reserve()` 取出独占连接，必须显式 `release()`；`close()` 可等待查询完成或按超时强制关闭。[Bun 1.4.2 SQL 文档](https://github.com/oven-sh/bun/blob/bun-v1.4.2/docs/runtime/sql.mdx) | 清理路径用 `finally`；不要把会话锁放到普通 `sql` 池查询上，因为下次查询可能换连接。 |
| 连接故障 | PostgreSQL 的连接错误类别含 `08007 transaction_resolution_unknown`。[PostgreSQL 错误码](https://www.postgresql.org/docs/current/errcodes-appendix.html) | 提交时失去回执不能仅凭异常断言事务回滚。恢复按持久事实重新读取，外部文件按发布意图核验。 |

连接仍在时可以对持锁的 `reserved` 定期执行轻量查询，例如 `SELECT pg_backend_pid()`；失败立即阻止后续副作用。`onclose` 可作为额外信号，但不能作为唯一信号：前次实验记录称，终止后端后首次失败查询发生时 `onclose` 尚未出现，到第二次失败查询时才观察到回调。心跳也不能消除“检查成功后、外部请求前”连接恰好断开的时间窗。这是会话锁与外部系统副作用之间固有的非原子边界；一期规格应写明检测失败即停止、恢复核对事实，不能声称锁能使文件和 Grok 请求具有数据库事务的原子性。该时间窗的故障注入仍待实现时验证。

Bun 1.4.2 文档列有 `idleTimeout`、`maxLifetime`、`connectionTimeout`、`onclose` 及 `close({ timeout })`，但未明确保证长期保留的 `reserved` 连接如何受空闲或寿命设置影响。锁连接必须由运行期持有且可检查；具体池配置和断线通知时序需要在最终封装上以真实 PostgreSQL 验证，不从选项名称推断安全性。[Bun 1.4.2 连接池与保留连接文档](https://github.com/oven-sh/bun/blob/bun-v1.4.2/docs/runtime/sql.mdx)。

正常连接上解锁若失败或结果未知，应让连接/池退出，不能把可能仍持锁的连接交给后续运行。隔离实验未验证 Bun `close({ timeout: 0 })` 对正在使用的保留连接的全部行为；实施前需对停止和清理路径做真实数据库测试。

## 前次隔离实验记录

前次研究记录：在本机 Docker 中临时运行 `postgres:18-alpine`，仅暴露随机分配的 `127.0.0.1` 端口，数据库 `wf_probe`。客户端是 mise 锁定的 Bun 1.4.2，使用两个独立 `SQL` 实例。记录称未连接或枚举现成本机业务数据库；实验脚本未提交，容器已删除。本次仅核对官方语义与当前 Bun 版本，没有把这些记录当作新实验结果。

| 场景 | 观察 |
| --- | --- |
| `sql.begin()` 内插入后主动抛错 | 回调错误传出，另一查询读取行数为 0。 |
| `reserve()` 后获取会话锁，第二实例竞争 | 首个返回 `true`，竞争者返回 `false`。 |
| 调用 `reserved.release()` 再从同一池 `reserve()` | 新 wrapper 使用同一后端 PID；竞争者仍返回 `false`。这证明 `release()` 不可当作 `pg_advisory_unlock`。 |
| 原连接执行 `pg_advisory_unlock` | 返回 `true`；竞争者随后取得锁。 |
| 持锁连接的后端被 `pg_terminate_backend` 终止 | 下一次 `reserved` 查询报 `PostgresError`；另一实例随后可取得锁；原 wrapper 再查询报 `Connection closed`。 |
| `onclose` 时机 | 终止后首次查询错误时事件数组为空，后续才观察到 `onclose`。 |

这些是前次记录中的 Bun 1.4.2 + PostgreSQL 18 窄观察，因脚本已删除而不能从附件复现；它们不证明长期空闲断连时回调及时，也不证明所有提交回执丢失情形。Docker 容器可提供真实事务、真实会话和 TCP 断连边界；对应自动化应按集成/边界测试理解，不当作纯单元测试。本次 Docker daemon 不可用，未运行容器；这不改变官方锁语义，也不把实施所需的集成验收视为通过。

## Schema 初始化与验收边界

一期只面向当前代码和新 schema。建议提交一份当前 schema 的 SQL 初始化脚本和一个显式初始化命令，在用户指定的**独立项目数据库**内执行；以事务创建一期实际需要的 Run、Post 工作及保存事实表、约束和索引，成功后再开放归档命令。应用启动时只验证所需结构，不悄悄建表或更改已有结构；不引入历史版本迁移器。若需重复执行初始化，先检查预期对象和结构，结构不符就报错；单用 `CREATE TABLE IF NOT EXISTS` 不能保证已存在表符合定义。[PostgreSQL `CREATE TABLE` 文档](https://www.postgresql.org/docs/current/sql-createtable.html)。具体字段仍由领域状态讨论票决定。

自动化最低应使用临时 PostgreSQL 容器、临时归档目录，验证：事务回滚与提交、两个**独立进程**竞争同一锁、持锁进程异常结束后另一进程接管、连接中断即停止新的副作用、文件已发布但保存事务结果未知后的读取和核验、正常停止的解锁及池关闭。测试只清理自己创建的容器、数据库和目录。普通状态逻辑仍可在内存假件下快测，但不能由它证明事务、锁或 TCP 连接故障语义。实际本机 PostgreSQL 只在用户明确指定的本项目数据库上检查连接、权限和所需结构；不读取其他库、凭据或业务数据。

已确认的一期运行边界是数据库连接参数分别配置，`status` 只查询数据库持久事实，独立于浏览器及文件系统；每次处理启动新 Run，跨 Run 的未完成 Post 由 `retry` 接续。锁的生命周期因此应覆盖整个写入型 Run；只读 `status` 不占用执行器锁。锁 key 的精确选择、读写用例如何共享连接池及错误分类交由状态设计和运行期接口讨论确定。这些是依据现行主工作区 `ARCHITECTURE.md` 和 Beads 的「一期命令、配置与结果边界」决议作出的应用建议；研究分支不复制尚未提交的权威正文。

## 尚待实施前验证

- 在最终客户端封装与池配置下，用一个独立进程持有 `reserved` 会话超过配置的空闲及寿命阈值；另一个进程定时竞争锁。持锁进程仍能用原后端检查时，竞争者始终须得到 `false`；若连接被替换，则停机处理，调整配置并重测。
- 确认实际数据库连接路径没有 transaction/statement pooling；若存在代理，应使用直连或 session pooling，再重复锁竞争实验。
- 用两个独立进程验证取得锁、竞争失败、正常解锁、持锁进程异常结束后的接管；正常解锁返回值为 `true`，异常退出后新进程最终能取得锁。只用同进程两个 `SQL` 实例不足以证明进程故障行为。
- 在提交前后分别注入断连：提交前失败须回滚；提交时失去回执须由新的连接读取持久事实，再按文件发布意图核验，不根据异常类型直接重复发布。故障注入点、观察到的数据库行和文件校验结果应随测试保留。
- 在持锁连接断连、用户停止、`close()` 同时出现的场景验证：不再启动新 Post 或文件副作用，资源收尾有界；正常解锁失败时不把可能持锁的连接放回池。

以上各项是交付门槛建议，尚未在本次调研中宣称通过。
