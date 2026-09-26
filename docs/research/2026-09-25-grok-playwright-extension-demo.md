# Playwright Extension 连接主 Chrome 下载 Grok 媒体验证

## 来源与适用范围

本记录及原始 demo 于 2026-09-25 从 `grok-image-saver` 迁入本项目。现场验证发生在旧仓库，以下版本、结果和资源遗留情况均为当时观察；迁移未重新运行实验。现行产品约束以[产品目标](../specs/product-goals.md)和[架构设计](../../ARCHITECTURE.md)为准。

脚本作为研究证据保存在 `evidence/`，保留原始内容，不纳入应用构建、typecheck 或 Biome 检查。本项目尚未安装其 `playwright-core` 依赖，也未提供正式运行入口。后续实现应复用验证思路，按当前架构重新验证连接、传输及清理能力。

## 目标与边界

2026-09-25 用独立 TypeScript demo 验证：从登录中的 `https://grok.com/imagine/saved` 获取 History / All 列表，按顺序进入单个 Post，只下载该 Post 自身的直接媒体，取得至少一张图片和一个视频后停止。对象和 HTTP 入口以[核心模型文档](core-archive-model-and-http.md)为起点。本验证只发送 GET；没有调用 Unlike、asset DELETE、conversation DELETE，也没有启动旧项目的现有代码、服务或测试。

一次性脚本为 [原始 demo](evidence/grok-playwright-extension-demo.ts)。当时的本地媒体位于旧仓库被 `.gitignore` 忽略的 `.local/grok-playwright-extension-demo/`，媒体文件和凭据未迁移。脚本输出路径相对于执行时的工作目录；本项目同名输出目录也已加入忽略规则。令牌只在进程环境变量中传入，脚本和本文均不保存令牌、Cookie、完整媒体 content key 或响应正文。

## 连接路径

实际路径是：demo TS → 当时旧仓库安装的 `playwright-core@1.63.0` 的 `tools.createBrowserWithInfo({ extension: true })` → 该包内部的 `createExtensionBrowser()` → `CDPRelayServer` → 已安装的 Playwright Extension → 正在运行的主 Chrome → Grok。没有单独启动 Playwright MCP 服务，也没有创建自动化专用浏览器。连接工厂调用 Chrome 可执行文件打开扩展连接页；本次返回已有 Chrome 的一个 context，随后由 demo 在该 context 中新建一个标签页。正常退出时脚本尝试关闭自己创建的 Grok 标签页并断开连接。

最初设想直接 import `cdpRelay.ts`。该文件是 Playwright monorepo 的内部模块，依赖其私有路径别名、协议和浏览器模型；已安装包没有公开导出这个类。使用已安装包的连接工厂仍走同一个 `CDPRelayServer`，免去复制内部源码。[官方扩展说明](https://github.com/microsoft/playwright/blob/48844a570e64826cfbc50c653208ee7f9415b82d/packages/extension/README.md)、[连接工厂源码](https://github.com/microsoft/playwright/blob/48844a570e64826cfbc50c653208ee7f9415b82d/packages/playwright-core/src/tools/mcp/extensionContextFactory.ts)、[Relay 源码](https://github.com/microsoft/playwright/blob/48844a570e64826cfbc50c653208ee7f9415b82d/packages/playwright-core/src/tools/mcp/cdpRelay.ts)。以上源码链接用于解释机制；实际运行的是本地已安装版本。

## 现场过程与结果

| 步骤 | 观察 |
| --- | --- |
| 扩展连接探测 | `--probe` 返回 `contexts: 1`、`pages: 1`，退出码 0。 |
| Saved 页面 | 新标签页进入 `/imagine/saved`，标题为 `Imagine Saved - Grok`。 |
| All 第一页 | 同一页面内 `fetch` 精确的 `/rest/assets?pageSize=40&orderBy=ORDER_BY_CREATE_TIME&workspaceKind=WORKSPACE_KIND_IMAGINE_ALL`；HTTP 200、合法 `assets` 数组，40 条，存在 `nextPageToken`。 |
| 逐 Post | 按第一页返回顺序进入 `/imagine/post/<assetId>`，逐个读取同一 ID 的 `/rest/assets/<assetId>`；只用详情的 `key`、`mimeType`、`sizeBytes` 下载当前 Post，未访问详情中关联 Post。 |
| 停止 | 访问第 14 条后，得到 1 张图片和 1 个视频，退出码 0；没有请求下一页。 |

| 首次取得的类型 | 列表序号 | 格式 | 字节数 | SHA-256 |
| --- | ---: | --- | ---: | --- |
| 图片 | 1 | JPEG | 188093 | `2713456a16985fdd4cb33b2f5815e578e66f3364e74b854493440d86fad71293` |
| 视频 | 14 | MP4 | 1634239 | `d05bbe52b2b26c137f9604c29c9e6f6fd9946725af6e0851a588533a7609c91c` |

媒体经登录页面的浏览器 `fetch` 以 256 KiB `Range` 分块读取。首次运行发现响应为可读的 HTTP `206`，但页面脚本未取得 `Content-Range` 响应头；当时 demo 对该头的硬性要求导致前 11 项误判，因此主动中止并修正。第二次运行在 `Content-Range` 可读时严格核对该头；不可读时用详情 `sizeBytes`、每块预期长度和累计长度核对。两份文件均核对了详情大小、响应 MIME、文件签名，并在落盘后独立用 `stat`、`file` 和 `shasum -a 256` 复核；结果与上表一致，没有残留 `.part` 文件。`sips` 可解析 JPEG 为 768 × 1152；`ffprobe` 可解析 MP4，时长 6.041667 秒。

## 结论与限制

当时本机登录态下，Playwright Extension 的 CDP Relay 路径足以让独立 TS 程序读取 Grok Saved / All 第一页、顺序进入 Post，并完整保存至少一张直接图片和一个直接视频。验证覆盖了所请求的最小下载目标。

这不是生产归档流程验收：没有执行 Post Removal、持久恢复、限速/429 恢复或整页耗尽；也没有证明所有媒体类型、较大视频和未来 Grok 响应形状都可用。`Content-Range` 对页面脚本不可见时，当前 demo 依赖详情 `sizeBytes` 与各块长度；它证明本次两份文件完整，与通用下载器的所有边界无关。脚本使用 Playwright 内部工具导出，后续 Playwright 版本可能改变该入口，正式产品需另行决定稳定连接封装。

连接工厂打开的扩展 `connect.html` 标签页在断开后仍留在主 Chrome；中止的首次运行还留下一个 Grok Post 标签页。尝试通过浏览器工具关闭时被 URL 安全策略拒绝，未继续绕过。这四张由 demo 新增的标签页（三张扩展连接页、一张 Grok Post 页）当时需由用户手动关闭；迁移时未检查它们是否仍存在。扩展连接页 URL 含连接令牌，避免复制或分享其地址。
