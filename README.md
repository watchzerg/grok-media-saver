# grok-media-saver

本项目面向个人本地使用，目标是利用现有 Chrome 登录态，将 Grok Saved 列表中的 AI 生成图片和常见小视频可靠归档到本地，并在安全保存后移除对应远端 Post。当前提供只读 Saved 第一页及指定 Post 检查，以及 Saved 第一页和指定 Post 的单响应媒体保存与发布意图接续路径。2026-09-27 的正式主机验收中，CLI 成功连接并读取 40 条第一页；普通图片和一条基础 MP4 均经正式单响应传输、独立文件核验和安全发布，保存命令退出 0。脱敏现场探针分别在媒体 GET 首字节前、读取在途和真实文件写入 Promise 在途时触发停止；停止命令均退出 130，自建页、文件句柄及本次残片完成清理，Post 保持 `pending`，且可以重新连接。写入场景由临时探针在进程内发送 SIGINT；页面级停止依据自建页关闭及后续重连，没有独立的浏览器 `requestfailed` 事件证据。Saved 第一页的 19 条视频详情中未发现可用的既有高清样本，因此真实高清访问与完整传输尚未验收；连接断开与真实清理故障也未在正式浏览器中验收。保存行为以[一期可靠保存规格](docs/specs/phase1-saving.md)为准；当前另提供二期单 Post 正常归档入口，范围与后续恢复切片见下文和[二期规格](docs/specs/phase2-archiving.md)。正式二期现场验收未执行，由用户后续人工操作。

## 工具链

本仓库使用 mise 锁定 Bun，使用 Bun 管理依赖，使用 Biome 检查代码。安装依赖与运行完整本地门禁：

```sh
just install
just gate-full
```

`gate-core` 覆盖 Bun 版本、TypeScript、基础 Application 测试及 Biome，不启动外部服务。`gate-full` 另运行真实 CLI 子进程和隔离 Docker PostgreSQL 测试；两者都不连接 Chrome、Extension 或 Grok。`just test` 运行 Bun 测试；`just test core` 运行 Application 与能力 seam 测试。

需要浏览器的命令按需建立一次 Playwright Extension 连接；`save first-page` 和非空 `retry` 在整个 Run 内复用连接，各 Post 的工作页用完即关闭。收尾时先关闭工作页，再关闭能用本次随机标记唯一确认的 `connect.html`，最后断开连接。旧运行遗留或归属无法确认的连接页不会自动关闭。

## 只读检查 Saved 第一页

在已安装 Playwright Extension 且登录 Grok 的主 Chrome 上，准备 `.env` 中的 `PLAYWRIGHT_MCP_EXTENSION_TOKEN`。配置示例见[`.env.example`](.env.example)；环境变量优先于 `.env`，再使用程序默认值。不得将真实 token 提交或写入日志。

```sh
mise exec -- bun src/cli.ts inspect first-page
```

命令只读取一次 Saved 第一页，不展开 Post，不建立 Run 或 Post 工作。正式连接、第一页响应、关闭连接和重新连接已完成现场验收；Saved 页的首请求为 `workspaceKind=WORKSPACE_KIND_IMAGINE_ALL`、`pageSize=40`。此只读命令的取消竞速、真实断连故障及清理失败尚无单独现场证据；普通媒体保存的正式取消结果见[一期验收记录](docs/research/phase1-acceptance.md#正式浏览器与普通媒体)。

## 保存 Saved 第一页

`save first-page` 每次启动新的 Run，只读取一次 Saved 第一页，按返回顺序串行保存其中的 Post。它沿用 `save post` 的详情、媒体传输、文件核验与发布路径；已保存的 Post 仍会重新读取详情并核验本地版本。处理完本页即结束，不请求后续页，也不删除远端 Post。

```sh
mise exec -- bun src/cli.ts save first-page
```

命令需要已初始化的项目数据库、归档目录和 Playwright Extension 配置。空页成功并记录零数量；普通单 Post 失败继续后续成员，阻挡、停止或基础资源故障停止安排新成员。终端及已正常收尾的 Run 显示已保存、失败和未处理数量；第一页最终不可读取时，Run 摘要数量未知。有失败或未处理时退出 `1`，首次 Ctrl+C 退出 `130`。未开始的列表成员不会预建 Post 工作。

2026-09-27 的正式整页运行处理了 40 个成员：31 条保存、9 条因声明为 PNG 但文件头不符而失败、0 条未处理，命令退出 `1`；失败项没有被发布为已保存。代表性 JPEG 和 MP4 的独立 `verify` 通过。现场证据、响应冲突的只读核对及限制见[一期验收记录](docs/research/phase1-acceptance.md#本票正式单页保存)。

## 初始化项目数据库

`db init` 只连接 `.env` 中的项目 PostgreSQL 配置，检查并创建当前 schema；它不会创建数据库、清空数据或启动浏览器。结构符合当前 schema 时可重复运行；结构不符时会报错。普通命令的 schema 检查只读，不会自动创建或迁移结构。当前 `post_work` 包含 `goal`、`archive_settled`、`removal_state` 和 `deletion_media_version_id`，同 Post 版本 FK 及结清一致性约束保护删除依据；缺少当前字段或约束的旧 schema 明确失败，保留数据，不自动迁移或清空。

```sh
mise exec -- bun src/cli.ts db init
```

首次使用前，在 PostgreSQL 中准备独立的项目数据库，并填写 `GROK_DB_HOST`、`GROK_DB_PORT`、`GROK_DB_USER`、`GROK_DB_PASSWORD` 和 `GROK_DB_NAME`。`db init` 只需要这些 DB 配置，不需要浏览器 token 或归档目录。

## 查看数据库状态

`status` 只读取已初始化的项目数据库，显示最近 Run 摘要和当前未完成 Post。未正常收尾的 Run 会将数量标为未知，并提示它可能仍在运行或已中断；命令不会连接浏览器或检查归档文件。历史失败不影响状态查询成功退出。

```sh
mise exec -- bun src/cli.ts status
```

## 重试未完成 Post

`retry` 通过 PostgreSQL 会话锁避免同一数据库上的并发写入。启动时固定纯保存目标的 `pending`、`finalizing`、`failed` Post，以及尚未结清的 `archive` 工作，按 Post ID 顺序每项处理一次；不依赖当前 Saved 第一页，也不纳入执行期间新增的 Post。纯保存项复用指定 Post 的发布恢复、当前来源核对和图片/视频保存路径。归档项复用 `archive post` 的同一处理路径，接续删除意图核对、已移除绑定版本核验或补救，以及满足资格后的归档；纯保存项不升级目标，已结清归档和已保存的纯保存项不入选。普通单 Post 失败继续，限流、停止、丢锁或基础资源故障停止后续目标。处理非空集合时终端显示当前阶段；终端及正常收尾的 Run 摘要显示已保存、失败和未处理数量。有失败或未处理时退出 `1`，首次 Ctrl+C 退出 `130`。空集合只需要项目数据库配置，成功收尾且不连接浏览器；非空集合还需要归档目录、Extension token 和保存用配置。Run 写入失去回执时，命令不推断其结果或声称已记账。

```sh
mise exec -- bun src/cli.ts retry
```

## 保存指定 Post

`save post <Post-ID>` 每次启动新的 Run；对于纯保存工作，即使该 Post 已是 `saved`，也先核对已有 `finalizing` 意图，再读取当前详情。来源和当前 `GROK_ARCHIVE_DIR` 内已保存文件的大小、SHA-256 均匹配时复用，且不重新下载；文件缺失或来源、适用元数据变化时重新下载。文件访问或权限错误会停止本次下载，保留现有工作事实。需要新文件时通过 Chrome Extension 对所选媒体发起一次完整 GET，将响应流写入当前目录的临时文件。只有 HTTP 200、可信长度、类型及文件头、完整 EOF、实写和重读核验通过，才记录意图并无覆盖发布；Grok 将 JPEG 错标为 PNG 的已知情况按实际 JPEG 类型和 `.jpg` 扩展名保存。冲突保留现场，不覆盖目标文件；再次保存失败保留原成功版本记录，原文件已存在且未受损时也保留原文件。普通暂时失败最多重试一次，重试前重读详情。

```sh
mise exec -- bun src/cli.ts save post <Post-ID>
```

此命令需要数据库、归档目录和 Playwright Extension 配置；只作用于当前 schema 与新启动的 Run。媒体首字节、无写入进展及总时长分别默认限制为 30 秒、30 秒、15 分钟，可通过 `.env.example` 中的配置键调整。首次 Ctrl+C 停止新请求，已开始的文件发布及短事务先完成必要收尾；再次运行同一命令会重新核对数据库与文件事实。
若停止发生在 Run 成功收尾事务开始后，命令仍以 `130` 报告停止，已提交的 `succeeded` Run 与已保存 Post 保持原样。
详情阻挡或需要下载等结果得出后收到停止时，也以 `130` 报告停止并保留原原因；已提交的 Run 和 Post 事实不会改写。

保存工作明确记录 `save` 目标。只保存入口不会降低既有 `archive` 目标：未结清的归档工作直接报告未处理；单页保存继续其他项并整体退出 `1`。已归档结清的 Post 直接跳过，不访问文件或远端，也不重新打开工作。正式 `archive post <Post ID>` 已提供单 Post 正常归档：统一保存或核验复用后，提交精确版本绑定的删除意图，通过禁止重定向的 DELETE 完整取得 HTTP 200、application/json、空对象响应后结清。未知结果保留待核对意图，不直接重发；再次 `archive post` 或 `retry` 会先对遗留意图进行精确 GET 核对；认可不存在后先记录远端已移除，再核验删除绑定文件，正确才独立结清。缺失或冲突保留已移除与未结清事实，用户恢复正确文件后可再次核验结清；该本地接续不发远端请求。认可仍存在后先短事务结清旧意图和旧绑定，保留成功保存版本；提交确定后重新读取详情、保存或核验，符合资格后本 Run 最多发起一次新 DELETE。旧意图结清失回执或失败立即停止，下次按实际 DB 恢复。本次 DELETE 未知且没有停止、阻挡或基础故障时，会有限核对；确认移除后沿用本次有效文件核验结清，确认仍存在后结清意图并保持未完成，本 Run 不再次 DELETE。恢复与本次未知各最多两次 GET，只在前次请求已确认结束的网络错误、超时、408 或 5xx 后条件重试一次；所有请求沿用共享许可和 30 秒总期限。其他未知保留原意图；已移除但绑定文件缺失时，按原记录来源仅补救绑定版本；内容、类型或长度不符则保留未结清，不重新读取详情选择新版本。`retry` 对混合目标每项只处理一轮；请求预算按 Post 保留在本 Run 内，核对、详情、媒体和 DELETE 共用调度许可。首次 Ctrl+C 禁止新请求并取消许可等待；已发或可能已发 DELETE 继续在原30秒截止时间内收集响应，认可成功且锁与 DB 有效时写入结清事实，仍退出 `130`。到期保留待核对意图，取消要求本身不证明浏览器请求已停止或远端撤销；无法确认停止时报告清理故障并终止工作推进，独立清理继续。第二次 Ctrl+C 强制退出 `130`。完整契约见[二期规格](docs/specs/phase2-archiving.md#入口与工作目标)。

## 核验指定 Post 的本地文件

`verify` 读取 PostgreSQL 中该 Post 的保存版本，并只在 `GROK_ARCHIVE_DIR` 当前目录下按记录的相对路径核对普通文件大小与 SHA-256。它不连接浏览器，不创建 Run，也不修复或改写保存状态。成功退出码为 `0`，核验异常为 `1`，参数或配置错误为 `2`。

```sh
mise exec -- bun src/cli.ts verify <Post-ID>
```

数据库与归档根目录需分别配置；示例见[`.env.example`](.env.example)。切换 `GROK_ARCHIVE_DIR` 后只检查新目录，不搜索旧目录。

## 只读检查指定 Post

传入带连字符的 Post UUID；程序会去除首尾空白并转成小写。输出只包含媒体类型和所选画质，不输出媒体 URL 或详情响应。

```sh
mise exec -- bun src/cli.ts inspect post <Post-ID>
```

此命令核对详情返回的 Post 身份和唯一主体媒体，不建立 Run 或 Post 工作，也不下载文件。图片选根 `key`；视频按已存在的 `hd1080Key`、`hdKey`、根 `key` 依次选择，并显示 `1080p`、`720p` 或 `original`。详情身份、结构或最高已知候选无法确认时命令失败；这里只读确认地址字段，不能替代媒体传输完整性验收。

## 文档入口

- [产品目标与首版范围](docs/specs/product-goals.md)：已确认的目标基线、产品原则与完成标准。
- [架构设计](ARCHITECTURE.md)：已确认的模块职责、运行方式与恢复方向。
- [一期可靠保存规格](docs/specs/phase1-saving.md)：一期行为、持久事实、恢复及测试边界。
- [一期开发者运行与恢复](docs/development/phase1-runbook.md)：安装、配置、命令、核验与中断接续。
- [一期验收记录](docs/research/phase1-acceptance.md)：正式浏览器与本地边界的证据、限制。
- [实现路线图](docs/development/implementation-roadmap.md)：三期范围、依赖、风险验证时点与结束标准。
- [详细文档索引](docs/INDEX.md)：文档分类、权威来源与维护规则。
- [Beads 约定](docs/agents/issue-tracker.md)：issue 和 spec 的操作入口。
- [领域词汇](CONTEXT.md)：项目领域命名。
