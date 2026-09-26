# 一期浏览器连接与资源生命周期调研

调研日期：2026-09-25，2026-09-26 复核。目标运行时为 Bun；检查的 Playwright 包为旧项目安装的 `playwright-core@1.63.0`。本报告为一期设计证据，不代表本项目正式应用路径已经验收。2026-09-26 复核时，本项目的 `package.json` 与 `bun.lock` 仍未包含 Playwright。

## 范围与来源

- [Playwright Extension 官方说明](https://github.com/microsoft/playwright/blob/v1.63.0/packages/extension/README.md)和[连接工厂源码](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/tools/mcp/extensionContextFactory.ts)说明扩展连接路径；[CDP relay 源码](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/tools/mcp/cdpRelay.ts)说明连接页与本地 relay 的行为。
- [Playwright Browser API](https://playwright.dev/docs/api/class-browser)、[Page API](https://playwright.dev/docs/api/class-page)说明公开的 `close()`、`disconnected`、`newPage()` 和 `evaluate()` 语义。官方公开使用方式主要是 Playwright CLI / MCP 的 `--extension`，见[扩展说明](https://github.com/microsoft/playwright/blob/v1.63.0/packages/extension/README.md)。
- 已迁入本项目的[2026-09-25 现场 demo 记录](2026-09-25-grok-playwright-extension-demo.md)及[原始脚本](evidence/grok-playwright-extension-demo.ts)是旧项目环境的本机实测证据，不能替代本项目正式入口验收。原始来源为旧项目提交 `a61a848099902677a0b08fdb24cc4728b0db5a02`。
- 另检查旧项目已安装的 `playwright-core/package.json`、`lib/coreBundle.js` 和当前 Bun 导入能力。当前新仓库尚未声明 Playwright 依赖。

## 已核实事实

1. Playwright 1.63.0 的 `createExtensionBrowser()` 启动本地 `CDPRelayServer`，打开扩展 `connect.html`，等扩展连入，再调用 `playwright.chromium.connectOverCDP(...)`。返回的是普通 Playwright `Browser`；其 `disconnected` 事件触发 relay 停止。工厂失败时也停止 relay。[连接工厂源码](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/tools/mcp/extensionContextFactory.ts)
2. `createBrowserWithInfo({ extension: true, … })` 位于包的 `lib/coreBundle` 工具入口，不在 `playwright-core` 顶层公开 API。旧项目安装包的 `exports` 包含 `./lib/coreBundle`，且本机 `mise exec -- bun` 中导入该模块后 `bundle.tools.createBrowserWithInfo` 是函数。这个事实只确认当前安装版本的模块导入，不确认本项目已经成功连接。该入口处于 Playwright 内部工具代码，升级时须复核参数和行为。[旧 demo 脚本](evidence/grok-playwright-extension-demo.ts)、[包源码](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/tools/mcp/browserFactory.ts)
3. 当前源码将扩展连接令牌从 `PLAYWRIGHT_MCP_EXTENSION_TOKEN` 读取，放入新建连接页的 URL；令牌存在时连接等待有超时，缺失时源码的等待截止值为零，此时等待用户手动批准。连接页 URL 因此是敏感信息，不应记录、打印或上传。本次调研没有为实验寻找或复制用户令牌，也未启动连接或读取 Chrome 页面。[CDP relay 源码](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/tools/mcp/cdpRelay.ts)
4. 旧 demo 曾通过这一路径连接现有登录 Chrome，取得一个 context，在自建 Grok 标签页内用 `page.evaluate()` 发 `fetch(..., { credentials: "include" })`；随后成功读取 Saved 第一页、Post 详情及图片和视频。正常退出代码尝试关闭自建 Grok 页和 `browser.close()`。现场记录同时指出：连接工厂新开的扩展连接页在断开后仍留下，异常中止的一次还留下一张自建 Grok 页。该实测只覆盖旧 demo 当时的 Chrome 和 Playwright 环境。[现场记录](2026-09-25-grok-playwright-extension-demo.md)
5. Playwright 文档说：对于**连接到**浏览器的 `Browser`，`browser.close()` 断开连接并清理该连接创建的 context；`browser.on('disconnected')` 可观测浏览器关闭或连接断开。`page.close()` 关闭指定页面。结合工厂 `ownership: 'attached'` 与旧 demo 观察，不能把 `browser.close()` 当作清理连接页或任意现有 Chrome 标签页的保证。[Browser.close 文档](https://playwright.dev/docs/api/class-browser#browser-close)、[Browser.disconnected 文档](https://playwright.dev/docs/api/class-browser#browser-event-disconnected)、[工厂源码](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/tools/mcp/browserFactory.ts)

## 推断与一期建议

- Browser session 只持有本次返回的 `Browser` 和明确由自己 `context.newPage()` 创建的 page 引用；清理时先停止新请求，再尽力关闭这些 page，最后断开 `Browser`。不要对现有 context 调用 `close()`，也不要按 URL 模式遍历关闭用户页。失败路径与正常路径都应执行同一清理逻辑。这个所有权规则是基于附着连接和旧 demo 遗留页现象的设计建议，尚未经过本项目实测。
- 将 Playwright 的连接工厂、`Browser`、`Page` 与原始异常封在 Browser session 内。Core 只接收连接失败、已断开、请求失败、成功响应等结果；连接失效后停止发出本次执行的新远端请求，由 Core 决定工作状态。下次启动新 Run 或执行 `retry` 时再建立连接并核对未完成事实，不自动重连并重放在途业务请求。`disconnected` 事件可作主动信号，正在执行的 `page.evaluate()` 仍须捕获拒绝及超时；不要把断连解释为业务请求未被服务端执行。
- 按现有可行路径，最小新增应用依赖是 `playwright-core`；使用现有 Playwright Extension、主 Chrome 和 Bun，不需要另启 MCP 服务或自行编写扩展。`1.63.0` 是旧项目的已验证版本，不自动成为本项目的版本决定。安装时遵守新仓库 manifest 的 caret range 与 `bun.lock` 规则，并以实际解析版本验收内部入口。[旧 demo 现场路径](2026-09-25-grok-playwright-extension-demo.md)
- 浏览器内 `fetch` 可用页面登录态；`page.evaluate()` 返回的是可序列化结果，不提供跨进程的原生流通道。旧 demo 将每块 `arrayBuffer()` 转 base64 传回 Bun，因此每块会在页面和进程间缓冲。传输策略、取消和最大块大小由媒体传输决策另定。[Page.evaluate 文档](https://playwright.dev/docs/api/class-page#page-evaluate)、[旧 demo 脚本](evidence/grok-playwright-extension-demo.ts)

## 尚未验证与首个切片的验收

- 本轮没有当前 Chrome 连接实测：未验证当前扩展版本、令牌、已登录状态、工厂连接时长、断开及重新连接。也未验证连接页能否由 Playwright 安全定位并关闭，或断开时残留何种 Chrome 资源。旧 demo 的连接成功不能替代这些结论。
- 首个 Browser session 切片用本项目锁定依赖和 Bun 入口、当前已登录 Chrome，依次验证：连接后识别现有 context；仅新建一张由应用持有的 Grok 页；发一个脱敏的只读 GET 并只记录状态与结构摘要；关闭自建页并断开；再次连接并发同样只读请求。前后只记录标签页数量及应用所建页是否消失，不记录连接 URL、令牌、Cookie 或完整响应。此项是正式连接能力的交付门槛，旧 demo 与本次静态导入检查均不能替代。
- 用受控手段使连接断开，确认 `disconnected` 触发、在途操作返回受控失败、新请求被阻止、状态可显式恢复。另在连接失败和正常停止路径核对资源清理。若连接页无法自动安全清理，应把残留数量与处理方式写入运行说明，并在设计票决定是否接受；不要通过关闭不明标签页掩盖。
- 应为连接工厂内部入口保留一次小范围升级验收：重新导入、连接、只读请求、断开与重连。当前没有证据支持更宽的版本兼容层。

## 与一期已确认范围的对应

- 一期只读命令 `inspect first-page`、`inspect post` 不建立归档工作；保存入口 `save first-page` 只读一页并逐 Post 保存，`save post` 复用单 Post 路径。Browser session 为这些需要远端访问的用例提供同一连接生命周期；`status` 和本地文件 `verify` 不需要浏览器连接。依据 Beads 票 `grok-media-saver-wee.6` 的 resolution comment。
- 扩展 token 是连接凭据。正式应用集中读取配置，按用例要求必需字段，错误输出不包含 token 或含 token 的连接页 URL。Playwright 内部允许无 token 时手动批准，不改变本项目已确认的 token 配置方向。[CDP relay 源码](https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/tools/mcp/cdpRelay.ts)
- 当前 Run 遇到浏览器基础资源故障即停止并说明原因；已确认的全局阻挡只作用于当前 Run，不将浏览器故障或冷却持久化为下次 Run 的请求禁令。中断后的 Post 事实由持久工作记录承接，连接模块不自行判断保存完成。依据 Beads 票 `grok-media-saver-wee.6` 的 resolution comment。
