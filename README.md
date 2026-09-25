# grok-media-saver

本仓库正在初始化。目前尚无应用代码或本仓库的产品规格；具体产品行为应在本仓库的 Beads 中确定。

## 工具链

本仓库使用 mise 锁定 Bun，使用 Bun 管理依赖，使用 Biome 检查代码。安装依赖与运行当前可用的验证：

```sh
just install
just gate-full
```

`mise.toml` 声明 Bun 的兼容版本 line，`mise.lock` 固定精确构建；`package.json` 声明依赖，`bun.lock` 固定解析结果。两份锁文件均应提交。升级时先更新声明或允许范围，再刷新对应锁文件并重新运行验证。

目前 `gate-full` 运行工具链、现有脚本的 TypeScript 静态检查与 Biome 检查。`just test core [path] [-t name]` 已接入 Bun 测试运行器；在首个测试写入前，它会因没有可收集的测试而失败。应用测试与构建、数据库、浏览器、系统边界尚未建立；增加真实测试或边界时，将相应验证纳入 `gate-core` 或新增边界 gate，并同步更新 `gate-plan` 和 `gate-full`。

## 文档入口

- [详细文档索引](docs/INDEX.md)：文档分类、权威来源与维护规则。
- [Beads 约定](docs/agents/issue-tracker.md)：issue 和 spec 的操作入口。
- [领域文档规则](docs/agents/domain.md)：领域词汇与 ADR 的阅读约定。

应用建立后，在此补充安装、配置、运行和验证步骤，并链接现行规格。
