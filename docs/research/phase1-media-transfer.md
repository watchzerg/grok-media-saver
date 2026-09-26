# 一期媒体传输：内存、完整性与停止的证据

> 当前适用范围（2026-09-26 修订）：用户已明确仅按图片和常见小视频交付，取消大视频专项支持、慢写、回压上界与峰值内存验收。下文保留调研时的事实与候选建议，相关大视频要求不再生效，也不构成交付阻断；本地受控浏览器服务方案 B 同样不在当前范围。普通媒体的完整性、超时、取消与清理仍以[一期规格](../specs/phase1-saving.md)为准。

旧 demo 观察日期：2026-09-25；第一方资料复核日期：2026-09-26。研究对象为 Beads 子票 `grok-media-saver-wee.3`「浏览器媒体传输的内存、完整性与停止证据」；本文件是调研，不是已批准的实现规格。当前 checkout 尚未安装 Playwright 或实现正式下载器。本报告未连接用户浏览器、未下载私人媒体，也没有测量大视频内存或停止延迟。

## 结论与证据边界

浏览器会话内的 `fetch` 能使用该页面的请求环境，但若一次 `page.evaluate()` 返回整个媒体，跨 Chrome、Playwright 与 Bun 的路径必须持有完整响应。旧 demo 实际按顺序请求 Range，并在页面内对每段调用 `arrayBuffer()`、转成 base64，通过 `page.evaluate()` 返回 Bun；Bun 再解码、写文件、更新 SHA-256。该方式**仅在服务端确实返回预期小段时限制单次返回载荷**，不证明 Chrome、Playwright 与 Bun 合计峰值仅等于块大小。尤其是 demo 在页面内完成 `arrayBuffer()` 后才把状态返回 Bun；即使后者拒绝 `200`，Range 被忽略时页面已经读取了完整媒体。依据本项目已迁入的[原始 demo](evidence/grok-playwright-extension-demo.ts)第 91—121 行和 [Playwright `page.evaluate()`](https://playwright.dev/docs/api/class-page#page-evaluate)。

以下是待一期讨论票选择的有界候选，不先锁定具体库或块大小：

| 路径 | 可证明的内存边界 | 停止与超时 | 当前限制 |
| --- | --- | --- | --- |
| `APIRequestContext` / Playwright `APIResponse.body()` 整体读取 | 无媒体大小无关的上界；`APIResponse.body()` 返回 `Buffer`，请求上下文保留响应体直到释放 | Playwright 1.63 的请求 `fetch` 有 `timeout` 和 `signal`，但取消不改变整段响应的内存性质 | 大视频不能凭此满足内存可控；上下文请求是否等同页面请求环境也须现场验证 |
| 页面 `fetch`，顺序 Range，一次只返回一段 | **仅当**先检查 status/可见头，再读取已核对的单段 `206`，返回载荷才受请求段长度约束；base64、序列化、解码和写入可同时占内存 | 页面 `fetch` 可用 `AbortController`；`page.evaluate()` 本身没有可传入的 `AbortSignal`，取消链路须设计与实测 | `200` 可能是忽略 Range 或 `If-Range` 不匹配；必须在调用 `arrayBuffer()` 前拒绝或切换为流式完整下载。浏览器仍可能预读，实际峰值需测量 |
| 页面 `fetch` 的 `ReadableStream` 分段，经 Playwright 分次传输 | 浏览器 Fetch 提供流；若每段经绑定回调交付 Bun 并等待写入，可形成有界队列的候选 | 同一个页面 fetch 的 `AbortController` 可取消请求/读取；须验证跨进程取消与 page 关闭收尾 | Playwright 可用 `page.exposeBinding()` 建立页面到 Bun 的异步调用，但没有直接映射为 Bun stream 的现成 API；分段复制、回压与错误传播须原型证实 |
| Bun 直接 `fetch` 并将 `Response` 流写临时文件 | Bun 文档明确响应体可流式写入，避免应用把全体载入 JS 内存 | Fetch `signal`、文件清理和写入中止仍须在项目内验证 | 不能假定直接 Bun 请求具备登录页面的 cookie、签名或相同媒体访问权限；仅在现场证明可用后考虑 |

来源：[Playwright 1.63 `APIRequestContext` 源文档](https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-apirequestcontext.md)、[Playwright `APIResponse` 与释放](https://playwright.dev/docs/api/class-apiresponse)、[Playwright `page.exposeBinding()`](https://playwright.dev/docs/api/class-page#page-expose-binding)、[Bun Fetch](https://bun.com/docs/runtime/networking/fetch)、[Bun File I/O](https://bun.com/docs/runtime/file-io)、[WHATWG Fetch](https://fetch.spec.whatwg.org/)。表中的浏览器至 Bun 复制成本和回压判断是从这些接口及旧 demo 代码作出的推断，尚无本项目实测峰值。

## 响应证据与拒绝条件

HTTP Range 指向**选定表示的字节序列**。有 `Content-Encoding` 时，字节范围相对于编码后的表示；若客户端取到解码后的 `arrayBuffer()`，便不能直接把其长度当作线上的 `Content-Range` 长度。浏览器页面脚本不能自行设置 `Accept-Encoding: identity`：`Accept-Encoding` 是 Fetch 禁止设置的请求头。页面路径需核对实际 `Content-Encoding` 与返回字节的关系；无法证明时不拼接分块。`Accept-Ranges` 仅是提示，不能作为未来 Range 一定生效的保证。[RFC 9110 §8.4、§14.1.2、§14.3](https://www.rfc-editor.org/rfc/rfc9110.html)、[Fetch 禁止请求头列表](https://fetch.spec.whatwg.org/#forbidden-request-header)。

旧 demo 曾观察到页面能读取 `206` 正文，却读不到 `Content-Range`。这与 CORS 过滤规则相符：`Content-Range` 和 `ETag` 均不在默认可读响应头列表，跨源响应须由服务端通过 `Access-Control-Expose-Headers` 放行；观察本身未证明具体原因。读取不到头也不意味着服务器未发送它：单段 `206` 按 HTTP 规范应携带 `Content-Range`。不能通过客户端自行补一个请求头解决服务端的暴露策略。[旧现场记录](2026-09-25-grok-playwright-extension-demo.md)、[Fetch 的 CORS 响应头过滤](https://fetch.spec.whatwg.org/#concept-filtered-response)、[RFC 9110 §15.3.7.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.3.7.1)。

| 响应 | 可接受的证据或处理方向 |
| --- | --- |
| `206` | 对分块拼接，优先要求可读取并核对预期单段 `bytes start-end/total`，验证起止、总长、实际字节数、内容编码与前段一致；`total=*` 或未知长度不足以证明最终完整文件，除非另有独立可信的完整性证据。拒绝多段响应、越界、空洞、重叠、短读及头与实际数据不符。头不可见的候选路径见下文；单有 `206`、请求偏移和返回长度不足以严格证实返回的就是该偏移。 |
| `200` 回应带 Range 的请求 | 服务端可合法忽略 Range，或 `If-Range` 不匹配而返回新完整表示。不得当作请求段写在偏移处；先取消/拒收完整体，再决定是否采用有界流式完整下载或重新确认媒体。 |
| `416` | 可能表示请求范围超出当前表示；`Content-Range: bytes */N` 可提供当前长度，但不能据此推断此前已下载片段有效。检查预期偏移、总长和版本后重新确认或失败。 |
| 无 `Content-Length` | 单响应流可统计本地字节数，但仅凭 EOF 与本地 SHA-256 不能证明等于目标完整媒体；需要与本次选定媒体对应的可靠预期总长、独立摘要或等价证据。分块路径仍须解决偏移与版本问题。 |
| 重定向、认证页、错误页、限流页 | 状态码、最终 URL、内容类型及初始内容均需校验；HTTP 成功或 SHA-256 本身不代表拿到目标媒体。错误分类交给 Core 的阻挡与有限重试规则。 |

**头不可见时的选择。** 旧 demo 的详情 `sizeBytes`、各块长度和累计长度只证明本地收齐了预期数量，无法独立证明每块偏移正确、各块属于同一版本；最终计算的 SHA-256 也只是拼接所得字节的摘要。给相邻段增加重叠检查能发现部分错位，仍不能证明全部字节位置或跨块版本。若端点不暴露 `Content-Range`，应先验证可否通过有权限且有界的另一路径获得该响应头，或改为**单次 `200` 流式传输**并与同一选定媒体的可信长度/摘要核对；后者无跨请求拼接歧义。独立的目标内容 SHA-256 若由可信来源提供，也可直接验证完整字节结果，但目前没有 Grok 提供此值的证据。没有足够证据时不发布为安全保存。本段是由上述接口和 HTTP 语义得出的方案判断，尚未验证 Grok 端点支持哪条路径。

跨请求版本一致性：优先考察强 `ETag` 与 `If-Range`，但只有端点实际提供、页面脚本可读取且服务端遵守时才能依赖。弱 ETag 不能用于 `If-Range`；`Last-Modified` 只有符合强验证条件才可用于这里。`If-Range` 不匹配会使服务器忽略 Range 并返回 `200`，仍要在读取整段前识别。总长度相同、URL 相同或事后计算的 SHA-256 一致，都不能单独证明各 Range 来自同一远端版本。若无可靠 validator，需要独立的预期内容哈希或业务媒体版本证据；仍无法证明时拒绝发布，重新获取详情并从头下载。[RFC 9110 §8.8、§13.1.5、§14.2、§14.4](https://www.rfc-editor.org/rfc/rfc9110.html)。

## 停止、超时与文件完整性

浏览器 Fetch 的响应体是 `ReadableStream`；取消 fetch 应通过页面侧可触达的 `AbortController` 实现，并验证 `abort` 是否能打断等待 headers、等待下一块和正在读 body。Playwright `page.evaluate()` 本身没有应用可传入的 `AbortSignal`；控制器须在页面内由后续调用触达，或有等效的取消通道，具体机制尚待原型证明。直接 `Promise.race` 超时只使 Bun 端不再等待，不能证明页面请求已停止。关闭自建 page 是候选后备清理，需确认不会误关用户已有页面，且断开时不留下后台传输。[Fetch 标准](https://fetch.spec.whatwg.org/)、[Playwright `page.evaluate()`](https://playwright.dev/docs/api/class-page#page-evaluate)。

每次传输应使用唯一临时文件；只有响应证据、总长度、写入字节数与计算出的 SHA-256 等必要条件成立后，才交给 Archive files 发布。SHA-256 证明的是**本地已接收字节**的稳定身份，只有与独立可信的远端摘要或完整长度和版本证据结合，才支持「完整媒体」判断。停止、超时、异常、短读时应关闭写入句柄并保留或清理临时文件，不能发布；具体临时文件恢复策略归文件系统决策票。[Bun 文件流写入](https://bun.com/docs/runtime/file-io)、[Fetch 标准](https://fetch.spec.whatwg.org/)。

应用层需要分别约束连接/首字节等待、相邻块无进展时间以及整个操作的上限，并在停止或明确全局阻挡时阻止下一次媒体请求。定时器触发必须连接到真实的请求取消与文件句柄收尾；只给外层 promise 加超时不够。具体时长应依据受控现场样本选择，不能从旧 demo 继承。

## 调研时建议的验证（历史方案，不作为当前验收清单）

1. **接口原型**：在本项目锁定的 Bun、Playwright Extension 版本上，用本地受控端点分别验证 `200`、标准 `206`、缺少 CORS 暴露的 `Content-Range`/`ETag`、忽略 Range、`416`、短读、慢响应、内容编码、同长版本切换与 abort。特别验证 `200` 是在读取 body **之前**发现并取消或改为有界流；`206` 无可读范围头时不得凭长度拼接发布。记录响应状态、关键非敏感头、实际字节数、Chrome/Bun 峰值内存、取消延迟和临时文件结局；不得记录 cookie、签名 URL 或完整私人响应。
2. **真实图片和代表性大视频**：在已登录 Chrome 的正式 Browser session 中确认媒体请求可达、目标身份与媒体版本证据、Range/validator/编码行为。测量 Chrome、Playwright/Bun 进程的峰值内存，及停止从发出到网络与写入结束的时间；记录样本大小和环境，不能用小图片推论大视频。
3. **完整路径验收**：图片和视频通过正式 TS CLI 保存到临时归档目录；重新读文件核对大小和 SHA-256；重复运行验证复用；故障注入验证截断、版本变化和取消均不发布；数据库与文件发布之间的恢复由后续专票验收。

目前没有可引用的本项目媒体传输实验数值。选择 Range、页面流或直接 Bun 流之前，须从第 1、2 项获得端点与进程边界证据；若真实端点不提供可证明完整性的条件，讨论票必须收缩支持范围或确定另一条证据链，不能仅以成功写文件作为一期验收。
