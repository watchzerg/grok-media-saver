# 所选媒体长度与摘要：登录现场有限样本

观察日期：2026-09-26。为研究 Beads「所选媒体总长度与内容摘要的现场证据」，通过已安装的 Playwright Extension 连接用户当前登录的 Chrome，在自建 Grok 标签页读取 Saved 第一页，再各取一个 JPEG 和基础 MP4。对每个样本只读同源详情与**详情根 `key` 指向的媒体**，对后者发起一次完整 `GET`，将响应流读到 EOF 并计数。没有点击生成、Upscale、Download、删除或 Saved 状态控件；没有保存媒体、原始详情、Cookie、令牌、Post ID 或媒体 URL。脚本结束时关闭自建 Grok 页并断开连接。以下 A、B 是去身份化代称；样本来自列表第一页的前 20 条，不能代表全部内容。

## 当前观察

| 观察层 | A：JPEG | B：基础 MP4 |
| --- | --- | --- |
| `GET /rest/assets/<所选 Post>` 根详情 | `assetId` 匹配请求；`mimeType: image/jpeg`；`sizeBytes: 188093`；存在根 `key` | `assetId` 匹配请求；`mimeType: video/mp4`；`sizeBytes: 1114163`；存在根 `key` |
| 实际媒体 `GET` 的网络层响应 | `200`；`Content-Type: image/jpeg`；`Content-Length: 188093`；未见 `Content-Encoding` | `200`；`Content-Type: video/mp4`；`Content-Length: 1114163`；未见 `Content-Encoding` |
| 页面 `fetch` 能读取的响应 | `200`，相同 MIME 与 `Content-Length: 188093`；`Response.redirected: false`，最终主机为 `assets.grok.com` | `200`，相同 MIME 与 `Content-Length: 1114163`；`Response.redirected: false`，最终主机为 `assets.grok.com` |
| 单次响应体 | 读到 EOF，累计 `188093` 字节 | 读到 EOF，累计 `1114163` 字节 |
| 远端摘要／验证器 | 网络层未见 `ETag`、`Content-MD5`、`Digest`、`Content-Digest`；页面也读不到这些值 | 同左 |
| 质量字段 | 详情无 `hdKey`、`hd1080Key` | 详情无 `hdKey`、`hd1080Key` |

两份详情中与 `hash`、`digest`、`checksum`、`etag` 名称匹配的根字段只有 `thumbhash`。它不是已证明的**所选媒体文件**加密摘要；不能拿来校验下载文件。响应头中未见 `Access-Control-Expose-Headers`，但两个 `Content-Length` 都可由页面 `Response.headers.get()` 读取；该头属于 Fetch 的 CORS 默认可读响应头。网络层值通过 Playwright `Response.allHeaders()` 读取，页面可读值与它分开记录。[当前 Grok Saved、详情与媒体端点](https://grok.com/imagine/saved)，2026-09-26 登录态只读观察；[Fetch 的 CORS 可读响应头定义](https://fetch.spec.whatwg.org/#cors-safelisted-response-header-name)；[Playwright `Response.allHeaders()`](https://playwright.dev/docs/api/class-response#response-all-headers)。

这次使用**完整 `200` 响应**，没有 Range 拼接，因此本次样本没有分块偏移或跨请求版本混合问题。详情 `sizeBytes`、实际响应 `Content-Length` 与 EOF 字节计数三者相等，支持判断本次收到的对象没有可观察的短读。`Content-Length` 是服务器声明的消息长度；它不能替代独立的远端内容摘要，也不能证明 URL 永久指向同一版本。没有保存完整媒体或计算新的本地 SHA-256；此前 demo 计算过本地 SHA-256，但它只标识已接收的本地字节，不能补出本次未见的远端摘要。[HTTP Content-Length 语义](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6)；[旧 demo 的本地摘要观察](2026-09-25-grok-playwright-extension-demo.md)。

## 对后续决策的边界

- 对这两个**实际选中**的基础媒体，页面可直接读取完整响应的总长度；读取到 EOF 后，可以要求字节计数与**该次所选响应**的 `Content-Length` 相等，并交叉检查详情根 `sizeBytes`。这是一条当前样本可用的完整性证据链，仍要先核对身份、状态、MIME 和异常页。
- 如果某次所选响应没有可读取且可信的总长度，也没有独立可信的远端文件摘要，EOF、正数计数和本地 SHA-256 只能说明本地接收了这些字节，不能确认所选媒体完整。是否拒绝发布属于「媒体传输方式与失败处理边界」的产品决定；本研究不提前批准判据。
- 本次所测视频没有 `hdKey` 或 `hd1080Key`，也没有请求任何高清地址。前次指定视频样本同样没有这两个字段；这些有限样本**不能证明高清文件不存在**。高清下载若被选中，必须以高清地址自身的实际响应长度或独立摘要核对；基础视频的 `sizeBytes` 不代表高清文件大小。[Post 身份与清晰度既有观察](post-identity-quality.md)。
- “未见远端摘要”只适用于本次两份详情和两次响应，不能作为 Grok 永不提供摘要或验证器的站点保证。即便将来观察到 `ETag`，其 HTTP 语义是表示版本验证器，不能仅因名称或外观把它当作文件内容 hash。[RFC 9110 的实体标签语义](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.8.3)。
- 两个媒体分别约 0.19 MB 和 1.11 MB。本次没有测试大视频、跨进程流式内存峰值、取消延迟、异常截断、内容编码变化或重定向后的响应。2026-09-26 用户已取消大视频和内存专项验收；其余普通媒体的完整性、取消与清理边界仍须按[一期规格](../specs/phase1-saving.md)验证，本次观察不能替代正式应用证据。[一期媒体传输研究](phase1-media-transfer.md)。
