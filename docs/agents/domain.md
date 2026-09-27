# Domain docs

本仓库采用 single-context 布局：根目录的 `CONTEXT.md` 记录领域词汇，`docs/adr/` 记录架构决策。

其他文档的入口与维护规则见 [docs/INDEX.md](../INDEX.md)。

涉及领域行为、数据模型或命名时，读取 `CONTEXT.md`；涉及已记录的设计决策或冲突时，读取相关 ADR。ADR 目录及文件按实际需要创建，在领域术语或决策明确后使用 domain-modeling 工作流维护。

在 issue、方案、代码和测试中沿用 `CONTEXT.md` 定义的术语。发现与现有 ADR 冲突时，明确指出冲突及原因。
