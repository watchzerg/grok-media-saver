# 详细文档索引

本文维护 `docs/` 内的分类、阅读入口和适用范围。按任务读取相关文档。

## 分类与分工

| 目录 | 职责 | 当前入口 |
| --- | --- | --- |
| `agents/` | agent 工作流与详细规则 | [Beads](agents/issue-tracker.md)、[triage labels](agents/triage-labels.md)、[领域文档规则](agents/domain.md)、[测试设计与验收](agents/testing.md) |
| `specs/` | 已确认、需要在仓库中维护的产品或配置契约 | [产品目标与首版范围](specs/product-goals.md)、[一期可靠保存规格](specs/phase1-saving.md)、[二期单 Post 完整归档规格](specs/phase2-archiving.md)、[三期批量归档规格](specs/phase3-batch-archiving.md) |
| `research/` | 带版本和观察时点的调研、实验与证据 | [一期验收记录](research/phase1-acceptance.md)、[二期交付覆盖核对](research/phase2-acceptance.md)、[归档核心模型与 HTTP 参考](research/core-archive-model-and-http.md)、[Playwright Extension 媒体下载验证](research/2026-09-25-grok-playwright-extension-demo.md) |
| `development/` | 实现路线、开发、构建、测试与依赖维护说明 | [一期开发者运行与恢复](development/phase1-runbook.md)、[实现路线图](development/implementation-roadmap.md)、[技术选型与依赖管理](development/technology-stack.md) |

按需新增以下分类，不预建空目录：

- `adr/`：重要架构决策的背景、取舍与替代关系。
- `operations/`：部署、发布、备份、恢复与排障指南。

研究附件可与正文放在一起；附件较多时再使用 `research/evidence/`，由相关正文链接。根目录的 [ARCHITECTURE.md](../ARCHITECTURE.md)记录已确认架构；[领域词汇](../CONTEXT.md)定义 Saved 列表、Run、Post 工作和完整归档等术语。

## 一期研究入口

以下报告是设计证据与候选方案，不代表实现验收或已批准的技术选择；研究票记录分支、commit 和结论。2026-09-26 用户已取消大视频专项支持和验收，研究中相关建议仅保留历史背景，当前范围以一期规格为准。

- [浏览器连接与资源生命周期](research/phase1-browser-session.md)
- [Post 身份与媒体解析](research/phase1-post-media-protocol.md)
- [Post 单媒体、衍生切换与清晰度现场观察](research/post-identity-quality.md)
- [媒体传输与停止研究（含已取消的大视频历史建议）](research/phase1-media-transfer.md)
- [所选媒体总长度与内容摘要的现场证据](research/media-completeness-evidence.md)
- [原始 MP4 详情大小为 Data URL 长度的诊断](research/mp4-data-url-size.md)
- [PostgreSQL 事务与执行器互斥](research/phase1-postgres-boundaries.md)
- [文件无覆盖发布与恢复](research/phase1-file-publication.md)

## 二期研究入口

- [关联移除实验记录](research/phase2-association-removal-experiment.md)：两组已授权 DELETE、同目标查询和关联媒体完整比较；包含前置保存、故障接续与证据边界。

## 权威来源与适用范围

- 本仓库的 issue、spec、执行计划与验收记录以 Beads 为入口，操作规则见 [Beads 约定](agents/issue-tracker.md)。[产品目标与首版范围](specs/product-goals.md)是已确认目标的权威正文；后续具体规格与计划引用该文档，不重复维护目标正文。
- `CONTEXT.md` 定义领域词汇，[ARCHITECTURE.md](../ARCHITECTURE.md)定义已接受的模块职责与架构决定，ADR 记录重要决策及其理由。现有内容与后续变更冲突时，先明确冲突并更新权威来源。
- [一期可靠保存规格](specs/phase1-saving.md)维护一期行为、持久事实、恢复及 Testing Decisions；Beads 决策票保留过程与确认记录，后续实现票引用规格。
- [二期单 Post 完整归档规格](specs/phase2-archiving.md)维护归档目标、删除资格与判据、持久删除事实、恢复及二期 Testing Decisions；对一期明确扩展的行为以二期为准，未变更的保存契约继续引用一期。`grok-media-saver-we2` 保留决策来源，详细契约由二期规格承接。
- [三期批量归档规格](specs/phase3-batch-archiving.md)维护 `archive saved` 连续第一页调度、新确认移除、去重与预算、等待和结束条件、批量摘要及三期 Testing Decisions。设计、修改或验证这些行为时必须读取；单 Post 保存、删除与恢复继续引用一二期。`grok-media-saver-ozd` 保留决策来源，规格确认不表示入口已实现。
- [技术选型与依赖管理](development/technology-stack.md)维护工具和依赖政策；当前版本以配置与 lockfile 为准。根 [justfile](../justfile)及其调用代码定义实际命令行为。
- [测试设计与验收](agents/testing.md)维护按改动选择验证的规则及共享流程入口；具体规格维护行为覆盖、approved seams 和现场验收要求。
- `research/` 记录观察和证据；研究建议本身不构成产品合同。
- [README.md](../README.md) 是使用入口；安装、配置和运行步骤应以实际可执行的项目状态为准。

## 维护规则

- `ARCHITECTURE.md` 是每项任务的必读入口，保持正文精炼，聚焦整体结构、模块职责和关键约束；详细行为、决策背景与操作步骤放在对应规格、ADR 或指南中，通过明确的按需链接展开。
- 按文档用途归类；具体主题文件使用小写连字符命名，目录索引统一使用 `INDEX.md`，ADR 使用编号加小写主题命名。
- 新增、移动或删除文档时，同步更新本索引与受影响的引用；仅在有内容时新增目录。
- 每项契约只维护一份权威正文，其余位置使用链接或明确的 Beads 引用。
- Beads 记录 ticket 生命周期和验收证据；文档不复制 `open`、`closed` 等易变状态。
- research 保留观察时的版本；当前运行版本以实际依赖声明和代码为准。
- 已被现行规格吸收的计划通过 Git 与 Beads 留存；只有仍需对照阅读的历史内容才保留独立文档，并标明其替代来源。
