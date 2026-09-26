# grok-media-saver

本项目面向个人本地使用，目标是利用现有 Chrome 登录态，将 Grok Saved 列表中的 AI 生成图片和常见小视频可靠归档到本地，并在安全保存后移除对应远端 Post。当前提供只读 Saved 第一页及指定 Post 检查的 Application/CLI 路径。2026-09-27 的正式主机验收中，CLI 两次成功连接并读取 40 条第一页，断开后 Chrome 仍运行且第二次成功重连；现场也核对了 Saved 页自动发出的第一页请求及其过滤条件。Ctrl+C 竞速、连接断开与清理故障尚未在正式浏览器中触发，媒体保存传输也尚未现场验收。归档行为以[一期可靠保存规格](docs/specs/phase1-saving.md)为准。

## 工具链

本仓库使用 mise 锁定 Bun，使用 Bun 管理依赖，使用 Biome 检查代码。安装依赖与运行完整本地门禁：

```sh
just install
just gate-full
```

`gate-core` 覆盖 Bun 版本、TypeScript、基础 Application 测试及 Biome；`gate-full` 另运行真实 CLI 子进程测试。两者都不连接 Chrome、Extension 或 Grok。`just test` 运行 Bun 测试；`just test core` 运行 Application 与能力 seam 测试。

## 只读检查 Saved 第一页

在已安装 Playwright Extension 且登录 Grok 的主 Chrome 上，准备 `.env` 中的 `PLAYWRIGHT_MCP_EXTENSION_TOKEN`。配置示例见[`.env.example`](.env.example)；环境变量优先于 `.env`，再使用程序默认值。不得将真实 token 提交或写入日志。

```sh
mise exec -- bun src/cli.ts inspect first-page
```

命令只读取一次 Saved 第一页，不展开 Post，不建立 Run 或 Post 工作。正式连接、第一页响应、关闭连接和重新连接已完成现场验收；Saved 页的首请求为 `workspaceKind=WORKSPACE_KIND_IMAGINE_ALL`、`pageSize=40`。取消竞速、真实断连故障及清理失败仍需按[一期浏览器验收要求](docs/research/phase1-browser-session.md#尚未验证与首个切片的验收)验证。

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
- [实现路线图](docs/development/implementation-roadmap.md)：三期范围、依赖、风险验证时点与结束标准。
- [详细文档索引](docs/INDEX.md)：文档分类、权威来源与维护规则。
- [Beads 约定](docs/agents/issue-tracker.md)：issue 和 spec 的操作入口。
- [领域词汇](CONTEXT.md)：项目领域命名。
