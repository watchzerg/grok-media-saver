# Grok 归档核心模型与 HTTP 交互参考

## 来源与适用范围

本文于 2026-09-26 从 `grok-image-saver/docs/core-archive-model-and-http.md` 迁入，按本项目现行文档清理。HTTP 观察发生于 2026-08-17、2026-09-21；补充下载证据来自 2026-09-25。迁移仅整理文档，未重新请求 Grok，也未验证当前接口。

本文保留可复用的对象边界、请求形状和恢复风险，供后续实现参考。产品行为以[产品目标](../specs/product-goals.md)、[领域词汇](../../CONTEXT.md)和[架构设计](../../ARCHITECTURE.md)为准。旧项目规格、响应样本和策略数值不自动成为本项目契约；Grok 未承诺这些内部接口长期稳定。

下文“Saved 列表”统一指 `https://grok.com/imagine/saved`。旧证据中的 History / All 是此前对此入口的称呼，不表示另有来源；请求参数 `WORKSPACE_KIND_IMAGINE_ALL` 保留原样。

## 1. 可复用的对象边界

| 对象 | 参考含义与边界 |
| --- | --- |
| Saved 列表 | 一页是一次观察，不是固定的全部任务集合。旧观察中包含未点红心的 Post，不能等同于 Liked。 |
| Post | 以详情页路径中的 asset 身份标识单项工作，是保存和远端移除的目标。关联链接可指向其他 Post，不扩展当前 Post 的范围。 |
| 媒体及选定版本 | 只保存当前 Post 自身、能够唯一确定的完整媒体。精确 content key 用于识别内容；预览、缩略图和未知 key 不能靠名称或大小猜成完整版本。具体持久标识由实现规格确定。 |
| Liked / Unlike | 红心收藏关系及其移除。Unlike 成功不等于 Post 离开 Saved 列表。 |
| Post Removal | 对精确 Post 的远端移除结果，独立于本地保存结果记录。删除是否影响关联 Post 的可下载性尚未验证。 |
| Run 与 Post 工作 | 本项目每次启动产生新 Run，Post 工作独立保存事实并可跨 Run 接续。第一页成员和遍历位置只在内存中保留。 |

例如，图片 A 的详情链接到视频 B 时，处理 A 只保存 A 自身媒体；若 B 也是列表项，再独立处理 B。不展开整个 conversation，也不把取消 A 的红心当成删除 A。

## 2. HTTP 观察与证据边界

以下 API 路径相对 `https://grok.com`；`<assetId>` 是精确 Post 身份。字段仅列关键结构，不是完整 schema。

| 用途 | 请求与关键参数 | 历史观察及使用限制 |
| --- | --- | --- |
| 页面入口 | `GET /imagine/saved` | 列表页面；实际列表数据由 `/rest/assets` 返回。[E1]、[E3] |
| 读取第一页 | `GET /rest/assets?pageSize=40&orderBy=ORDER_BY_CREATE_TIME&workspaceKind=WORKSPACE_KIND_IMAGINE_ALL` | 返回 JSON `assets` 数组，可带 `nextPageToken`。2026-09-25 demo 得到 HTTP 200、40 项。错误、登录挑战或结构不符不能解释为空页。[E1]、[E3] |
| Post 页面 | `/imagine/post/<assetId>`，可能带 `conversation` query | 路径 ID 是单项目标；query 仅是关联上下文，不能据此删除 conversation。[E2] |
| Post 详情 | `GET /rest/assets/<assetId>` | 2026-09-25 demo 读取同一 ID 的详情，以 `key`、`mimeType`、`sizeBytes` 下载当前媒体。应核对目标与完整内容身份，不能将旧解析器的多种响应布局当作线上保证。[E3] |
| 媒体字节 | `GET <选定媒体的精确 content key>`，可能位于 `assets.grok.com` 或 `videos.grok.com`；可带 `Range: bytes=<start>-<end>` | 2026-08-17 登录 Chrome 的单字节探测返回 `206` 与可读 body，匿名请求返回 `403`；单字节成功不证明完整传输。2026-09-25 完整下载了一张 JPEG 和一个 MP4，范围及限制见下文。[E1]、[E3] |
| Liked 关系 | `POST /rest/media/collection/for-asset` | 旧摘要确认用途为单 asset 的 collection membership 查询，未保留可照抄的精确请求体和响应字段。归档不需要先查 Liked。[E2] |
| Unlike | `POST /rest/media/collection/assets/remove` | 受控样本返回 `200`、`{"removedCount":1}`，目标仍留在列表。未保留可照抄的请求体；不能代替 Post Removal。[E2] |
| 精确删除 | `DELETE /rest/assets/<assetId>` | 三个受控样本返回 `200` 与 `{}`，刷新后目标不再出现。这是有限成功样本；本项目具体成功判定须在实现规格与现场验证中确定。[E2] |
| 删除结果核对 | `GET /rest/assets/<同一 assetId>` | 一个已知成功删除的图片样本返回 `404`、`{"code":5,"message":"Asset not found","details":[]}`。不是失回执恢复实验，不证明重复 DELETE 安全，也不证明所有 404 都表示删除成功。[E2] |

删除是不可撤销的远端操作。本文只保留历史观察，不授权执行。后续实现必须先满足本地安全保存、精确目标绑定和删除意图持久化；未知结果先核对同一目标。列表缺席、页面重定向、任意 `404` 或单独一个 `200` 都不足以替代明确的目标与结果证据。

### 分页与第一页循环

2026-08-17 的记录显示：后续页在相同查询参数上增加 URL 编码的 `pageToken=<opaque>`，其值来自上一页的 `nextPageToken`；当时共遍历 24 页、946 个唯一 asset。[E1] 这只证明当时的分页能力。

本项目采用处理第一页、逐条移除后再读第一页的流程，不把旧全量遍历引入归档。第一页无法提供可靠总数或全局完成百分比。旧仓库的 `{entries:[{asset:…}],nextCursor}`、`assetDetail` 等合成样本是测试输入，不与现场证据等价。

### 媒体传输

2026-09-25 demo 经浏览器 `fetch` 按 256 KiB 分块读取，取得一张 JPEG 和一个 MP4，并核对详情大小、响应 MIME、文件签名及落盘 SHA-256。浏览器脚本有时读不到 `Content-Range`；demo 在该头不可读时依赖详情 `sizeBytes`、块长度和累计长度。[E3]

这证明两个样本可完整保存，不构成通用 Range 校验方案。历史参考提出的大文件验证已由 2026-09-26 用户范围修订取消；当前采用单响应流，普通媒体的中断、版本变化和资源清理以[一期规格](../specs/phase1-saving.md)为准，不继承历史 Range 验收清单。分块大小不是固定契约。真实 content key 可能包含敏感信息，不应直接进入普通日志或研究附件。

## 3. 归档流程与恢复参考

本项目已接受“第一页 → 逐 Post 安全保存 → 精确移除 → 再读第一页”的方向。具体启动、显式重试、停止、阻挡、完成与无进展判定统一见[架构设计](../../ARCHITECTURE.md)，本文不另维护算法或状态机。

HTTP 调用、数据库提交和文件发布之间无法形成一个共同的原子事务。实现时需要保留足以回答以下问题的事实；这是持久职责提示，不是表结构要求。

| 事实类别 | 恢复时要回答的问题 |
| --- | --- |
| Run 与执行结果 | 本次执行为何结束，哪些工作仍未完成？新的执行是否受既有全局阻挡约束？ |
| Post 与选定媒体 | 精确处理哪一项、哪一个版本？是否仍能唯一确认当前媒体？ |
| 文件发布 | 文件是否完整、大小及 SHA-256 是否匹配？是否发生发布成功但数据库未提交？已有文件冲突时是否阻止覆盖和删除？ |
| 删除意图与结果 | DELETE 是否可能已经发出？是否需要先查询同一目标？不能判断时是否保留未知状态？ |
| 等待与全局阻挡 | 重启后是否仍需遵守等待截止时间或人工恢复要求？API 和媒体请求是否都遵守停止决定？ |

下载完成不能代替移除完成；调用超时不能证明远端操作未执行。已确认的远端事实也不能因本地文件异常而抹去。这些边界需要通过受控故障验证，不能只用一次正常下载或删除证明。

## 4. 清理掉的旧项目假设

原文中的下列内容属于旧项目选择，迁移后不再作为可直接照搬的方案：

- 原 Run 跨重启延续、服务自动恢复，以及独立暂停状态。本项目每次启动建立新 Run，用户显式恢复工作。
- 自动重试额度跨重启持久化。本项目计数保存在当前执行的内存中，持久保存处理事实与必要阻挡。
- 所有远端请求共用等待及累计计数。本项目 API 节奏与媒体传输分开控制，媒体仍遵守停止和全局阻挡。
- 必须字节级续传。首版保证 Post 级恢复，未完成媒体允许重新下载。
- 固定的 10 秒轮间等待、2–5 秒请求间隔、每 50 次休息、15 分钟冷却，以及各阶段具体重试次数。数值由本项目实现规格确定。
- 旧 extension/companion 消息去重、Discovery Pass、持久化页、root/derived 关系，以及旧 SQL schema。这些不是本项目必须创建的结构。
- 将 `200 {}` 和特定 `404` 直接固化为新项目完整删除恢复契约。历史证据保留在上表，接受条件与异常分支仍需具体规格及验证。

## 5. 证据来源与后续验证

本项目已收录 E3；E1、E2 及其附件仍在相邻的旧仓库，只作历史证据。以下跨仓库相对链接依赖两个 checkout 并列放置。未迁入旧实现、合成 fixture、媒体文件或凭据。

- **[E1]** [2026-08-17 登录 Chrome 只读观察](../../../grok-image-saver/docs/research/grok-browser-resident-contract-2026-08-17.md)与[脱敏统计及探测结果](../../../grok-image-saver/docs/research/evidence/grok-contract-validation-2026-08-17.json)。其旧运行架构建议不适用于本项目。
- **[E2]** [2026-09-21 Post 移除现场证据](../../../grok-image-saver/docs/research/2026-09-21-grok-post-removal-evidence.md)。三个正常删除样本，一个已知成功后的详情查询样本；未测试失回执、重复删除或跨 Post 级联。
- **[E3]** [2026-09-25 Playwright Extension 媒体下载验证](2026-09-25-grok-playwright-extension-demo.md)。包含原始 demo、文件校验结果与连接清理限制；没有执行删除。

后续实现应在对应阶段重新确认列表和详情 schema、精确内容身份、传输完整性、DELETE 响应及未知结果核对。真实删除使用明确授权样本；失回执、进程中断和限流主要通过受控条件验证。验收安排以[实现路线图](../development/implementation-roadmap.md)和后续 Beads 规格为准。
