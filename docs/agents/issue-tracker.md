# Issue tracker: Beads

本仓库的 issue 和 spec 存放在 Beads 中，tracker 操作使用 `bd` CLI。引用 issue 时使用完整 bead ID。

## 常规操作

- 创建：`bd create "<title>" --body-file <path> --type <type> --json`
- 读取：`bd show <id> --json`
- 列出：`bd list --json`；包含已关闭条目时使用 `bd list --all --json`
- 查找可执行工作：`bd ready --json`
- 领取：`bd update <id> --claim --json`
- 更新状态：`bd update <id> --status <status> --json`
- 添加或删除标签：`bd update <id> --add-label <label> --json` 或 `bd update <id> --remove-label <label> --json`
- 读取评论：`bd comments <id> --json`
- 添加评论：`bd comments add <id> "<comment>"`
- 关闭：`bd close <id> --reason "<reason>" --json`

Beads `status` 表示生命周期，`type` 表示工作类型，triage label 表示处理路径。五个 triage label 见 `docs/agents/triage-labels.md`。

## Skill operations

- “Publish to the issue tracker” 表示使用 `bd create` 创建 bead。
- “Fetch the relevant ticket” 表示读取 `bd show <id> --json` 和 `bd comments <id> --json`。
- 自动化调用使用 `--json` 输出。

## Wayfinding operations

- map 使用 `epic` 类型和 `wayfinder:map` label。
- 子 ticket 使用对应的 Beads 类型和 `wayfinder:<type>` label，并通过 `--parent <map-id>` 关联 map。
- 阻塞关系使用 `bd dep <blocker-id> --blocks <blocked-id>`。
- 查询未分配且没有 active blocker 的子 ticket：`bd ready --parent <map-id> --unassigned --json`。
- 领取 ticket 使用原子操作 `bd update <ticket-id> --claim --json`。
