# Grok Post 媒体身份与清晰度：登录页面现场观察

观察日期：2026-09-26。先在用户现有登录 Chrome 中查看 Grok Saved 与 Post 页面；随后在用户明确授权下，通过已安装的 Playwright Extension 新建研究页，对用户指定的 Post 及页内关联图片读取第一方详情，并对已观察的媒体地址做有限的 HEAD／Range 核对。又从同一指定 Post 页面列出的公开第一方前端脚本及页面实际加载的脚本，静态追踪 Download 处理函数；再次连接只读取脚本名称和已知视频详情中高清字段的存在性。没有调用生成、Upscale、Download、删除或 Saved 状态修改，也没有保存完整私人媒体、Cookie、令牌、截图或原始响应。首轮样本以 A（图片）、B/C/D（三段视频）代称；后续用户样本以 E（视频）和 F（同页缩略图中的图片）代称。不记录私人 Post ID、媒体地址和提示词。

## 现场事实

| 问题 | 观察 | 证据边界 |
| --- | --- | --- |
| 单个 Post 的主体媒体 | A 的 `/imagine/post/<uuid>` 页面显示一张主体图片；B、C、D 各显示一段主体视频。A 的可见图片元素来自 `assets.grok.com`，`naturalWidth × naturalHeight` 为 784×1168。B、C 的播放器报告 464×688，媒体主机为 `assets.grok.com`。 | 这是四个页面的可见 UI，不是详情接口对所有媒体成员的枚举，也不能推出“每个 Post 必有且仅有一个媒体”的服务端保证。[Grok Saved 页面](https://grok.com/imagine/saved)与从其中打开的 Post 页面，2026-09-26 登录态观察。 |
| Post 路径身份 | 从 Saved 卡片打开 A、B、C、D 时，浏览器路径为 `/imagine/post/<uuid>`；不同卡片进入不同 Post 路径。B、C 刷新后仍留在原 Post 路径。 | 该轮页面观察尚未读取详情 `assetId`；后文仅对 E/F 补充了当前详情身份核对，仍没有证明路径 UUID 等同媒体二进制的永久身份。[Grok Saved 页面](https://grok.com/imagine/saved)与对应 Post 页面，2026-09-26。 |
| 页内关联媒体切换 | 用户提供的 E 页面显示一段 0:06 视频，主体旁有 5 个编号 `Thumbnail` 控件；第 5 个缩略图对应当前视频。点击同一组中的 `Thumbnail 1` 后，主体变为图片 F，路径仍为 `/imagine/post/<uuid>`，但路径 UUID 从 E 改为 F（`E == F` 为否），并出现 `conversation` 查询参数。再点击 `Thumbnail 5`，主体恢复为视频 E，路径 UUID 也恢复为最初的 E（`E == 返回后 UUID` 为是）；查询参数保留。 | 这是 Post 主体旁同组缩略图的切换，不是 `Previous post`／`Next post` 或左侧全局 Saved 导航。此处是最初 UI 观察；后文详情已进一步确认 E 的生成输入包含 F 的 UUID。这个样本仍不能证明所有衍生切换均改变 UUID，或 UUID 代表不可变字节。`conversation` 查询参数是导航上下文，不当作目标 Post 身份。[Grok Imagine Post 页面](https://grok.com/imagine)，2026-09-26；私人 URL 未收入报告。首轮 B/C/D 未见这组控件。 |
| 当前视频与增强入口 | B、C 的可见视频为 464×688。B 的 `Upscale` 菜单显示 `Upscale to 720p`；页面另有独立 `Download` 按钮，未见已有 720p 文件的选择器。 | `Upscale to 720p` 是要求执行增强的菜单动作，不是可直接下载的既有版本证据；本次没有点击。本行是先前 UI 观察，后文补充了 E/F 当前详情中的现成地址核对。[Grok 视频 Post 页面](https://grok.com/imagine/saved)，2026-09-26。 |
| 媒体地址与版本 | C 在一次只读刷新前后，浏览器视频元素的 `currentSrc` 均为 `assets.grok.com` 的 MP4，播放器尺寸均为 464×688；URL 的中间路径段不同，末尾文件名和 `cache` 查询参数相同。 | 只可说页面选用的地址发生变化；没有比较字节或服务端版本元数据，不能推断内容是否变化，也不能将 URL 或详情 `key` 当作稳定版本 ID。[Grok 视频 Post 页面](https://grok.com/imagine/saved)，2026-09-26。 |

## 当前详情响应与身份关系

经用户明确授权，在现有登录 Chrome 的 Playwright Extension 会话中，自建研究页仅访问其指定视频 Post（下称 V）及页内 `Thumbnail 1` 对应的图片 Post（下称 I）。两页导航和同源 `GET /rest/assets/<各自路径 UUID>` 均返回 HTTP 200；详情为 `application/json` **根对象**，没有 `asset` 或 `assetDetail` 包装。两份详情的 `assetId` 分别与各自请求和页面路径 UUID 精确相等，V 与 I 的 ID 及根 `key` 均不同。V 的 `mediaGenInput.imageToVideo.inputAssets` 是长度为 1 的字符串数组；唯一字符串**等于 I 的 Post UUID**，不等于 I 的媒体 `key`。这证明这对样本存在输入关联，同时证明页内缩略图组不能整体归为 V 的本体媒体。[当前 Grok Post 与同源详情](https://grok.com/imagine)，2026-09-26 登录态只读观察；私人路径、原始响应和 key 均未保存。

| 当前响应 | V：视频 | I：图片 |
| --- | --- | --- |
| 根直接媒体 | `mimeType: video/mp4`；`sizeBytes: 1114163`；`key` 位于 `assets.grok.com`；`width × height: 448×672` | `mimeType: image/jpeg`；`sizeBytes: 176701`；`key` 位于 `assets.grok.com`；`width × height: 768×1152` |
| 辅助成员 | `previewImageKey`；`auxKeys` 含 `preview-image`、`image_references`、`thumbhash` 等键 | `previewImageKey`；`auxKeys` 含 `original-image`、`thumbhash` 等键 |
| 生成输入与状态 | `mediaGenInput.imageToVideo.resolutionName: "480p"`；`inputAssets[0] == I.assetId`；有 `updateTime`、`isLatest: true` | `mediaGenInput.textToImage` 存在；有 `updateTime`、`isLatest: true` |

这是两份详情**实际出现**的字段，而非从旧解析器推断的 schema。每份样本各有一个根直接媒体 `key`；`previewImageKey`、`auxKeys` 和生成输入在不同字段位置。没有观察到本体媒体数组，但两个样本不能证明所有 Post 都只能有一个本体媒体。仅凭字段名也不能把 `original-image` 认定为额外的本体媒体或最高版本。[当前 Grok Post 同源详情](https://grok.com/imagine)，2026-09-26。

## 现有清晰度与下载选择

V 的 `resolutionName: "480p"` 位于**生成输入**，不能把它当作可下载候选列表；当前详情根媒体与播放器报告 448×672。先前 B 视频菜单的 `Upscale to 720p` 是执行增强的入口，不是已经存在的 720p 文件。V 当前详情没有出现明确的现成视频质量候选数组或已生成 720p 媒体字段。播放器 `currentSrc` 与根 `key` 的 URL 字符串不同；两者 `HEAD` 都返回 HTTP 200、`video/mp4`、`Content-Length: 1114163`。未比较字节，不能推断它们内容相同或不同，更不能以 URL 差异当作版本变化。[Grok 视频 Post、同源详情和媒体 `HEAD`](https://grok.com/imagine)，2026-09-26。

I 的 `auxKeys["original-image"]` 是与根 `key` 不同、当前可访问的 `assets.grok.com` 地址。两者 `HEAD` 均返回 HTTP 200、`image/jpeg`；根 `key` 长 176701 字节，`original-image` 长 162110 字节。分别只读首 64 KiB 的 `Range` 均返回 HTTP 206；JPEG 头均声明 **768×1152**。两地址是不同表示，但相同像素尺寸、字段名与文件大小都不能证明哪一个画质更高，也不能确定 `original-image` 的产品语义。[Grok 图片 Post、同源详情和媒体 `HEAD`／`Range`](https://grok.com/imagine)，2026-09-26。没有保存完整图片。

可见 `Download` 控件是没有 `href` 或 `download` 属性的 `button`。没有点击它，也未观察实际下载请求；下节的当前前端源码补足了按钮处理函数的**静态选择规则**。V 同一会话连续读取两次详情，`assetId`、`mimeType`、`sizeBytes`、`key`、`updateTime` 相等；先前 C 视频刷新后 `currentSrc` 中间路径段变化、播放尺寸不变。这些短时观察不能证明任何字段或 URL 是不可变媒体版本标识。[Grok Post 页面与同源详情](https://grok.com/imagine)，2026-09-26。

## 当前前端 Download 选择链

2026-09-26 指定 Post HTTP 200 页面在登录 Chrome 实际加载了 `2kp9zcawjv21z.js`；公开 CDN 上同名脚本的 SHA-256 为 `440773d7fe4e68b1bc1c157df912bfc278aa38b00476091e8f50b67348d0677a`。另一个当前加载的脚本 `2yg8q0b4qxddd.js` 的 SHA-256 为 `a495ff533caf52929a804ff6a269ee328e4385f23dbf0158a0b20d1866a0db40`。以下偏移均是下载后 UTF-8 解码的**字符偏移**，用于在单行压缩脚本中复核；脚本可能随部署改变。[Post 页面组件脚本](https://cdn.grok.com/_next/static/chunks/2kp9zcawjv21z.js)、[媒体详情映射脚本](https://cdn.grok.com/_next/static/chunks/2yg8q0b4qxddd.js)。

详情适配器 `eo`（映射脚本约字符 162327）把根 `key` 优先映为 `mediaUrl`，仅在 `key` 为空时才取 `previewImageKey`／`auxKeys["preview-image"]`；同时把 `hdKey`、`hd1080Key` 分别映为 `hdMediaUrl`、`hd1080MediaUrl`。它没有读取 `auxKeys["original-image"]`。Post 图片分支的 `cv`（组件脚本约字符 229530）取当前图片 `mediaUrl`，不足时才取缩略图或 Post 回退地址。对本次 I 已观察到的非空根 `key`，这条静态路径会选根 `key`，而非 `original-image`；这是**网页 Download 的选择**，不构成二者 JPEG 压缩质量的客观排名。[媒体详情映射脚本](https://cdn.grok.com/_next/static/chunks/2yg8q0b4qxddd.js)、[Post 页面组件脚本](https://cdn.grok.com/_next/static/chunks/2kp9zcawjv21z.js)。

组件的 `Download` 按钮 `onClick` 接到 `uO`（约字符 282639），即 `nB`（约字符 255849）。视频质量状态初始为 `null`（约字符 198964）。未显式选质量时，处理函数依次取已存在的 `hd1080MediaUrl`、`hdMediaUrl`、基础 `mediaUrl`；显式选 `1080p`／`720p`／`original` 时，先取对应地址，地址为空才回退到基础 `mediaUrl`。这里视频的 `original` 选项指基础视频地址，**与图片辅助键 `original-image` 无关**。若当前选中带音乐或字幕的衍生版本，函数先使用那个变体的地址；因此上述优先级适用于未选择这类变体的常规视频。按钮以当前显示媒体的状态决定图片或视频分支，源码追踪没有模拟点击。本次 V 再次只读 `GET /rest/assets/<路径 ID>` 得到 HTTP 200、匹配 `assetId`，根对象中 `hdKey` 与 `hd1080Key` **均不存在**；因此该样本没有这两个已存高清地址的证据。[Post 页面组件脚本](https://cdn.grok.com/_next/static/chunks/2kp9zcawjv21z.js)、[指定 Post 同源详情](https://grok.com/imagine)，2026-09-26。

`nB` 对选定地址做资产 URL 转换并添加 `dl=1`，然后调用 `downloadImage(url, filename, false)`；`downloadImage`（`0gk6dl14baw2a.js` 约字符 55530，SHA-256 `5330c1fb55d190d7f33effc96af6803a4f51046910ae2bac93ba6c3ff869017f`）用该 URL 读取 Blob 并触发本地下载，失败时尝试在新标签打开**同一 URL**，没有再选另一质量。这个 helper 的错误回退属于网页交互，不是本项目“已知最高地址失败可降级”的依据。[Post 页面组件脚本](https://cdn.grok.com/_next/static/chunks/2kp9zcawjv21z.js)、[下载 helper 脚本](https://cdn.grok.com/_next/static/chunks/0gk6dl14baw2a.js)。

## 解析候选与验收阻断

对当前已观察形状，可将纯路径 UUID 作为**目标 Post 身份**：请求同一 ID 的详情，要求根 `assetId` 精确匹配，只在根 `mimeType`、正整数 `sizeBytes` 与受限 HTTPS 主机上的根 `key` 形成直接媒体候选。将 `previewImageKey`、`auxKeys`、`mediaGenInput.imageToVideo.inputAssets` 先按辅助／关联字段处理，不把 I 加入 V 的本体媒体集合；未知包装或无法判定的本体媒体结构应报告协议不匹配，而不是静默只取首项。这是两份样本支持的**解析候选**，不是 Grok 服务端保证。

“最高现有清晰度”仍有明确边界：I 的根 `key` 和 `original-image` 均为现存同尺寸 JPEG；网页 Download 选根 `key`，但两者的质量顺序未证实。V 的网页默认 Download 按 `hd1080Key` → `hdKey` → 根 `key` 对**存在的字段**选址；本次 V 没有两个高清字段，因此只有基础候选获得现场确认。该代码不能证明所有可能的高清字段都可访问或字节有效，也不能证明 Grok 给出了所有画质版本。不能从 `original-image` 名称、字节数、URL 形状或生成输入 `resolutionName` 猜排名。用户已确认：**已知最高候选下载失败时不降级**。若无法确定候选的质量顺序，“报告协议歧义并停止该 Post”仍是待后续讨论确认的建议；客观保证最高现有版本还需要先确定图片同尺寸表示的权威选择规则。按本次已观察详情与网页常规默认分支，根 `key` 是 I 的网页下载地址，也是 V 在两个高清字段缺席时的基础地址；这不能证明它们是客观最高画质。真实内容版本变更未自然出现；复用或新增版本行为仍需用受控响应验收，不能宣称 `assetId`、`key`、`updateTime` 的永久版本语义。

高清下载尚需两类验收：用受控详情响应覆盖 `hd1080Key`、`hdKey`、根 `key` 同时存在及分别缺席时的优先级，并验证已知最高地址传输失败后不会改取较低版本；再用实际已存在高清字段的 Post 核对详情元数据、可访问性和完整传输。当前 V 不是高清字段样本，不能用它宣称真实高清下载已验证。

首轮临时连接曾在新建研究页得到 HTML 403，用户重新批准后同一 Post 的页面及详情得到上述 HTTP 200 JSON。因此早先 403 仅证明当次访问失败，不能推断账号失效或接口消失。各次自建研究页已在脚本结束时关闭并断开连接；扩展连接页受到浏览器安全限制，没有读取或操作。若 Chrome 中仍留有本次连接页，须由用户自行处理。[Playwright Extension 官方说明](https://github.com/microsoft/playwright/blob/v1.63.0/packages/extension/README.md#usage)解释手动批准与标签组范围。
