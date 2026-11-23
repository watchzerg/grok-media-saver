# 技术选型与依赖管理

选库、变更依赖或 lockfile、调整工具链、环境变量、构建或 mise task、设计或开发页面前，必须读取本文。当前版本与依赖以根目录的配置和 lockfile 为准，执行入口见 [AGENTS.md](../../AGENTS.md#开发与验证)及 [mise.toml](../../mise.toml)。

## 工具职责

- mise 统一承担工具、环境变量与命令封装：
  - 工具：`mise.toml` `[tools]` 声明 Bun 的兼容版本 line，`mise.lock` 锁定经验证的精确构建；`mise run` 自动准备锁定工具并放进 PATH，不依赖 shell 的 `mise activate`。
  - 环境变量：`mise.toml` `[env]` 维护非敏感开发默认值，本机凭据（`GROK_DB_PASSWORD`、`PLAYWRIGHT_MCP_EXTENSION_TOKEN`）与个人覆盖写入不提交的 `mise.local.toml`（模板见 [mise.local.toml.example](../../mise.local.toml.example)）；测试时的环境变量与隔离配置统一由 `[tasks.test.env]`、`[tasks.test-full.env]` 管理，不依赖 `.env`。
  - 命令封装：`mise.toml` `[tasks.*]` 与 `mise-tasks/` 提供 `check-toolchain`、`install`、`cli`、`fmt`、`lint`、`typecheck`、`test`、`test-full`、`gate-core`、`gate-full`、`db-up`、`db-down` 等入口（`mise tasks` 查看）。安装须根据锁定配置准备相同环境；工具或依赖准备失败返回非零。
- Bun 是应用代码与仓库脚本的宿主运行时，负责依赖、workspaces 与 lockfile；标准安装使用 `bun ci`，默认 bundler 为 `Bun.build`，默认 test runner 为 `bun test`。
- Biome 负责格式化、lint 与 import 排序，以 recommended 规则起步；TypeScript 的 `tsc --noEmit` 是权威 typecheck。优先使用 Bun / Biome 已有能力，新增依赖须解决当前需求。
- Docker（含 Compose）由系统安装，不经 mise 管理。根目录 `compose.yaml` 定义实际归档与现场验收使用的项目 PostgreSQL，由 `mise run db-up` / `mise run db-down` 启停；`gate-full` 的隔离测试容器由测试代码自行启动，不使用 compose，镜像与连接参数由 `mise.toml` `[tasks.test-full.env]` 管理。两者都使用 `postgres:18-alpine`，升级 PostgreSQL 大版本时一并调整。

## 版本与升级政策

- 升级 Bun 时更新 `mise.toml` 的版本 line，并用 `mise lock --bump` 刷新 lockfile。`preinstall` 中的 Bun line 检查保持 fail closed。
- `package.json` 中仅 Biome exact-pinned，以固定格式化与 lint 的验证 identity；其他直接依赖使用 caret range。
- 提交 `bun.lock`，不因 lockfile 已精确解析而将 manifest 改为 exact pin。升级后按实际影响选择验证，规则见[测试设计与验收](../agents/testing.md)。

## 页面选型

页面采用 React + Tailwind + shadcn/ui，尚未接入当前应用。需要开发页面时沿用此选型；依赖在实际需要时添加。当前约定不预设目录拆分、部署方式或新的构建与测试命令。
