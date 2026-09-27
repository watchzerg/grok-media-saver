# 测试设计与验收

编写或修改测试、选择测试模式或验收门禁、定义或核对 seam / Test plan、拆票或调整 Beadwork 计划，以及使用 `to-spec`、`to-tickets`、`tdd` 前，必须读取本文。

## 按改动选择验证

- 文档或注释变更检查差异、链接及受影响的引用；仅当改变可执行行为时运行相应应用测试。
- 代码变更通过 `just test` 运行覆盖受影响行为的最窄有效 suite，并选择相关静态检查或 `just gate-core`。涉及 DB、文件、CLI 进程或资源生命周期时，覆盖对应真实边界；影响广泛或无法可靠收窄时运行 `just gate-full`。
- 普通交付不固定要求每次运行 `gate-full`。当前任务明确要求的验收和 Beadwork 阶段门禁仍须完成；必需验证失败、收集失败或零匹配不算通过。最终修改后重新执行受影响的检查，报告结果及未验证范围。
- 自动化门禁不访问 Chrome、Extension 或 Grok。产品规格规定现场验收的场景与阻断条件，现场证据和本地测试各自说明覆盖范围。

## 当前命令与验收来源

根 [justfile](../../justfile) 及其调用代码定义实际执行范围。`just test` 或 `just test all` 运行全部 Bun 测试，`just test core` 选择核心测试；支持路径和 `-t <name>` 筛选。`gate-core` 包含 Bun 版本检查、TypeScript、核心测试与 Biome CI；`gate-full` 再运行 CLI 边界测试，需要 Docker 与 `postgres:18-alpine` 镜像。

设计、修改或核对行为测试与验收时，必须通过[文档索引](../INDEX.md#权威来源与适用范围)定位当前任务适用的现行规格，并读取其中的测试决策、approved seams、行为覆盖和现场验收要求；有 assigned ticket 时同时核对其 acceptance 与 Test plan。本文维护通用验证流程，具体行为与验收要求由对应规格维护。

## 共享测试契约

共享规则位于 `~/projects/grok-media-saver/.agents/skills/beadwork-run/references/`。以下文件名均相对此目录；读取前展开 `~` 并解析为真实绝对路径，固定使用本项目 primary checkout 的入口。直接读取参考文件即可，不启动 `beadwork-run`。

- 定义或解析 seam、使用 `to-spec` 前，读取 `testing-seams.md`。
- 确定测试模式、编写或核对 Test plan 时，读取 `testing-plan.md`。
- 选择验收门禁或核对 Beadwork 阶段要求时，读取 `testing-gates.md`。
- 使用 `to-tickets` 前，读取 `testing-plan.md` 和 `testing-gates.md`；解析 seam 时另读 `testing-seams.md`。为 Beadwork 拆票或调整顺序时另读 `serial-planning.md`，在同一次确认中批准增量切片及执行顺序，并使用其脚本发布、校验和接纳 parent 计划。
- 使用 `tdd` 前，读取 `testing-seams.md`、`testing-tdd.md` 和 `testing-gates.md`；有 assigned ticket 时另读 `testing-plan.md`。

本文维护项目读取入口，共享文件维护流程正文。
