## 交付范围

这是个人项目。完成满足当前请求的最小、直接且可验证的改动后即可停止。让改动保持局部性，沿用既有名称和工作流程；只有在文件、依赖、配置或操作步骤能解决当前需求、已知故障或仓库契约要求时才添加它们。

- 覆盖改动路径实际涉及的运行边界、用户可见的失败、数据完整性、资源清理、密钥泄露和破坏性操作。按改动及其风险选择相称的验证方式。
- 选择最简单且稳健的设计：代码应清晰、可测试，并且便于在本项目中修改。只有在抽象能解决当前的重复、复杂性或出错风险时才引入抽象。
- 将未来改进作为建议：有价值但超出当前范围的想法可以在交付说明中简要提及；若没有当前需求，不为其实现、重构或扩大验证范围。
- 只有在明确需求、实际运行约束或既有仓库契约要求时，才添加兼容层、迁移框架、通用授权或审计系统、合规流程、高可用或多租户部署，以及平台式扩展架构。
- 当设计会明显增加复杂度时，说明它解决的具体当前问题及更简单的替代方案。如果没有直接收益，选择更简单的方案。
- 只有在合理的不同理解会实质改变范围、产品行为或风险时，才请求确认。

## 文档入口

- 了解项目当前状态时，读取 [README.md](README.md)。
- 涉及领域行为、数据模型或命名时，读取已存在的 `CONTEXT.md`；设计或修改架构时，读取已存在的 `ARCHITECTURE.md` 和相关 ADR。
- 查找规格、操作指南、开发说明、决策或研究资料，以及新增、移动或删除文档时，读取 [docs/INDEX.md](docs/INDEX.md)：文档分类、权威来源与维护规则。
- 每次修改代码后，检查受影响的现行文档是否仍与实现一致；需要时在同一任务中更新
  相应的权威文档及引用，无需更新时不做机械性的文档改动。

## Test seams

共享测试契约位于 `~/projects/grok-media-saver/.agents/skills/beadwork-run/references/`；以下文件名均相对此目录，读取前展开 `~` 并解析为真实绝对路径（固定使用本项目 primary checkout 的入口）。直接读取参考文件即可，不启动 `beadwork-run`。

- 使用 `to-spec` 前读取 `testing-seams.md`；确定测试模式和计划时读取 `testing-plan.md`。
- 使用 `to-tickets` 前读取 `testing-plan.md` 和 `testing-gates.md`；解析 seam 引用时读取 `testing-seams.md`。 为 Beadwork 拆票或调整顺序时另读 `serial-planning.md`，在同一次确认中批准增量切片及执行顺序，并使用其脚本发布、校验和接纳 parent 计划。
- 使用 `tdd` 前读取 `testing-seams.md`、`testing-tdd.md` 和 `testing-gates.md`；有 assigned ticket 时另读 `testing-plan.md`。

## Agent skills

### Issue tracker

本仓库的 issue 和 spec 使用 Beads。操作约定见 `docs/agents/issue-tracker.md`。

### Triage labels

使用五个默认 triage label。映射见 `docs/agents/triage-labels.md`。

### Domain docs

使用 single-context 领域文档布局。读取规则见 `docs/agents/domain.md`。

### JavaScript/TypeScript 工具链

- **mise** 锁定 Bun 本身的版本：`mise.toml` 声明兼容的版本 line，`mise.lock`
  锁定经验证的精确构建。仓库内一律通过 mise shim 或 `mise exec -- bun …` 调用
  Bun；升级 Bun 时更新 line 并用 `mise lock --bump` 刷新 lockfile。
- **Bun** 是应用代码与仓库脚本的宿主运行时，并管理依赖、workspaces 与
  lockfile：`bun ci` 是标准安装步骤；`Bun.build` 是默认 bundler；`bun test`
  是默认 test runner。
- **Biome** 负责格式化、lint（recommended 规则起步）与 import 排序；
  `biome ci` 由 `just gate-core` 纳入本地与交付的必需门禁。
- **just** 是 agent 工作流的命令契约接口。必需入口为 `install`、`test [ARGS...]`、
  `gate-core`、`gate-full`；`check-toolchain`、`typecheck`、`env-facts`、`fmt`
  是独立开发命令。`install` 需要宿主上的 `just`、`mise` 和可安装的 Bun：
  根据 `mise.toml`、`mise.lock` 安装 Bun，再按 `package.json`、`bun.lock`
  执行 `bun ci`，重复调用应得到同一锁定环境；工具或依赖准备失败须返回非零。
- `just test` 或 `just test all` 运行当前全部 Bun 测试；`just test core`
  运行 `tests/core`。可在 scope 后传测试路径和 Bun 的 `-t <name>`，
  也可直接传路径或 Bun 测试筛选参数；无法收窄时运行完整相关 suite。
  零匹配或测试收集失败须返回非零。
- `just gate-core` 无参数运行 Bun 版本检查、TypeScript 静态检查、
  `tests/core` 与 Biome CI，不启动外部服务。`just gate-full` 无参数先运行
  `gate-core`，再运行 `tests/cli`；CLI 测试使用隔离 Docker PostgreSQL、
  临时文件和真实子进程，不连接 Chrome、Extension 或 Grok。宿主须能运行
  Docker 与 `postgres:18-alpine` 镜像；现场浏览器验收另行记录。
  agent 验证通过 just 入口执行；格式化使用 `just fmt [files...]`。
- **版本策略**：`package.json` 中只有 Biome exact-pinned（格式化与 lint 的
  验证 identity），其余直接依赖用 caret range；`bun.lock` 必须提交，不因
  lockfile 已精确解析而改用 manifest exact pin。`preinstall` 内置 Bun 版本
  line gate，跨 line 运行会 fail closed。
- 优先使用 Bun / Biome 的能力；当前另用 `tsc --noEmit` 作权威 typecheck。
