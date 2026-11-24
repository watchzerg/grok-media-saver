# 测试设计与验收

编写或修改测试、选择测试模式或验收门禁，以及定义或核对 seam / Test plan 前，必须读取本文。

## 按改动选择验证

- 文档或注释变更检查差异、链接及受影响的引用；仅当改变可执行行为时运行相应应用测试。
- 代码变更通过 `mise run test` 或 `mise run test-full` 运行覆盖受影响行为的最窄有效 suite，并选择相关静态检查或 `mise run gate-core`。涉及 DB、文件、CLI 进程或资源生命周期时，覆盖对应真实边界；影响广泛或无法可靠收窄时运行 `mise run gate-full`。
- 普通交付不固定要求每次运行 `gate-full`。当前任务明确要求的验收门禁仍须完成；必需验证失败、收集失败或零匹配不算通过。最终修改后重新执行受影响的检查，报告结果及未验证范围。
- 自动化门禁不访问 Chrome、Extension 或 Grok。产品规格规定现场验收的场景与阻断条件，现场证据和本地测试各自说明覆盖范围。

## 当前命令与验收来源

根 [mise.toml](../../mise.toml) 及 `mise-tasks/` 定义实际执行范围。`mise run test` 运行 `tests/core` 核心测试，`mise run test-full` 运行 `tests/cli` 边界测试；两者均支持路径和 `-t <name>` 筛选。`gate-core` 并行包含 Bun 版本检查、Biome CI、TypeScript 与核心测试；`gate-full` 在 `gate-core` 通过后运行 `test-full`，需要 Docker 与 `postgres:18-alpine` 镜像。测试时的环境变量统一通过 `mise.toml` 中测试 task 的 `env`（`[tasks.test.env]`、`[tasks.test-full.env]`）管理，隔离开发 `[env]` 与 `mise.local.toml` 中的本机凭据；新增测试级环境变量须纳入 mise env，不依赖 `.env`。各层目录、资源边界和当前保留范围见[测试分层与保留范围](../development/test-layers.md)。

设计、修改或核对行为测试与验收时，必须通过[文档索引](../INDEX.md#权威来源与适用范围)定位当前任务适用的现行规格，并读取其中的测试决策、approved seams、行为覆盖和现场验收要求；有 assigned ticket 时同时核对其 acceptance 与 Test plan。本文维护通用验证流程，具体行为与验收要求由对应规格维护。
