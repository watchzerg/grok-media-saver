## 交付范围

这是个人项目。完成满足当前请求的最小、直接且可验证的改动后即可停止。让改动保持局部性，沿用既有名称和工作流程；只有在文件、依赖、配置或操作步骤能解决当前需求、已知故障或仓库契约要求时才添加它们。

- 覆盖改动路径实际涉及的运行边界、用户可见的失败、数据完整性、资源清理、密钥泄露和破坏性操作。按改动及其风险选择相称的验证方式。
- 选择最简单且稳健的设计：代码应清晰、可测试，并且便于在本项目中修改。只有在抽象能解决当前的重复、复杂性或出错风险时才引入抽象。
- 将未来改进作为建议：有价值但超出当前范围的想法可以在交付说明中简要提及；若没有当前需求，不为其实现、重构或扩大验证范围。
- 只有在明确需求、实际运行约束或既有仓库契约要求时，才添加兼容层、迁移框架、通用授权或审计系统、合规流程、高可用或多租户部署，以及平台式扩展架构。
- 当设计会明显增加复杂度时，说明它解决的具体当前问题及更简单的替代方案。如果没有直接收益，选择更简单的方案。
- 只有在合理的不同理解会实质改变范围、产品行为或风险时，才请求确认。

## Test seams

共享测试契约位于 `~/projects/grok-image-saver/.agents/skills/beadwork-run/references/`；以下文件名均相对此目录，读取前展开 `~` 并解析为真实绝对路径（固定使用本项目 primary checkout 的入口）。直接读取参考文件即可，不启动 `beadwork-run`。

- 使用 `to-spec` 前读取 `testing-seams.md`；确定测试模式和计划时读取 `testing-plan.md`。
- 使用 `to-tickets` 前读取 `testing-plan.md` 和 `testing-gates.md`；解析 seam 引用时读取 `testing-seams.md`。 为 Beadwork 拆票或调整顺序时另读 `serial-planning.md`，在同一次确认中批准增量切片及执行顺序，并使用其脚本发布、校验和接纳 parent 计划。
- 使用 `tdd` 前读取 `testing-seams.md`、`testing-tdd.md` 和 `testing-gates.md`；有 assigned ticket 时另读 `testing-plan.md`。

## Agent skills

### Issue tracker

Issues and specs are tracked in this repository's Beads database. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

涉及归档流程、状态、schema、协议或测试设计时，先读取 [architecture.md](architecture.md)、[CONTEXT.md](CONTEXT.md) 和 [ADR-0009](docs/adr/0009-use-in-memory-first-page-and-durable-post-processing.md)，再用 `bd show grok-image-saver-t9x --json` 读取唯一当前实现规格。旧批次方案、历史规格、`grok-image-saver-8gy` 决策地图与其他旧 tracker Resolution 只作来源证据。按新代码、新 schema、新协议和空 DB 设计；新流程自身必须可恢复，历史数据/版本/任务不做迁移或兼容。用户计划自行清空 DB，本条不授权执行清库。

Use the single-context domain documentation layout. See `docs/agents/domain.md`.

### JavaScript/TypeScript 工具链

- **mise** 锁定 Bun 本身的版本：`mise.toml` 声明兼容的版本 line，`mise.lock`
  锁定经验证的精确构建。仓库内一律通过 mise shim 或 `mise exec -- bun …` 调用
  Bun；升级 Bun 时更新 line 并用 `mise lock --bump` 刷新 lockfile。
- **Bun** 是应用代码与仓库脚本的宿主运行时，并管理依赖、workspaces 与
  lockfile：`bun ci` 是标准安装步骤；`Bun.build` 是默认 bundler；`bun test`
  是默认 test runner。
- **Biome** 负责格式化、lint（recommended 规则起步）与 import 排序；
  `biome ci` 由 `just gate-core` 纳入本地与交付的必需门禁。
- **just** 是 agent 工作流的命令契约接口：仓库根 `justfile` 提供契约 recipe
  （`install`、`typecheck`、带 scope 的 `test`、`gate-plan`、`gate-core`、
  `gate-artifact`、`gate-database`、`gate-browser`、`gate-system`、`gate-full`、
  `env-facts`、`check-toolchain`、`fmt`），内部转发 Bun/Biome 工具链。
  所有完整 gate 均无参数；定向验证使用 `just test <scope> [path] [-t name]`。
  agent 流程只调用 just 契约 recipe，不直接调用 `bun run` 验证命令。
- **版本策略**：`package.json` 中只有 Biome exact-pinned（格式化与 lint 的
  验证 identity），其余直接依赖用 caret range；`bun.lock` 必须提交，不因
  lockfile 已精确解析而改用 manifest exact pin。`preinstall` 与发布 CLI 内置
  版本 line gate，跨 line 运行会 fail closed。
- 优先使用 Bun / Biome 的能力而非第三方依赖；没有等价能力时保留专门工具：
  `tsc --noEmit`（权威 typecheck）、Playwright（真实浏览器与扩展自动化）、
  外部 PostgreSQL。
