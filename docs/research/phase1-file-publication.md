# 一期文件无覆盖发布与恢复调研

观察日期：2026-09-25；复核日期：2026-09-26。复核环境：macOS 27.0、mise 管理的 Bun 1.4.2、`/private/tmp` 一次性目录。本文提供文件边界的证据和候选协议，具体路径与恢复规则由「文件命名、无覆盖发布与恢复协议」决策票确定。未接触用户媒体、旧项目或业务数据库。

## 系统语义

| 操作 | 第一方依据 | 对本项目的含义 |
| --- | --- | --- |
| `rename(old, new)` | [Apple `rename(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/rename.2.html)：已有 `new` 会先被移除，源与目标须在同一文件系统。 | 不能用它发布到可能已存在的正式路径；先检查目标再 `rename` 仍有竞态。 |
| `link(temp, final)` | [Apple `link(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/link.2.html)：原子创建新目录项；目标存在为 `EEXIST`，跨文件系统为 `EXDEV`；两个名字共享同一文件，删除临时名字不删除最终文件。 | 经核验的临时文件与最终文件位于同一文件系统时，可原子创建正式名称且不覆盖目标。 |
| `open(path, 'wx')` | [Apple `open(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/open.2.html) 的 `O_CREAT|O_EXCL` 对已有对象及悬空符号链接失败；[Node 文件标志](https://nodejs.org/api/fs.html#file-system-flags)定义 `wx`。 | 可独占创建随机临时名。若直接写最终名称，下载中断会留下看似正式的半成品。 |
| `FileHandle.write()` | [Node `FileHandle.write`](https://nodejs.org/api/fs.html#filehandlewritebuffer-offset-length-position) 返回实际 `bytesWritten`，要求同一句柄的写入按序等待。 | 须处理短写，最终从磁盘重新读取并计算大小与 SHA-256。旧 demo 忽略 `bytesWritten`，其样本核验不证明通用写入正确。 |
| 文件 `sync()` | [Node `FileHandle.sync`](https://nodejs.org/api/fs.html#filehandlesync)请求同步描述符的数据；[Apple `fsync(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html)指出普通 `fsync` 不能承诺驱动器断电后数据已物理落盘。 | 发布前同步文件并检查错误；不能据此承诺断电安全。 |
| 目录 `sync()` | [Node `FileHandle.sync`](https://nodejs.org/api/fs.html#filehandlesync)可对已打开句柄调用；本机 Bun 对目录句柄调用成功。 | `link` 后、临时名清理后可同步所在目录。调用成功不证明 APFS、外置盘或网络盘在断电时的持久顺序。 |

[Bun 的 Node 兼容说明](https://bun.sh/docs/runtime/nodejs-compat#nodefs)将 `node:fs` 列为已实现，但不保证所有系统调用和文件系统组合一致。本机实测只支持当前环境的结论。`link` 的无覆盖保证是目录项创建语义，不保证文件内容不会被其他有写权限的进程随后改动。

## 本机窄实验

在 `os.tmpdir()` 下用 `mkdtemp` 建目录，以 Bun 的 `node:fs/promises` 顺序执行，每次清理临时目录；未模拟断电，未操作真实归档目录。输入文件只含 `AAA`、`BBB`。

| 步骤 | 观察 |
| --- | --- |
| `a=AAA`、`b=BBB` 后执行 `rename(a,b)` | `b=AAA`，原 `BBB` 被替换。 |
| 重新创建 `a=AAA`，执行 `link(a,b)` | 返回 `EEXIST`，`b` 仍为 `AAA`。 |
| 将目标设为悬空符号链接后执行 `link(a,target)` 与 `open(target,'wx')` | 两者均返回 `EEXIST`，没有沿符号链接写入。 |
| `link(a,published)`、比较 inode、`unlink(a)` | 两个名字原先指向同一 inode；移除临时名后正式名仍可读出 `AAA`。 |
| 对普通文件及目录调用 `FileHandle.sync()` | 均成功。 |

跨文件系统 `EXDEV` 由 Apple 文档支持，未在独立挂载点实测；目录同步成功也不是断电试验。若实际归档目录位于外置盘或网络盘，需在该目录验证硬链接、目录同步和错误处理。

## 候选最小协议与中断点

以下是供决策票评估的推断，不是已批准的实现：

1. 在当前配置归档根目录中的受控位置，用不可预测临时名及 `wx` 创建普通文件。限制路径组件和目录所有权；拒绝符号链接与特殊文件。流式写入逐次核对 `bytesWritten`，写入完成后校验 HTTP 完整性条件、文件大小及重新读取所得 SHA-256。对临时文件 `sync()` 并关闭；同步或关闭失败均不记为保存成功。
2. 向 PostgreSQL 提交发布意图，记录 Post 和媒体版本身份、正式相对路径、预期大小与 SHA-256，以及可辨认的临时名。先提交意图，再尝试 `link(temp, final)`。数据库提交失败时不发布；意图前的残留临时文件作为待清理孤儿，不能据此宣称保存成功。
3. `link` 成功后同步所在目录；`EEXIST` 时先 `lstat`，仅对普通文件重新读取大小和 SHA-256，匹配才可复用，不匹配或为符号链接、特殊文件则保留目标并报告冲突。`EXDEV`、不支持硬链接、I/O 或同步错误均保留待核对状态，不降级为可覆盖的 `rename`。若目录由其他写入者控制，`lstat` 与后续读取之间仍有竞态，必须定义受控目录边界。
4. 只有最终路径核验通过，才提交数据库保存成功。此后清理本次工作可证明归属的临时名，并同步目录。若清理失败，成功文件仍在，但须报告待清理项；不能删除来源不明的 `.part`。

| 进程退出位置 | 下次执行时可辨认的事实与动作 |
| --- | --- |
| 写入中、意图提交前 | 没有保存成功事实；随机临时文件可能残留。仅在可证明归属时清理，否则保留并报告；重新下载。 |
| 意图已提交、正式名不存在 | 核验已记录临时文件；完整则重试无覆盖发布，否则重新下载。 |
| `link` 已成功、数据库成功提交前 | 按意图核验正式文件。匹配时补记保存事实；不匹配时报告冲突，不覆盖。 |
| 数据库已记成功、临时名尚在 | 核验正式文件后清理已知临时名。 |
| 数据库已记成功、正式文件后来缺失或变更 | 状态查询仍展示历史记录；显式核验或恢复时发现异常。后续执行须重新满足本地安全保存条件，不能只凭旧记录删除远端。 |

此协议依赖数据库与文件系统之间的核验，二者没有共同事务。下载中途退出允许重新下载，不要求字节级续传。若归档根目录配置改变，按已确认架构只在当前目录查找和核验；旧目录中的文件不自动定位或迁移。数据库已确认完整归档的 Post 再次出现时按既定契约直接跳过，不触碰文件系统。

## 不能据此承诺及实施期验证

- **进程崩溃与断电不同。** 正常退出、`SIGKILL` 或崩溃可通过遗留目录项与数据库事实做恢复；没有测得断电后文件内容、目录项和 PostgreSQL WAL 的共同持久顺序。[Apple `fsync(2)`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html)明确否定普通 `fsync` 对驱动器断电安全的绝对承诺。
- **需要真实中断注入。** 实施时使用隔离 PostgreSQL 与临时归档目录，在意图提交前后、`link` 前后、保存成功提交前后杀掉独立子进程，并核验不覆盖、正确补记及临时文件清理。本文只验证原语，不验证完整恢复协议。
- **需要最终介质验证。** 在实际归档文件系统验证 `link`、`sync`、权限及空间不足等失败；若要承诺断电级安全，需另行定义设备、文件系统、`F_FULLFSYNC`/数据库配置和故障注入标准。
