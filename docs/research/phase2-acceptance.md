# 二期自动化交付覆盖核对

核对对象：`grok-media-saver-fa3` 实现基线 `10bc4ba7b196516c1c6570489cae1999a07999ca`，加本票文档同步后的候选。行为契约以[二期单 Post 完整归档规格](../specs/phase2-archiving.md)为准；本报告逐项核对规格的 40 条用户故事和 7 组自动化验收矩阵，区分自动化证据、当前限制和现场待验事项。

## 40 条用户故事

| # | 自动化证据或当前状态 | 未验证范围 |
| --- | --- | --- |
| 1 | `tests/cli/archive-post.test.ts`：纯 UUID 参数、真实 CLI 精确归档路径（P2-02）。 | 不验证真实 Grok 的目标关联语义。 |
| 2 | `archive-post.test.ts`：正式文件核验、保存提交、删除意图和认可响应后结清（P2-02 S1/S2）。 | 浏览器 fake 不证明真实 DELETE 副作用。 |
| 3 | `tests/cli/save-post.test.ts`、`save-first-page.test.ts`：保存入口测试；归档相关用例确认只有 `archive post` 触发移除。 | 无额外现场 DELETE。 |
| 4 | `archive-post.test.ts`：已有 save 目标提升并复用同一版本，P2-02。 | 真实文件和远端仍由自动化隔离环境提供。 |
| 5 | `archive-post.test.ts` 与 `tests/cli/retry.test.ts`：工作目标保留并验证纯保存不升级，P2-08。 | 无。 |
| 6 | `archive-post.test.ts`：保存入口拒绝未结清归档工作；`save-first-page.test.ts` 覆盖单页继续，P2-02。 | 无。 |
| 7 | `tests/cli/save-first-page.test.ts`：冲突项报告且继续处理其余成员。 | 不覆盖所有远端成员排列。 |
| 8 | `retry.test.ts`：启动时固定未完成集合并逐项处理（P2-08 S2）。 | 运行期间新增 Post 不纳入本 Run。 |
| 9 | `retry.test.ts`：混合目标只按各自目标接续；纯 save 不升级，P2-08。 | 无。 |
| 10 | `retry.test.ts`：空 retry 仅需 DB、记录空 Run 且不启动浏览器。 | 不验证用户 DB 的连接配置。 |
| 11 | `archive-post.test.ts`、`verify.test.ts`：大小和 SHA-256 核验保存及绑定版本。 | 不搜索其他归档目录。 |
| 12 | `archive-post.test.ts`：正式文件冲突不覆盖且不 DELETE（P2-02 S1）。 | 操作系统特有文件系统故障另有平台限制。 |
| 13 | `archive-post.test.ts`：请求日志核对精确 Post；身份不符时不下载、不删除。 | 真实关联 Post 副作用未现场验证。 |
| 14 | `archive-post.test.ts`：删除意图绑定 Post 与确切媒体版本；DB 外键拒绝其他 Post 版本（P2-02）。 | 无。 |
| 15 | `archive-post.test.ts`：意图提交不确定时无后续 DELETE（P2-02）。 | 测试故障点不等价于断电。 |
| 16 | `archive-post.test.ts`：DELETE 错误/未知不会被当作“仍存在”或成功，P2-02/06。 | 真实网络与服务端失回执未现场验证。 |
| 17 | `archive-post.test.ts`：遗留意图以精确同目标 GET 核对（P2-04）。 | 远端 GET 语义由受控能力 fake 表示。 |
| 18 | `archive-post.test.ts`：不认可响应和重定向保留未知（P2-02/04）。 | 未对真实 Grok 未知响应形状做新探测。 |
| 19 | `archive-post.test.ts`：确认仍存在后结清旧意图、重新核验资格并在本 Run 最多新删一次（P2-05）。 | 自动化不访问真实账号。 |
| 20 | `archive-post.test.ts`：DELETE 和两阶段 GET 固定预算及条件重试（P2-06）。 | 不推断浏览器后台或服务端请求次数。 |
| 21 | `archive-post.test.ts`、`retry.test.ts`：详情、媒体、GET、DELETE 共享非零调度许可。 | 不覆盖 Chrome 自身的后台流量。 |
| 22 | `archive-post.test.ts`：首次停止禁止新请求，在原期限内收集在途 DELETE 响应（P2-03）。 | 真实 Extension 请求取消行为未验收。 |
| 23 | `archive-post.test.ts`：P2-03 S2 真实子进程分别在首次和第二次 SIGINT 后断言退出码与待核对状态。 | 不验证用户键盘和终端设备差异。 |
| 24 | `archive-post.test.ts`、`tests/core/request-scheduler.test.ts`：认证与限流阻挡不继续本 Run。 | 真实账号状态不参与门禁。 |
| 25 | `archive-post.test.ts`、`retry.test.ts`：断连、丢锁和请求停止未知时停止推进并保留事实。 | 真实浏览器连接故障未现场制造。 |
| 26 | `archive-post.test.ts`：P2-05 的事务提交失回执；P2-12 S2 在删除意图后、远端响应后及结清提交后对子进程 SIGKILL，再按真实 PostgreSQL 持久事实恢复。 | 不声称具备断电级或任意进程崩溃证明。 |
| 27 | `archive-post.test.ts`：确认远端移除后本地文件异常仍保留移除事实（P2-04）。 | 无。 |
| 28 | `archive-post.test.ts`：只核验/补救绑定版本；错误内容不改绑（P2-07）。 | 没有第二来源或其他目录搜索。 |
| 29 | `archive-post.test.ts`：原来源失败保留未结清事实，不重新选详情或删除（P2-07）。 | 实际 Grok 来源长期可用性未验证。 |
| 30 | `archive-post.test.ts`、`verify.test.ts`：已结清 Post 再处理跳过；verify 异常不重开归档。 | 不覆盖用户外部改动后远端行为。 |
| 31 | `archive-post.test.ts`、`run-summary.test.ts`：业务结果、远端观察、DB 记账和清理结果分开表达（P2-11）。 | 无。 |
| 32 | `archive-post.test.ts`、`retry.test.ts`、`verify.test.ts`：CLI 成功、执行失败、参数错误和停止退出码。 | shell/终端外部包装器行为不在本测试范围。 |
| 33 | `tests/cli/run-summary.test.ts`：五类互斥摘要、混合 retry 和清理失败分类（P2-11）。 | 摘要不表示 Saved 全局进度。 |
| 34 | `run-summary.test.ts`：提交失回执或遗留 Run 保持计数未知，不从 Post 状态倒推。 | 历史不确定计数不会被重建。 |
| 35 | `retry.test.ts`、`run-summary.test.ts`：status 读取持久事实；空 retry/status 不需浏览器。 | status 不检查远端或本地文件当下状态。 |
| 36 | `tests/cli/verify.test.ts`：优先核验绑定版本，报告当前目录结果，不修改终态。 | verify 不证明远端仍存在或文件可恢复。 |
| 37 | `archive-post.test.ts`、`verify.test.ts`、`retry.test.ts`：清理失败不抹去已提交的归档或核验事实。 | 真实 Chrome 清理故障未现场验收。 |
| 38 | 本候选必须实际通过无筛选 `just gate-full`；运行的 SHA、退出码及覆盖摘要记录在“交付门禁”。 | 自动化不连接私人 DB、Chrome、Extension 或 Grok。 |
| 39 | 规格明确正式现场验收由用户后续人工执行；这次未执行，操作提示见下文。 | 所有真实图片/视频 DELETE、在途停止和正式登录态操作。 |
| 40 | `ARCHITECTURE.md` 与 `implementation-roadmap.md` 固定复用同一 Post archiver 的方向；本期代码只实现单 Post 与 retry。 | 三期连续读页调度尚未实现。 |

## 七组自动化验收矩阵

| 规格矩阵 | 主要证据 | 结论与未覆盖边界 |
| --- | --- | --- |
| 工作目标与删除资格 | `archive-post.test.ts`：P2-02 保存资格、正式文件核验、身份/冲突/未结清发布意图、意图提交及发送前停止/丢锁。 | 已有 Application 与真实 CLI 用例；假浏览器不证明真实远端结果。 |
| 精确目标与响应判据 | `archive-post.test.ts`：精确 Post 请求、受认可成功、仍存在、未知响应、重定向及不认可结构。 | 协议反应由能力 fake 控制；未增加现场协议实验。 |
| 未知恢复与预算 | `archive-post.test.ts`：P2-04/05/06 遗留意图和本次未知、每阶段 GET 预算及条件重试；`retry.test.ts`：混合目标许可共用。 | 未证明 Chrome/网络之外部代理实际取消状态。 |
| 真实 DB 与进程恢复 | CLI 测试使用隔离 PostgreSQL、真实文件、真实子进程及提交失回执 helpers；fa3.12 已交付回滚重启、进程中断和跨目标故障用例。 | 仅覆盖声明的关键窗口，不声称断电级恢复或穷举所有提交点。 |
| 已移除后的文件接续 | `archive-post.test.ts`：P2-07 缺失文件、原来源恢复、冲突、错误内容和更换目录。 | 不扫描旧目录，不改绑新版本。 |
| 停止、故障与清理 | `archive-post.test.ts`：P2-03 原期限收尾、停止、丢锁、连接与独立清理；`retry.test.ts`：停止后未开始项目和清理结果。 | 真实 Chrome/Extension 断连、请求取消、清理失败待人工观察。 |
| 结果、查询与终态 | `run-summary.test.ts`、`verify.test.ts`、`retry.test.ts`、`archive-post.test.ts`：摘要、退出码、status、verify、已结清跳过及清理错误。 | status 只展示 DB 事实；verify 只报告本地绑定版本核验。 |

## 交付门禁

需在文档改动提交后的同一干净候选上运行无筛选 `just gate-full`。实际验证采集目录、候选 SHA、开始/结束时间、退出码、测试收集数及结果随本票实施报告和绑定日志交付；失败或候选变化必须重新验收，不能合并不同候选的结果。

## 正式现场验收

正式现场验收未执行，由用户在实现交付后另行操作。自动化测试与门禁使用隔离 DB、临时目录、真实本地子进程及浏览器能力 fake；这些证据不证明真实 Grok DELETE、实际账号关联影响或 Chrome/Extension 取消和关闭行为。既有协议实验只证明已观察样本，不替代产品验收。本报告不授权远端删除。

用户后续如决定执行，按自己的精确授权样本和当前 schema 操作：

1. 准备独立数据库和归档目录，用 `db init` 确认当前 schema；确认同一 Grok 账号贯穿处理和可能的恢复。
2. 对明确授权的精确 Post 执行 `archive post <Post-ID>`，核对主体媒体保存、移除响应、结清事实和终端结果；未授权的 Post 不执行。
3. 用 `status` 与 `verify <Post-ID>` 分别核对数据库事实和当前目录文件；再次处理已结清 Post 应直接跳过。
4. 仅在操作范围明确时观察停止和显式恢复；对未知 DELETE 先查询同一目标，绝不为补证据盲目重复删除或扩大样本。
5. 分开记录自动化证据和现场缺口；样本未覆盖的图片/视频形态、请求停止或清理问题保持“未验证”。

现场 checklist 是后续用户操作提示，不属于自动化门禁，也不阻塞本地候选的自动化验收或三期连续读页工作。
