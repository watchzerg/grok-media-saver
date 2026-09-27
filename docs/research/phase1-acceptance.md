# 一期保存验收记录

观察日期：2026-09-27。范围为当前一期源码、当前 schema、新启动的 Run，以及主 Chrome 已登录 Grok 后的 Playwright Extension relay。详细行为以[一期可靠保存规格](../specs/phase1-saving.md#testing-decisions)为准；本记录区分自动化、本机正式路径和未覆盖场景。现场仅记录媒体类别、数量与去身份化结果，不存 Post ID、媒体 URL、完整响应、Cookie、数据库密码或 Extension token。

## 自动化与前序票证据核对

当前无筛选 `just gate-full` 依次完成 Bun 版本检查、TypeScript、36 项 core 测试、Biome CI，以及 150 项 CLI 测试。CLI 套件使用隔离 Docker PostgreSQL、临时文件和真实子进程；零匹配会失败。`gate-full` 不连接 Chrome、Extension 或 Grok。前序 13 张实施票的最终报告均为 `DONE / passed`，最终审查 gate 为 `PASS`，其 HEAD 均在本票代码基线 `334b6ad` 的祖先链中。`.3` 使用最终 `report-resume.json`，`.13` 使用最终 `report-extended.json`；未将它们较早的报告误作终态。

| 规格验收矩阵 | 核对到的票据与可观察证据 |
| --- | --- |
| 命令与结果 | `.1` 只读第一页；`.2` 指定 Post；`.6` Run、锁和空 retry；`.13` 非空 retry；`.14` 单页串行保存。`tests/core/application.test.ts` 与 `tests/cli/{usage,retry,save-first-page}.test.ts` 覆盖一页、顺序、失败继续、停止及退出码。 |
| 只读与重复保存 | `.4` DB-only status、`.5` 只读 verify、`.11` 已保存再次保存；真实 CLI/隔离 DB 测试核对无写入、当前目录核验、版本保留。 |
| 身份与版本 | `.2` 详情身份、唯一主体、最高既有画质；`.11` 复用及旧成功版本；`.12` 来源变化后同/异摘要。core/CLI 测试覆盖错误结构、高清优先、失败不降级和版本约束。 |
| 调度与传输处理 | `.1`、`.7`、`.8`、`.9`、`.13`、`.14` 覆盖共享请求许可、有限重试、内容长度/类型/文件头/EOF、落盘核验、图片及基础 MP4；CLI 测试用真实文件和 DB 核对。 |
| 错误与停止 | `.1`、`.6`、`.7`、`.8`、`.13`、`.14` 覆盖普通失败、429/登录阻挡、SIGINT、停止竞速、丢锁及不安排后项。真实取消的观察范围见下节。 |
| 真实 DB 与进程 | `.3` schema、`.4` status、`.5` verify、`.6` Run/互斥、`.7` 持久恢复、`.13` retry、`.14` 单页；CLI 套件使用真实子进程和隔离 PostgreSQL，包含提交失回执与未收尾摘要。 |
| 真实文件与恢复 | `.7` 发布意图、`.8` 下载、`.9` 视频、`.11`/`.12` 再次保存与版本；CLI 套件核对 `finalizing` 矩阵、无覆盖发布、冲突保留、缺失/损坏、权限和恢复。 |
| 生命周期与安全 | `.1`、`.3`、`.6`、`.7`、`.8`、`.13` 核对按用例资源、独立清理、关闭错误、退出码及凭据脱敏；真实浏览器只观察正常断开与停止后的重连，故障注入的能力范围见下节。 |

这些报告与当前门禁共同支持本地 DB、文件和 CLI 进程恢复。自动化浏览器依赖在项目能力接口使用 fake；它不证明正式 Chrome 行为。

## 正式浏览器与普通媒体

`.1` 的正式只读 CLI 曾读得 Saved 第一页 40 条并成功断开、重连；页面自身的自动列表请求使用 `/rest/assets`、`pageSize=40`、`workspaceKind=WORKSPACE_KIND_IMAGINE_ALL`。本次代码核对表明 `save first-page` 与 `inspect first-page` 共用 `inspectFirstPage`，由自建 Saved 页面取得自动列表响应；`getFirstPage` 的 route 对匹配请求最多放行一次，并未调用后续页令牌。正式单页保存的本次观察另见下节，不把代码约束称作独立网络抓包计数。

前序 `.8` 正式图片保存的所选响应、EOF、实写及重读均为 188,093 字节，独立 `verify` 通过。首字节等待和 `reader.read()` 在途由外部 SIGINT 停止，分别约 45 ms、49 ms 退出；真实写入 Promise 在途由临时进程内探针发送 SIGINT，约 63 ms 退出。三项均观察到自建页、文件句柄和本次残片清理，Post 保持 `pending`，后续重连成功。`.9` 正式基础 MP4 为 1,114,163 字节，完整响应、实写/重读、发布、DB 版本和独立 `verify` 均通过；另一普通视频的写入在途停止约 34 ms 退出 130 并清理。临时探针未保留在交付源码。页面级停止依据自建页关闭、传输返回、残片清理及重连；没有独立的 Playwright `requestfailed` 事件证据。

## 本票正式单页保存

在主 Chrome 已登录配置和现有 Playwright Extension relay 上，用当前正式 CLI、mise 管理的 Bun、独立临时 PostgreSQL 数据库及临时归档目录验收。先运行 `inspect first-page`：只读取得 40 条、存在后续页但未请求，退出 `0`；应用自建页关闭后仍提示归属不明的 `connect.html` 已保留。随后运行正式 `save first-page`：首次在第三项详情阶段发送 SIGINT，命令退出 `130`；`status` 读取到已正常收尾的 `stopped` Run，摘要为已保存 2、失败 0、未处理 38，第三项为 `pending`。再次启动新的 `save first-page` 后，自然处理完同一页，前两项核验本地已有文件并复用，第三项及后续项继续处理。

第二次 Run 自然收尾，退出码 `1`，持久结果为 `failed`，摘要为已保存 31、失败 9、未处理 0。31 条中有 12 张 JPEG 和 19 条基础 MP4，媒体版本各 1，当前目录有 31 个正式文件、0 个 `.part`。从已保存 JPEG 与 MP4 中各取一条运行正式 `verify`，均退出 `0`。保存日志对这些已发布媒体显示 HTTP 200、所选和响应类型一致、`Content-Length` 与 EOF 实写一致、临时文件重读 SHA-256 通过，并完成发布和保存提交。没有调用远端 DELETE，也没有观察到 429、登录失效或全局阻挡。该运行证明单页入口可串行处理、停止后重新读取和复用本地版本、普通单 Post 失败继续到本页结束；它不等于 40 条全部保存成功。

9 条失败均为详情与 HTTP 响应声明 `image/png`，两次有限传输后记录“媒体文件头与所选类型不符”。为区分实现错误与实际响应冲突，另经**同一主 Chrome Extension relay** 对其中一条失败样本只读 GET 前缀：HTTP 200、`Content-Type: image/png`、`Content-Length: 188914`，字节头为 JPEG/JFIF（`FF D8 FF E0 … JFIF`），不是 PNG 签名。其余 8 条有同类本地签名拒绝记录，但未逐条独立检查字节头。当前规格要求所选类型、响应类型和文件头一致，因此保留失败、清理残片并继续后项是受控行为；本记录不把这 9 条算作保存成功，也不推断服务端何时会修正内容。

源码核对：`save-first-page` 每次仅调用一次 `inspectFirstPage`；`getFirstPage` 等待 Saved 页面自身的 `/rest/assets` 响应，匹配 `pageSize=40`、`orderBy=ORDER_BY_CREATE_TIME` 与 `workspaceKind=WORKSPACE_KIND_IMAGINE_ALL`，并在 route 中最多放行一次匹配请求。应用未传后续页令牌。本次终端与 DB 证据确认 40 个列表成员及无未处理项；没有独立网络 trace 来给实际获放行请求数计数，不将源码约束表述为网络抓包结果。正式停止的本次观察是详情阶段 SIGINT；首字节、读取和真实写入在途取消证据来自前序 `.8`/`.9` 的普通媒体现场验收。

## 范围与缺口

前序 `.9` 只读检查 Saved 第一页的 19 条视频详情：18 条为 `original`，1 条详情检查失败，未找到可用的 `hdKey`/`hd1080Key` 高清样本。因而不能宣称真实高清访问或完整传输已验收；自动化只覆盖高清选择和失败处理。没有执行远端 DELETE；本地 `saved` 不等于完整归档。当前验收不声称断电级恢复、真实断连故障或真实清理失败已验证。大视频、慢写压力和峰值内存专项已由一期范围取消。
