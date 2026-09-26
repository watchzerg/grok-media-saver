# grok-media-saver

本项目面向个人本地使用，目标是利用现有 Chrome 登录态，将 Grok Saved 列表中的 AI 生成图片和常见小视频可靠归档到本地，并在安全保存后移除对应远端 Post。当前不建设大视频专项能力或性能验收；范围见[产品目标与首版范围](docs/specs/product-goals.md)。

目前仓库处于初始化阶段，尚无应用代码。[产品目标与首版范围](docs/specs/product-goals.md)已确认；[一期可靠保存规格](docs/specs/phase1-saving.md)已确认；执行任务与验收记录以本仓库的 Beads 为入口。

## 工具链

本仓库使用 mise 锁定 Bun，使用 Bun 管理依赖，使用 Biome 检查代码。安装依赖与运行当前可用的验证：

```sh
just install
just gate-full
```

`mise.toml` 声明 Bun 的兼容版本 line，`mise.lock` 固定精确构建；`package.json` 声明依赖，`bun.lock` 固定解析结果。两份锁文件均应提交。升级时先更新声明或允许范围，再刷新对应锁文件并重新运行验证。

目前 `gate-full` 运行 `gate-core`，覆盖 Bun 版本、现有脚本的 TypeScript 静态检查与 Biome 检查。`just test` 或 `just test all` 调用全部 Bun 测试，`just test core [path] [-t name]` 调用基础测试或指定路径；也可直接传测试路径与 Bun 筛选参数。在首个测试写入前，测试命令会因没有可收集的测试而失败。应用测试与构建、数据库、浏览器、系统边界尚未建立；增加真实测试或边界时，将相应验证纳入 `gate-core` 或 `gate-full`。

## 文档入口

- [产品目标与首版范围](docs/specs/product-goals.md)：已确认的目标基线、产品原则与完成标准。
- [架构设计](ARCHITECTURE.md)：已确认的模块职责、运行方式与恢复方向。
- [实现路线图](docs/development/implementation-roadmap.md)：三期范围、依赖、风险验证时点与结束标准。
- [详细文档索引](docs/INDEX.md)：文档分类、权威来源与维护规则。
- [Beads 约定](docs/agents/issue-tracker.md)：issue 和 spec 的操作入口。
- [领域文档规则](docs/agents/domain.md)：领域词汇与 ADR 的阅读约定。

应用建立后，在此补充安装、配置、运行和验证步骤，并链接现行规格。
