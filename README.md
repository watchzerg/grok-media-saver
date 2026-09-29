# grok-media-saver

利用现有 Chrome 登录态，将 Grok Saved 列表中的 AI 生成图片和常见小视频可靠保存到本地，并在安全保存后移除对应远端 Post。当前提供只读检查、单 Post／第一页保存、单 Post／连续批量归档、状态查询、文件核验和显式重试。

当前在仓库根目录直接运行 TypeScript 源码，使用 `just` 作为安装、检查与运行入口，无需构建。应用是前台 CLI，每次执行具体命令时按需连接数据库和浏览器；关闭进程后工作不会继续，没有 Web UI 或常驻服务。

## 快速开始

### 1. 准备前置环境

| 工具或资源 | 用途与准备方式 |
| --- | --- |
| mise、just | 安装与运行入口；按 [mise 安装说明](https://mise.jdx.dev/getting-started.html)和 [just 安装说明](https://just.systems/man/en/packages.html)安装，并确保命令在 PATH 中。Bun 由 `just install` 按仓库锁定版本安装。 |
| PostgreSQL | 实际归档的持久数据库；准备可访问的服务、独立项目数据库及登录用户。安装入口见 [PostgreSQL 下载页](https://www.postgresql.org/download/)。自动化 DB 测试使用 PostgreSQL 18。 |
| Chrome、Playwright Extension | 在日常使用的 Chrome profile 中安装 [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm)，打开 Chrome 并登录 Grok。 |
| 本地归档目录 | 存放媒体；使用可写且支持硬链接的文件系统。默认示例为仓库内的 `./archive`。 |
| Docker（完整门禁需要） | `just gate-full` 使用隔离的 `postgres:18-alpine` 测试容器；日常 CLI 使用你配置的 PostgreSQL 服务。 |

所有下述 shell 命令均在仓库根目录执行。首次使用若 mise 提示配置未受信任，先检查仓库的 `mise.toml`，再执行 `mise trust`。

### 2. 安装依赖与准备配置

```sh
just install

# 仅首次创建；已有 .env 时直接编辑，保留原配置
cp -n .env.example .env
```

编辑 `.env`，填写以下配置。配置优先级为进程环境变量 > `.env` > 程序默认值；已有的同名环境变量会覆盖文件配置。

| 配置 | 填写内容 |
| --- | --- |
| `GROK_DB_HOST`、`GROK_DB_PORT` | 项目 PostgreSQL 地址与端口。 |
| `GROK_DB_USER`、`GROK_DB_PASSWORD`、`GROK_DB_NAME` | 项目数据库登录用户、非空密码与数据库名。 |
| `GROK_ARCHIVE_DIR` | 当前归档根目录；相对路径以仓库根目录为基准，也可填写绝对路径。 |
| `PLAYWRIGHT_MCP_EXTENSION_TOKEN` | 点击已登录 Grok 的 Chrome profile 中的 Extension 图标，在扩展界面／状态页复制同名 token。它是扩展连接凭据，不是 Grok API key。 |

token 获取方式见 [Playwright Extension 官方说明](https://github.com/microsoft/playwright/blob/v1.63.0/packages/extension/README.md#using-your-unique-authentication-token)。本项目直接使用 Extension 连接，无需另行配置或启动 MCP 服务。`.env` 与默认 `archive/` 已被 Git 忽略；真实密码、token 和含 token 的连接页地址不要提交或写入日志。请求间隔与媒体超时可保留 [`.env.example`](.env.example) 中的默认值。

### 3. 准备并初始化项目数据库

`just install` 不启动 PostgreSQL，也不创建数据库。若尚未准备项目数据库，用管理员连接进入 `psql`（替换管理员名、地址和端口）：

```sh
psql -h 127.0.0.1 -p 5432 -U <管理员用户> -d postgres
```

在 **psql 内**执行以下首次创建示例；已有项目用户和数据库时跳过创建，核对登录与权限即可：

```sql
CREATE ROLE grok_media_saver LOGIN;
\password grok_media_saver
CREATE DATABASE grok_media_saver OWNER grok_media_saver;
\q
```

`\password` 交互式设置非空密码，随后将相同值填写到 `.env`。示例让项目用户拥有独立数据库，以便创建项目表并正常读写；不需要赋予它超级用户权限。数据库创建及密码命令见 [CREATE DATABASE](https://www.postgresql.org/docs/current/sql-createdatabase.html) 和 [psql](https://www.postgresql.org/docs/current/app-psql.html) 官方说明。

配置完成后：

```sh
just run db init
just run status
```

`db init` 只检查并创建当前项目 schema，不创建数据库、不清空数据、不启动浏览器。当前结构匹配时可以重复运行；旧 schema 不匹配时保留数据并失败，不自动迁移。新数据库的 `status` 应显示尚无 Run、没有未完成 Post。

### 4. 检查 Chrome 连接

```sh
just run inspect first-page
```

此命令只读取 Saved 第一页，不下载、不删除，也不创建 Run 或 Post 工作；它只需要 Chrome/Extension 配置。确认返回结果后，再进行下述人工验证。运行期间保持同一 Grok 账号，之后恢复也使用该账号；程序不验证稳定账号身份。

## 人工验证与日常使用

`just run` 后的参数原样传给 CLI。执行 `just run` 可查看用法，缺少命令时退出 `2`。下文的 `<Post-ID>` 均需替换为带连字符的 Post UUID，仅传 ID，不传整条 URL；ID 会去除首尾空白并转成小写。

### 先验证保存和文件核验

选择一个 Post，依次检查、保存并核验：

```sh
just run inspect post <Post-ID>
just run save post <Post-ID>
just run verify <Post-ID>
just run status
```

`inspect post` 检查身份、唯一主体媒体和所选画质，不下载文件。图片采用主体下载选择，视频选择已经存在的最高画质，不主动增强，最高已知候选失败时不降级。

`save post` 只保存，不移除远端 Post。每次新建 Run，读取当前详情；当前来源和本地大小、SHA-256 匹配时复用文件，否则下载并完整核验后无覆盖发布。已知的 PNG 声明／JPEG 内容错标按实际 JPEG 保存，其他 MIME 不一致仍失败。部分原始 MP4 的详情大小实际为 Base64 Data URL 长度，程序仅接受精确匹配的已知形状，仍严格核验响应与落盘的真实字节数。

`verify` 只检查当前归档目录中的文件大小与 SHA-256；有删除依据版本时核验该版本，否则核验当前保存版本。它不连接浏览器，不修复文件或改变数据库状态。正式媒体位于 `<归档目录>/<Post ID>/<SHA-256>.<扩展名>`；完整归档资产包含媒体目录与数据库，备份时应同时保留两者。

仅保存 Saved 第一页可执行：

```sh
just run save first-page
```

它只读取当前第一页（最多 40 项），串行保存，处理完即结束，不翻页或删除。普通单 Post 失败继续其他成员；认证／限流阻挡、停止或基础资源故障结束调度。

### 验证归档和连续批量归档

**`archive` 会在安全保存并核验文件后移除远端 Post。** 先对你选定的单 Post 验证，再按需要处理整个 Saved 列表：

```sh
just run archive post <Post-ID>
just run verify <Post-ID>
just run status
```

单 Post 归档可直接下载保存，也会核验复用已有文件；只有精确版本绑定的删除意图提交成功后才发起 DELETE。运行期间不要外部修改删除依据文件。已结清归档直接跳过；`save` 不会接管未结清的归档工作，也不会降低其目标。

准备好连续归档 Saved 列表时执行：

```sh
just run archive saved
```

每轮固定当前第一页，串行归档；同一 Run 的重现 Post 只安排一次。只有新确认移除后才等待固定 5 秒再读第一页；非空轮没有这种进展时以 No Progress 结束，不自动翻页或无限循环。只有读到合法空页、数据库所有 save/archive 工作都完成且正常收尾，才报告整体成功。终端展示本次发现、归档完成、已结清跳过、未确认完成、未处理、新确认移除、轮次与结束原因；未读到的范围未知，不展示全局百分比。

### 停止与恢复

首次 Ctrl+C 停止安排新工作，并完成必要收尾，退出 `130`；在途 DELETE 只在原 30 秒期限内收集结果。第二次 Ctrl+C 强退，可能留下未收尾事实。停止或失败后先查看状态，再处理原因并显式接续：

```sh
just run status
just run retry
```

`retry` 每次新建 Run，处理启动时已存在的未完成工作，保持原 save/archive 目标；保存项不会因此升级为删除工作。空集合只需 DB，不连接浏览器；非空集合还需要归档目录和 Chrome/Extension。

- 已开始的未完成 Post 用 `retry` 接续；批量运行已发现但尚未开始的成员没有预建工作，重新运行 `archive saved` 发现。
- 删除结果未知时先核对同一远端目标，不盲目重发 DELETE；已移除未结清时仅接续原绑定版本的文件核验或补救。
- No Progress 中已结清但再次出现的 Post 不会由 `retry` 清除；核对原因后再决定下一步。
- `status` 只读数据库事实，不检查文件，也不能判断进程是否存活；摘要提交失回执时，先用它读取实际持久结果。
- 文件冲突不会覆盖；遇到权限、文件缺失或清理错误时保留现场，核对 `status` 和 `verify` 后处理。切换归档目录只检查新目录，不搜索旧目录。

退出码：`0` 成功，`1` 执行／核验失败或未完成，`2` 参数／配置错误，`130` 用户停止。清理失败可使业务已完成的命令仍退出 `1`，不撤销已提交事实。详细失败分类、恢复与现场清单见 [运行与恢复指南](docs/development/phase1-runbook.md#批量归档和显式恢复)。

## 开发检查与验收边界

```sh
just gate-core

# Docker 可用时运行完整本地门禁
just gate-full
```

`gate-core` 检查 Bun 版本、TypeScript、核心测试和 Biome，不启动外部服务。`gate-full` 再运行真实 CLI 子进程和隔离 Docker PostgreSQL 测试；测试自行准备并清理资源，测试容器不用于日常运行。两者都不连接 Chrome、Extension 或 Grok，也不替代人工验证。

其他入口：`just test` 运行全部 Bun 测试，`just test core` 运行核心测试，`just fmt` 格式化，`just --list` 查看可用命令。

正式一期现场证据覆盖连接、普通图片、小视频保存和代表性取消清理；真实高清、真实断连与清理故障未完成现场验收。二、三期归档的正式 Chrome/Extension/Grok 现场验收仍待人工执行。历史样本与细节见 [一期验收记录](docs/research/phase1-acceptance.md)和 [二期交付覆盖核对](docs/research/phase2-acceptance.md)。

## 文档入口

- [产品目标与首版范围](docs/specs/product-goals.md)：已确认的目标基线、产品原则与完成标准。
- [架构设计](ARCHITECTURE.md)：已确认的模块职责、运行方式与恢复方向。
- [一期可靠保存规格](docs/specs/phase1-saving.md)：一期行为、持久事实、恢复及测试边界。
- [二期单 Post 完整归档规格](docs/specs/phase2-archiving.md)：单 Post 归档、删除判据与恢复。
- [三期批量归档规格](docs/specs/phase3-batch-archiving.md)：连续归档的调度、摘要、完成条件与测试边界。
- [一期开发者运行与恢复](docs/development/phase1-runbook.md)：安装、配置、命令、核验与中断接续。
- [一期验收记录](docs/research/phase1-acceptance.md)：正式浏览器与本地边界的证据、限制。
- [二期交付覆盖核对](docs/research/phase2-acceptance.md)：40 条用户故事、7 组自动化矩阵及现场未验证范围。
- [实现路线图](docs/development/implementation-roadmap.md)：三期范围、依赖、风险验证时点与结束标准。
- [详细文档索引](docs/INDEX.md)：文档分类、权威来源与维护规则。
- [Beads 约定](docs/agents/issue-tracker.md)：issue 和 spec 的操作入口。
- [领域词汇](CONTEXT.md)：项目领域命名。
