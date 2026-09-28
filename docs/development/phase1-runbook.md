# 一期开发者运行与恢复

本文面向在本机运行当前源码的维护者。命令行为以[一期规格](../specs/phase1-saving.md)为准；各命令的使用入口见 [README](../../README.md)。一期只保存本地文件，不移除远端 Post；完整归档属于后续阶段。

## 准备

1. 在仓库运行 `just install`、`just gate-full`。完整门禁使用隔离 Docker PostgreSQL、临时目录和真实 CLI 子进程；宿主需要能运行 Docker 并取得 `postgres:18-alpine` 镜像。门禁不连接 Chrome 或 Grok。
2. 为实际归档预先准备**独立于测试容器**的 PostgreSQL 数据库与归档目录。复制 `.env.example` 为 `.env`，填入 `GROK_DB_*`、`GROK_ARCHIVE_DIR`。环境变量优先于 `.env`。数据库密码、Extension token 和含 token 的连接页地址不进入提交、终端记录或验收材料。
3. 在主 Chrome 的登录配置中保持 Grok 登录，并安装 Playwright Extension。为需要浏览器的命令提供 `PLAYWRIGHT_MCP_EXTENSION_TOKEN`。程序只附着既有 Chrome context，按需建立一次连接并关闭自己的工作页；批量 Run 在各 Post 间复用连接。收尾时关闭能用本次随机标记唯一确认的 `connect.html`，归属不明或旧运行遗留的连接页仍保留并提示人工核对，用户原有标签页由用户管理。
4. 对实际数据库运行 `mise exec -- bun src/cli.ts db init`。它只初始化当前 schema，不创建数据库；普通命令只读核对 schema，不自动迁移。改动归档根目录后，`verify` 只查新目录。

## 运行顺序

| 命令 | 用途与所需资源 |
| --- | --- |
| `inspect first-page` | 只读检查 Saved 第一页；需要 Chrome/Extension，不需要 DB 或归档目录。 |
| `inspect post <Post-ID>` | 只读检查指定 Post 的身份和所选媒体；需要 Chrome/Extension。 |
| `save first-page` | 新建 Run，只取 Saved 第一页，按返回顺序串行保存；需要项目 DB、归档目录和 Chrome/Extension。处理当前页即结束。 |
| `save post <Post-ID>` | 新建 Run，核对当前详情并保存或复用；需要同上资源。 |
| `status` | 只读查询 DB 中最近 Run 与未完成 Post，不访问浏览器或文件。 |
| `verify <Post-ID>` | 只读检查当前归档目录中的已保存文件大小与 SHA-256，不改变 DB 或文件。 |
| `retry` | 新建 Run，固定启动时纯保存目标的 `pending`、`finalizing`、`failed` 及未结清 `archive` 集合；纯保存逐项接续，当前归档项保留未处理；空集合只需 DB，有目标时还需归档目录与 Chrome/Extension。 |

所有命令用 `mise exec -- bun src/cli.ts <命令>` 执行。退出码为 `0` 成功、`1` 执行或核验失败、`2` 参数或配置错误、`130` 首次 Ctrl+C 停止。`save first-page` 和 `retry` 的已保存、失败、未处理数量只对正常收尾且已确认的 Run 有效；未收尾 Run 的数量未知。普通单 Post 失败可继续后项；登录/challenge、429、停止、丢锁和基础资源故障会结束本次调度。

当前 schema 明确保存 `goal` 与 `archive_settled`；旧结构不匹配时保留数据并失败，不自动迁移。保存入口拒绝接管未结清 `archive` 工作；单页继续其余成员，整体非零。已结清工作直接跳过，不读取文件或详情。正式归档与 retry 按目标接续尚待二期后续实现；本阶段不会发起 DELETE，`archive` 工作也不会被降为 `save`。对应契约见[二期规格](../specs/phase2-archiving.md#入口与工作目标)。

## 核验和恢复

保存后用 `status` 看持久状态，再对代表性或需要交接的 Post 运行 `verify <Post-ID>`。`saved` 是历史保存事实；`verify` 报告当前文件情况，不自动修复。若当前目录中文件缺失、损坏或不可访问，保留现场，按原因处理后显式重新运行 `save post`。再次保存会重读当前详情；来源未变且本地文件核验通过时复用，来源变化时依据文件内容建立或复用版本。

首次 Ctrl+C 请求停止新工作，并允许在途可中断请求和已开始的短事务完成必要收尾。看到退出码 `130` 后运行 `status`；若有未完成 Post，用 `retry` 接续，或用 `save post <Post-ID>` 定向核对。`finalizing` 表示发布意图尚待按 DB 与文件事实核对，不要手工删除其临时文件或正式文件。第二次 Ctrl+C 会强制退出，可能留下未收尾 Run、临时文件或自建页；下次同样先查 `status`，再显式恢复。

清理错误会单独报告。文件已成功提交时，清理失败不撤销 `saved`；浏览器页、连接或 DB 关闭失败也不能据此推断远端请求或事务结果。保留错误文本与现场，核对 `status`、`verify` 后再重试。程序只清理可证明归属的临时文件；文件冲突或权限问题需人工核对，不能覆盖、换名绕过或盲删。切换数据库或归档目录前，确认两者属于同一组实际归档事实。

Grok 的 PNG 声明、JPEG 内容这一已知错标在完整性核验通过后按 JPEG 保存。若仍出现“媒体文件头与所选类型不符”，该 Post 不会被发布为 `saved`；先检查[验收记录](../research/phase1-acceptance.md#本票正式单页保存)中的响应冲突示例，再决定何时重试。反复运行 `retry` 不会把其他不一致的媒体当作成功。

## 验收边界

`just gate-full` 证明当前代码的 core、真实本地 DB/文件/CLI 进程测试通过，不证明当前 Chrome 登录态、Grok 响应或断电级恢复。正式图片、小视频和取消清理的现场结果记录在[一期验收记录](../research/phase1-acceptance.md)。真实高清无可用样本；大视频专项不在一期范围。进入远端删除阶段前须保持本地保存与恢复验收结论成立。
