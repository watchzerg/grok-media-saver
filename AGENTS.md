## 交付原则

- 这是个人项目。交付满足当前请求的最小、直接、可验证变更，保持局部性并沿用既有命名与工作流程；新增抽象、依赖或配置须解决当前问题，未来改进留作建议。
- 覆盖改动涉及的运行边界、用户可见失败、数据完整性、资源清理、凭据和破坏性操作风险。复杂设计须说明当前收益与更简单的替代方案；仅在范围、行为或风险有实质歧义时请求确认。
- 修改代码后检查受影响的现行文档，按需同步权威正文及引用。

## 开发与验证

- 通过 mise shim 或 `mise exec -- bun …` 使用锁定的 Bun；agent 安装、测试、验证和格式化通过根 `justfile`。
- 常用入口如下；其他命令查 `just --list`，实际执行范围以 recipe 及其调用代码为准。

| 入口 | 用途 |
| --- | --- |
| `just install` | 准备锁定环境 |
| `just test [ARGS...]` | 默认全部测试；`core` 选择核心测试，支持路径和 `-t <name>` 筛选 |
| `just fmt [files...]` | 格式化与既定安全修复 |
| `just gate-core` | 静态检查与核心回归 |
| `just gate-full` | 完整本地门禁，包含真实 CLI/DB 边界 |

- 按改动影响与风险选择最窄有效测试及必要门禁；交付说明验证结果和未验证范围。必需检查失败、收集失败或零匹配不能作为通过证据。
- `gate-core` 无需外部服务；`gate-full` 包含隔离 Docker PostgreSQL 与真实 CLI 边界测试。自动化门禁不连接 Chrome、Extension 或 Grok，现场验收另行记录。

## 按任务读取

开始任何任务前，必须读取 [ARCHITECTURE.md](ARCHITECTURE.md)，建立对模块职责和架构约束的共同理解；其中链接的详细资料按当前任务需要展开。

下表是必读路由：开始对应工作前必须读取并遵守目标文档。命中多项时读取全部相关入口；入口要求继续读取的规格或共享规则也须按条件展开，不能只读索引。已在本次任务读取且未变化的内容无需重复加载。

| 任务 | 入口与用途 |
| --- | --- |
| 了解当前能力、安装配置或运行项目 | [README.md](README.md)：使用入口与当前限制 |
| 涉及领域行为、数据模型、命名或已有决策冲突 | [CONTEXT.md](CONTEXT.md)及[领域文档规则](docs/agents/domain.md)：术语与相关 ADR |
| 设计、修改、排查或 review 产品行为，或查找、维护文档 | [docs/INDEX.md](docs/INDEX.md)：定位并读取适用的现行规格；遵循文档分类与维护规则 |
| 操作 Beads issue 或 spec | [Beads 约定](docs/agents/issue-tracker.md) |
| 进行 triage 或调整 triage label | [标签规则](docs/agents/triage-labels.md) |
| 选库、变更依赖或 lockfile、调整工具链、构建或 just 命令、设计或开发页面 | [技术选型与依赖管理](docs/development/technology-stack.md)：选型与版本政策 |
| 编写或修改测试、选择测试模式或验收门禁、定义或核对 seam / Test plan、拆票或调整 Beadwork 计划，或使用 `to-spec`、`to-tickets`、`tdd` | [测试设计与验收](docs/agents/testing.md)：验证选择与共享规则入口 |
