# 一期 Post 身份与媒体解析：协议证据

研究复核日期：2026-09-26；所用现场观察发生于 2026-08-17 和 2026-09-25。研究范围是只读核对历史源码、脱敏观察和一次性演示；本报告没有重新访问 Grok，也没有执行 DELETE。Grok 的 `/rest/assets` 是观察到的内部接口，本文记录的形状不构成服务端稳定承诺。当前项目以 [产品目标](../specs/product-goals.md)、[架构](../../ARCHITECTURE.md)和[实现路线图](../development/implementation-roadmap.md)为约束；旧项目的术语、解析器与状态模型都只是证据或候选方案。唯一列表入口是 `https://grok.com/imagine/saved`，历史资料中的 History / All 是对此入口的旧称，并非第二个来源。

## 可核实的观察

| 主题 | 证据与适用范围 |
| --- | --- |
| Saved 第一页 | 2026-09-25 一次性 TypeScript demo 在登录 Chrome 中打开 `/imagine/saved`，请求 `GET /rest/assets?pageSize=40&orderBy=ORDER_BY_CREATE_TIME&workspaceKind=WORKSPACE_KIND_IMAGINE_ALL`，得到 HTTP 200、`assets` 数组 40 条和 `nextPageToken`。[原始 demo](evidence/grok-playwright-extension-demo.ts)及[观察记录](2026-09-25-grok-playwright-extension-demo.md)。2026-08-17 的另一次只读捕获记录了 `assets`、`assetId`、`mimeType`、`key`，跨 24 页计 946 个唯一 ID、203 个 `image/png` 和 743 个 `video/mp4`；它不是当前第一页的类型分布，也不证明每条 Post 的完整媒体数。见[脱敏捕获](../../../grok-image-saver/docs/research/evidence/grok-contract-validation-2026-08-17.json)与[捕获工具](../../../grok-image-saver/tools/grok-saved-contract-capture.user.js)。 |
| 指定 Post 身份 | 旧 demo 取列表项的 UUID 格式 `assetId`，打开 `/imagine/post/<assetId>`，再请求 `/rest/assets/<assetId>`；只有解析出的详情 `assetId` 与请求 ID 完全一致才继续。它能证明当次样本的绑定路径，不证明所有详情响应都有同一结构。见[原始 demo](evidence/grok-playwright-extension-demo.ts)。旧项目文档将页面 query 中的 `conversation` 视为上下文，不作为当前 Post 身份；见[历史 HTTP 参考](core-archive-model-and-http.md)。 |
| 直接媒体 | 旧 demo 对一个匹配身份的详情只读取 `key`、`mimeType`（兼容 `mediaType`）和正整数 `sizeBytes`，限定 `assets.grok.com`／`videos.grok.com` 的 HTTPS 地址，获得一张 JPEG（188093 字节）和一个 MP4（1634239 字节）。完整下载及本地复核是这两个样本的事实，不能外推为任意 Post 的完整媒体集合。见 [`demo.ts:13-27`](evidence/grok-playwright-extension-demo.ts)、[69-82](evidence/grok-playwright-extension-demo.ts)、[90-143](evidence/grok-playwright-extension-demo.ts) 与[观察记录第 25–36 行](2026-09-25-grok-playwright-extension-demo.md)。 |
| 关联内容 | 2026-08-17 的脱敏捕获记录 `sourceConversationId`／`rootAssetSourceConversationId` 在 946 个 asset 中出现 771 次，并在部分 conversation 响应中发现 28 个不在扁平列表中的额外 artifact；conversation 查询中有 743 次 HTTP 404，故调查本身没有覆盖完整关联图。旧项目的关联展开器从 `fileAttachmentAssetMetadata` 和 `mediaGenInput.imageToVideo.inputAssets` 建关系，属于另一个遍历路径，不能据此将关联 artifact 算入当前 Post。见 [捕获摘要第 23–50 行](../../../grok-image-saver/docs/research/evidence/grok-contract-validation-2026-08-17.json) 与 [旧关联解析器第 388–455 行](../../../grok-image-saver/packages/extension/src/relationship-expansion.ts)。 |
| 访问与错误 | 2026-08-17 登录 Chrome 内的图片、视频单字节 `Range` 均返回 206、可读 1 字节；匿名请求返回 403。2026-09-25 完整下载样本也得到可读 206，但页面脚本读取不到某些 `Content-Range` 头。见 [8 月脱敏证据](../../../grok-image-saver/docs/research/evidence/grok-contract-validation-2026-08-17.json) 与 [9 月 demo](2026-09-25-grok-playwright-extension-demo.md)。旧[解析器](../../../grok-image-saver/packages/extension/src/saved-discovery.ts)把 429、401／403／407、408／5xx、非 JSON／结构不符分为不同结果；这是历史产品代码的分类，不是当前服务端错误矩阵。单个媒体 403 不足以证明整个账号认证失效。 |

## 身份、媒体集合与版本的证据边界

**事实。** 历史 `assets` 列表行和详情演示都出现 `assetId`、`mimeType`、`key`、`sizeBytes`。旧实现另外解析 `previewImageKey`、`auxKeys`、`rootAssetId`、`responseId`、`updateTime`、`isLatest` 等字段；该解析器说明历史代码预期过这些字段，不证明当前线上仍返回，也不证明每个字段的业务语义。见 [`saved-discovery.ts:240-266`](../../../grok-image-saver/packages/extension/src/saved-discovery.ts) 和 [287–383](../../../grok-image-saver/packages/extension/src/saved-discovery.ts)。旧合成 fixture 有 `entries[].asset` 与 `assetDetail` 的另一形状，其文件是 synthetic，不能算一次现场观察；见 [`input-page-1.json`](../../../grok-image-saver/fixtures/discovery/saved-list-cursor-multipath-v2/input-page-1.json)、[`input-detail-1.json`](../../../grok-image-saver/fixtures/discovery/saved-list-cursor-multipath-v2/input-detail-1.json)。

**推断。** 在已观察到的单媒体样本中，URL 路径 ID、详情 `assetId` 和详情 `key` 足以形成“目标 Post → 一个直接媒体地址”的候选绑定。详情 `key` 可提供一次下载使用的精确地址，但没有现场证据证明它稳定标识内容版本、同一个 Post 是否可以返回多个完整媒体、key 或 URL 变化是否等于媒体版本变化，或同 key 是否始终返回同样字节。旧项目用“Selected Variant”描述其产品选择；这是设计概念，不能直接等同 Grok 协议字段，见[历史 HTTP 参考](core-archive-model-and-http.md)。

官方 [xAI Imagine 开发者文档](https://docs.x.ai/developers/model-capabilities/imagine/files/outputs)描述使用 API key 生成并存储新输出的开发者 API；它没有给 Grok 网页 Saved `/rest/assets` 响应提供字段或稳定性保证。本文的网页协议结论只来自上述历史观察。

**建议供讨论票决定。** 一期解析时将 URL／请求 ID、详情 ID、媒体成员与内容地址分开建模。对已证明的单一直接媒体形状，可要求精确 ID 匹配、支持的 MIME、正整数声明大小、受限 HTTPS 媒体主机；将 `previewImageKey` 和 `auxKeys` 视为旁证，不据字段名自动升级为需归档的完整媒体。若详情给出多个候选媒体或候选 key，必须先确定“当前 Post 自身完整集合”及每个版本的明确选择规则，不能只取首个或以体积猜质量。列表非 200、HTML 登录挑战、JSON 解析失败、详情身份冲突、媒体访问错误都不能解释为无媒体或已完成。

## 脱敏最小形状

以下是两次旧观察可供当前现场核对的**形状假设**，不是当前协议 schema；占位符不是线上值。完整 content key、私人标题、prompt、conversation ID、原始响应正文均不应进入报告。

```json
{
  "list": {"assets": [{"assetId": "<uuid>", "mimeType": "image/jpeg | video/mp4", "key": "<redacted content key>", "sizeBytes": 1}], "nextPageToken": "<redacted optional>"},
  "detail": {"assetDetail | asset | root": {"assetId": "<same uuid>", "mimeType": "image/jpeg | video/mp4", "key": "<redacted content key>", "sizeBytes": 1}}
}
```

`detail` 的包装方式来自 demo 的兼容式读取表达式，不代表三种形状都在当次现场出现。示例中的 `image/jpeg | video/mp4` 只表示旧 demo 下载过的两个 MIME；8 月列表另见 `image/png`。`sizeBytes: 1` 仅表示正整数条件。

## 当前现场需要补的最小验证

1. 在登录 Chrome 中只读请求当前 Saved 列表第一页，记录日期、HTTP 状态、content type、顶层字段名、列表项结构名、第一页条数、媒体 MIME 计数；只保留匿名形状和计数。确认 Saved 页面与这个请求实际对应；`WORKSPACE_KIND_IMAGINE_ALL` 只是待核对的历史参数。
2. 对可识别的单图片、单视频、疑似多媒体／关联媒体各选一个安全样本，只读请求指定详情。记录请求 ID 与详情 ID 是否相同、详情包装方式、直接媒体条目数量及字段名、预览／辅助／关联字段的相对位置。若找不到多媒体样本，明确记为“未覆盖”，不能写成单媒体保证。
3. 对同一 Post 两次只读详情（必要时跨一次页面刷新），比较 ID、MIME、`key` 的**相等性布尔值**、声明大小、可能的 `updateTime`／`isLatest`，不记录 key。若没有实际变更样本，版本语义仍未证实；实现验收须把“同 ID 但 key 或元数据改变”作为受控响应测试。
4. 仅对已确认可下载的图片和视频样本记录媒体请求状态、content type、声明大小与实际长度是否一致；如遇 401／403、429、HTML 挑战、无效 JSON、详情 404 或媒体 404，记录脱敏状态和阶段。不要故意制造账号限制，也不要以未遇见的错误为“已验证”。

本轮没有发起浏览器现场请求；线上形状仍停留在上述历史观察。这不表示当前 Chrome 登录失效，也不表示正式连接方案不可行。

**交付阻断条件。** 在一期实现读取和下载前，必须有本项目正式连接路径下的至少一张图片和一个视频的身份与直接媒体字段核对；在声称“完整保存当前 Post 自身媒体”前，必须证明所选响应形状能枚举完整本体媒体集合，或将无法判定的形状明确拒绝并在验收范围中说明。版本变更没有自然样本时，用受控响应验证停止、复用和新增版本行为，但不能宣称真实服务端版本机制已验证。
