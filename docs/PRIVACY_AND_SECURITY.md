<!-- markdownlint-configure-file {"MD013": false, "MD024": false} -->

# 隐私与安全

本文写给维护者，说明站点的隐私姿态、响应头策略与缓存规则，以及每一条规则**为什么**这样设置。

## 1. 隐私姿态

站点的大部分功能不收集任何个人数据。评论是唯一的例外，它单独在下文 1.7 完整说明：读者提交名称、邮箱与正文，站点只保存名称、正文与**邮箱的哈希**。

| 项目                                | 状态                                                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 分析统计                            | **没有**。站点不加载任何分析脚本，也不向任何第三方发送事件。                                         |
| Cookies                             | **没有**。站点不设置任何 cookie，也没有任何需要 cookie 的功能。                                      |
| 广告与营销脚本                      | **没有**。                                                                                           |
| 评论                                | **有**，默认开启，可按文章关闭。收集名称、邮箱与正文；邮箱只用于计算头像哈希，原文不保存。详见 1.7。 |
| 阅读量                              | **有**。按「访客 / 天」去重统计，用地址哈希识别访客，不存地址原文。详见 1.8。                        |
| 第三方请求                          | **没有**。头像经本站代理获取，第三方不会接触到读者。详见 1.7 与 1.9。                                |
| 社交 SDK、分享按钮脚本              | **没有**。分享使用浏览器原生的 Web Share API，不可用时退回复制链接。                                 |
| 远程字体                            | **没有**。使用系统字体栈，`font-src 'self'`，不产生任何字体请求。                                    |
| 登录与账户                          | **没有**。评论不需要注册，任何读者都能提交。                                                         |
| Newsletter、Webmention、ActivityPub | **没有**。                                                                                           |

### 1.1 主题偏好

明暗主题的**手动选择**存在浏览器本机的 `localStorage` 中，键名固定为 `nano-blog-theme`，取值只能是 `light` 或 `dark`。

- 它不上传、不同步、不建立任何身份标识，也不参与任何跨站识别。
- 没有手动选择时，站点完全跟随 `prefers-color-scheme`，且不写入任何存储。
- 用户可以选择「跟随系统」，此时存储中的手动值被清除。
- 存储被浏览器阻止时，读取失败被静默忽略，站点退回跟随系统——功能降级但阅读不受影响。

### 1.2 搜索

Pagefind 的索引是**构建期生成的静态文件**，随站点一起发布。搜索查询完全在浏览器本地执行，**不会发送到任何服务端**，也不会上报到任何地方。搜索功能不依赖任何网络请求（除了下载索引本身）。

### 1.3 第三方视频

YouTube 与 Bilibili 的嵌入**只有在用户明确点击「加载视频」之后**才创建 iframe。在此之前：

- 页面只显示本地托管的 poster、标题与提供方名称；
- 按钮旁明确说明「点击后将连接 <提供方>。在此之前不会向第三方发送任何请求。」；
- 不向第三方域发出任何请求。

第三方服务不可用时，页面保留一个指向提供方的普通链接，不会让它的失败阻断正文。

### 1.4 媒体与位置元数据

`media:add` 在上传前会清除 EXIF、GPS、相机序列号与缩略图等隐私元数据，只保留安全的颜色配置。

需要特别提醒的是：**媒体桶是公开可读的。对象一经上传即可通过公开 URL 访问，无论是否已经有文章引用它们。** 因此不要把未公开的敏感素材、私有草稿附件或任何 secret 放进媒体桶。`media:add --apply` 会在执行前打印这条警告。

### 1.5 Workers AI 的数据流

Workers AI **只**在作者手动执行 `content:seo --send` 时接收数据，命令会先显示将要发送的字段清单、字符数与接收方。

发送的内容包括：标题、现有 description、H1–H3 文本、标签，以及去除代码块、行内代码、图片与链接、URL 查询串与疑似 secret 之后、最多 6000 个 Unicode 字符的正文摘录。接收方是 Cloudflare Workers AI，模型固定为 `@cf/qwen/qwen3.8-27b`。

关键约束：

- 不带 `--send` 时**零网络请求**；
- **构建、预览、发布与 CI 永远不会调用 Workers AI**，代码中不存在构建时 AI fallback；
- 模型返回的内容只写入 `.ani-content/seo-suggestions/` 下的建议文件，**不会**自动改写 Markdown、frontmatter 或已发布内容。

### 1.6 为什么没有独立的隐私政策页面

站点不设置 cookie、不做分析、没有账户、没有登录，所以没有需要向读者披露的跨站识别行为。评论会收集数据，而它的说明放在**评论区旁边**、提交按钮之前——读者在提交的那一刻就能看到，而不是藏在一个需要主动寻找的页面里。这比单独一个政策页更有用。

footer 不显示任何不存在的隐私承诺链接。安全与数据流的完整技术说明写在本文里，读者是维护者。

### 1.7 评论的数据流

评论是站点唯一接受读者输入的功能，因此也是唯一需要披露的数据处理。

**提交时收集三项**：

| 字段 | 用途               | 是否保存                                    |
| ---- | ------------------ | ------------------------------------------- |
| 名称 | 显示在评论旁       | 保存                                        |
| 邮箱 | 仅用于计算头像哈希 | **不保存原文**，只保存 MD5 哈希             |
| 正文 | 显示评论           | 保存（Markdown 原文与渲染后的 HTML 各一份） |

邮箱哈希是 Gravatar 的寻址方式：`md5(trim(lowercase(email)))`。它是一个单向摘要，**不能还原出邮箱地址**，也只在 `/avatar/<hash>` 这个 URL 里出现。之所以不保存原文：除了算哈希，它在任何地方都不需要，而未保存的数据不会泄露。

**另外记录两项，均为哈希**：

- **地址哈希**：`HMAC-SHA-256(服务器密钥, 读者地址)`。仅用于限流与滥用处置。用服务器密钥参与运算，因此拿到数据库的人也无法通过枚举地址反查出读者是谁，换一个部署又是一组完全不同的值。**原文不保存。**
- **渲染后的 HTML**：在写入时生成一次。这样读路径不需要每次解析不可信 Markdown；同时它冻结了审核时看到的内容——一篇在某个渲染器下被批准的评论，不会在下一个渲染器下改变含义。

**保留期**：评论没有自动过期。被拒绝的评论仍然保留（状态为 `rejected`）以便追溯垃圾提交，但永远不会显示。维护者可以随时用 `comments:review` 或直接删行移除任何一条。

**限流怎么计数**：地址哈希同时是限流的键（评论 3 次 / 10 分钟、20 次 / 天，阅读量 60 次 / 10 分钟）。计数器是**先加再判**的——一次被拒绝的提交同样会占用额度。这是有意的：读一次计数再写一次计数的做法在并发下会让同一批请求都读到限流前的数字，等于限流不存在；而被拒绝的尝试不该能在同一个窗口里免费重试。计数器表按窗口整块清理，过期窗口的行会在下一次写入时顺带删除，不会无限增长。

**读者可以要求删除吗**：没有账户系统，所以无法验证「这条评论属于你」。读者只能通过页面上没有公布的联系方式提出，由维护者人工判断。

### 1.8 阅读量的计数方式

显示的数字是**按「访客 / 天」去重后的总和**，不是页面打开次数。

- 同一个人在一天内反复打开同一篇文章只计一次；
- 同一个人第二天再来，再计一次；
- 识别访客用的是与评论相同的地址哈希，**不存地址原文，也不设 cookie**。

**这个数字意味着什么，以及不意味着什么**，两条都说清楚：

- 它**低估**：不运行 JavaScript 的读者不会被计入，所以真实阅读量只会比它高。
- 它**高估或低估个体**：同一家庭或办公室共用一个出口地址会被合并为一次；同一个人换网络会被算作两人。

因此它是一个**参考值，不是分析数据**。站点不提供任何按文章、按时间、按来源的报表，也不记录读者读到哪里、停留多久。刷新页面不会让数字上涨——一个可被刷新键推高的数字没有意义。

### 1.9 头像为什么经本站代理

评论头像不直接指向 Gravatar，而是走本站的 `/avatar/<hash>`。

**原因是读者隐私**：加载一张第三方图片就是发出一次请求，而请求会带上读者的地址、User-Agent 和所在页面。直接引用 Gravatar 会让每个有评论的页面都把这个信息交给第三方，把站点其余部分的隐私姿态一次抹掉。经本站代理后，出站请求由 Cloudflare 边缘发出，Gravatar 看不到读者是谁。

**第二个原因是 CSP**：`img-src` 保持 `'self'`，不需要为头像放宽任何一个域名。现有测试「点击前零第三方请求」因此继续成立。

代理请求 Gravatar 时带 `d=404`，即「没有头像就返回 404」。这样才能区分「有头像」和「没有头像」——否则每个没有 Gravatar 账号的读者都会戴上同一张默认剪影。没有头像时（以及 Gravatar 超时或出错时），返回本站生成的几何图案，它由邮箱哈希推导，因此对同一个人始终是同一张。

**出站请求有配额上限。** 摘要是这个端点唯一的输入，所以任何人都可以每次都换一个合法但陌生的摘要，让每一次请求都变成一次对 Gravatar 的子请求——对上游和被计费的额度都是一次廉价的放大攻击。因此每个 isolate 有一个固定窗口预算（`functions/lib/outbound-budget.ts`，240 次/分钟），用完后直接返回本地生成的图案，不再外发。这个限制是**每 isolate** 的，不是全局的：它把单个 isolate 的放大倍数封顶，但不宣称全站总量有这个上界，文档里也这样写。

## 2. 安全响应头

`public/_headers` 是版本控制中的唯一模板，安全策略的核心内容如下。媒体域名在源码里故意是不可解析的 `https://media.example.invalid`；postbuild 会从 `PUBLIC_MEDIA_ORIGIN` 替换两处，并在生产与预览环境要求 HTTPS。产物中的 CSP 才是实际发送给浏览器的策略：

```text
/*
  Content-Security-Policy: default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' https://media.example.invalid data:; media-src 'self' https://media.example.invalid; font-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com https://player.bilibili.com; manifest-src 'none'; worker-src 'self'; upgrade-insecure-requests
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Permissions-Policy: accelerometer=(), autoplay=(), browsing-topics=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()
  Cross-Origin-Opener-Policy: same-origin
  Strict-Transport-Security: max-age=31536000; includeSubDomains
```

### 2.1 逐条说明

| 指令                                                                     | 为什么这样设置                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default-src 'self'`                                                     | 默认拒绝一切外部来源。任何新引入的外部资源都必须显式列进某一条指令，这使「偷偷加一个第三方脚本」变成一次显眼的改动。                                                                        |
| `base-uri 'self'`                                                        | 禁止注入 `<base>` 改写站内相对链接的解析目标。                                                                                                                                              |
| `object-src 'none'`                                                      | Flash 一类的插件嵌入已无用途，直接关闭。                                                                                                                                                    |
| `frame-ancestors 'none'`                                                 | 站点不允许被任何其它页面嵌入，杜绝点击劫持。                                                                                                                                                |
| `form-action 'self'`                                                     | 站点自己没有表单，也不允许任何注入的表单把数据发往外部。                                                                                                                                    |
| `script-src 'self' 'wasm-unsafe-eval'`                                   | **不允许内联脚本，也不允许任何外部脚本。**`'wasm-unsafe-eval'` 只为 Pagefind 的 WebAssembly 而加，见 2.2 与 2.4。                                                                           |
| `style-src 'self' 'unsafe-inline'`                                       | 构建产物的受信样式需要内联 `style` 属性，见 2.3。                                                                                                                                           |
| `img-src 'self' <PUBLIC_MEDIA_ORIGIN> data:`                             | 图片只能来自站点自身与配置的媒体域；`data:` 是给内联的小图标与占位用的。                                                                                                                    |
| `media-src 'self' <PUBLIC_MEDIA_ORIGIN>`                                 | 音频与视频文件只能来自站点自身与配置的媒体域。                                                                                                                                              |
| `font-src 'self'`                                                        | 站点不加载任何远程字体，因此只允许同源字体。                                                                                                                                                |
| `connect-src 'self'`                                                     | `fetch` / `XHR` / WebSocket 只能打回同源，杜绝把读者数据外发的脚本。                                                                                                                        |
| `frame-src https://www.youtube-nocookie.com https://player.bilibili.com` | 唯一允许的两个 iframe 来源，且只在用户点击后创建。YouTube 使用 `youtube-nocookie.com` 域以避开其跟踪 cookie。                                                                               |
| `manifest-src 'none'`                                                    | 站点不是 PWA，不需要 web app manifest。                                                                                                                                                     |
| `worker-src 'self'`                                                      | Pagefind 与 Mermaid 的本地 worker/打包代码需要，但仅限同源。                                                                                                                                |
| `upgrade-insecure-requests`                                              | 任何遗漏的 `http:` 子资源请求都被强制升级为 HTTPS。                                                                                                                                         |
| `Referrer-Policy: strict-origin-when-cross-origin`                       | 跨站跳转只发送来源 origin，不泄漏文章的完整路径与查询串。                                                                                                                                   |
| `X-Content-Type-Options: nosniff`                                        | 禁止浏览器猜测 MIME 类型，避免把非脚本内容当脚本执行。                                                                                                                                      |
| `X-Frame-Options: DENY`                                                  | 与 `frame-ancestors` 重复的一道老浏览器保险。                                                                                                                                               |
| `Permissions-Policy`                                                     | 显式关闭加速度计、自动播放、浏览主题（`browsing-topics`，取代已废弃的 `interest-cohort`）、摄像头、屏幕捕获、定位、陀螺仪、麦克风、支付与 USB。站点不使用其中任何一项，关闭它们是零成本的。 |
| `Cross-Origin-Opener-Policy: same-origin`                                | 隔离浏览上下文，阻断跨窗口引用带来的攻击面。                                                                                                                                                |
| `Strict-Transport-Security`                                              | 一年内强制 HTTPS 且覆盖子域。**注意**：这条只有在确认正式域名长期稳定、全站 HTTPS 可用之后才应生效；上线前请确认 `blog.example.invalid` 与 `media.example.invalid` 都已正确配置证书。       |

### 2.2 为什么 `script-src 'self'` 能成立

CSP 里没有 `unsafe-inline`、没有 `unsafe-eval`、没有宽泛域名、没有 `https:`、没有 `data:` 脚本、也没有 `*`。唯一的 `*-unsafe-*` 关键词是 `'wasm-unsafe-eval'`，它只允许**预编译的 WebAssembly**，不允许对字符串求值，理由见 2.4。`script-src` 能收紧到这个程度，是因为构建满足两个条件：

1. **`assetsInlineLimit: 0`。** Astro 默认会把足够小的组件脚本内联成 `<script>…</script>`，而内联脚本正是 `script-src 'self'` 所禁止的。把内联阈值设为 0 之后，每一个脚本都以同源文件的形式发布。
2. **必须在首屏之前运行的那一个脚本是外部文件。** 防主题闪烁的脚本位于 `/theme-init.js`，由 `<head>` 在样式表之前同步加载。它以同源文件的形式存在，因此不需要 `unsafe-inline`。

这个文件在页面绘制第一帧之前就把 `data-theme` 与 `color-scheme` 写到文档元素上，所以不会出现主题闪烁。它只在 `localStorage` 中存在明确选择时才设置属性；没有存储值时什么都不做，交给样式表的 `prefers-color-scheme` 规则决定。

### 2.3 为什么需要 `style-src 'unsafe-inline'`

`'unsafe-inline'` 只作用在 **style** 上，不作用在 script 上。需要它是因为：

- Shiki 在构建期把高亮结果写成一个带内联 `style` 属性的 `<pre>`（例如 `background-color:#24292e;color:#e1e4e8`）；
- Astro 自己也会在生成的标记上写受信的内联样式；
- 设计令牌以 CSS 自定义属性的形式注入。

这些样式全部由受信插件在构建期生成，不是作者输入。作者在 Markdown 里写的原始 HTML，其 `style` 属性会在构建期被清洗器整条剥掉——所以 `'unsafe-inline'` **不会**成为作者注入样式的通道。

### 2.4 为什么必须有 `'wasm-unsafe-eval'`

这一条是修复一个**已上线即失效**的功能时加的，值得写清楚，因为它看起来像一次 CSP 放宽，实际不是。

- 站内搜索由 Pagefind 提供，而 Pagefind 是 WebAssembly：构建产物里有 `/_pagefind/wasm.unknown.pagefind`，`pagefind.js` 与 `pagefind-worker.js` 都调用 `WebAssembly.instantiate`。
- 自 CSP3 起，`script-src` 里没有 `'wasm-unsafe-eval'`（或 `'unsafe-eval'`）时，浏览器会让 `WebAssembly.instantiate` 抛 `CompileError`。
- 原先 `/search/` 在真实部署上会返回"搜索暂时不可用"，当时本地验证服务器未应用 `_headers`，因此没有测到真实 CSP。现在验证服务器已修复。

`'wasm-unsafe-eval'` 与 `'unsafe-eval'` 是两个不同的关键词：前者只允许编译已经拿到的 WebAssembly 字节码，**不允许** `eval()` 字符串，因此它不打开动态代码执行的口子。`'unsafe-eval'` 依旧不在策略里，也不应该被加进来。

为了让这类"只有真实响应头才暴露"的故障以后能被本地抓到，`scripts/verify/static-server.ts`（`test:e2e` / `test:a11y` / `test:visual` 共用的静态服务器）会读取并应用**构建产物中的** `_headers`，包含真实媒体域名和 Preview noindex；`tests/unit/headers-file.test.ts` 固定解析语义。把 `'wasm-unsafe-eval'` 删掉，浏览器搜索用例就会失败。

### 2.4 预览环境

Preview 与本地构建会在**构建产物的** `_headers` 末尾追加：

```text
# Added by postbuild for a non-production environment.
/*
  X-Robots-Tag: noindex, nofollow
```

追加只发生在 `SITE_ENV` 不为 `production` 时（`preview`、`local` 或未设置）。**版本控制中的 `public/_headers` 永远不会被改写**，所以它在每个环境中都保持完全一致，Git 工作区也不会因为一次预览构建而变脏。

### 2.5 评论与阅读量如何适配这份 CSP（一行都没改）

评论需要一次同源 POST、一个脚本和一批头像，而上面的 CSP **一个指令都没有为此放宽**。这不是巧合，是选型时的约束：

| 需求                 | 依赖的现有指令       | 为什么够用                                       |
| -------------------- | -------------------- | ------------------------------------------------ |
| 提交评论、上报阅读量 | `connect-src 'self'` | 端点在本站同源，`fetch` 已经允许。               |
| 评论脚本、阅读量脚本 | `script-src 'self'`  | 都是本站打包的模块文件，没有内联脚本。           |
| 评论区表单直接提交   | `form-action 'self'` | 表单 `action` 指向站内。                         |
| 头像                 | `img-src 'self'`     | 经 `/avatar/<hash>` 代理，不引入 gravatar 域名。 |

Functions 层自己的响应不走 `public/_headers`（那份文件由 Pages 应用于静态资源），所以 `functions/api/_middleware.ts` 与 `functions/avatar/_middleware.ts` 各自补上安全头，并对该层输出施加更严的 `default-src 'none'`——JSON 与自包含的确认页不需要加载任何东西。

这两份中间件**刻意放在子目录里而不是 `functions/` 根目录**。根目录的中间件会拦在静态文件前面（Cloudflare 文档明确如此），于是在"`_headers` 是否已经应用到这个响应上"这个未定义的问题上做赌注：赌错的代价是每个 HTML 文档都被盖上 `default-src 'none'`，样式与脚本全部被拦、`/assets/*` 的缓存规则一并失效。收窄到 `/api/*` 与 `/avatar/*` 之后，文档根本不会经过这段代码，问题不再存在。共用逻辑在 `functions/lib/security-headers.ts`。

**唯一出站的第三方请求**是 `/avatar/<hash>` 向 Gravatar 获取头像，由边缘发出，读者不是请求方，地址也不随之外发。

## 3. 缓存规则

| 路径                                                                   | `Cache-Control`                         | 为什么                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/assets/*`                                                            | `public, max-age=31536000, immutable`   | 文件名带内容摘要，同一路径的字节永不改变。                                                                                                                                                         |
| `/assets/katex/*`                                                      | `public, max-age=3600, must-revalidate` | **唯一的例外。** KaTeX 的样式表与字体由构建脚本以不带摘要的名字复制，标成 immutable 会让升级 KaTeX 之后的老访客一年内继续用旧样式。规则先用 `! Cache-Control` 摘掉上一条，再设一个会重新校验的值。 |
| `/og/*`                                                                | `public, max-age=31536000, immutable`   | OG 卡片的文件名由输入内容的摘要派生，改了封面就会换名字，因此同样是不可变的。                                                                                                                      |
| `/_pagefind/*`                                                         | `public, max-age=3600, must-revalidate` | 搜索索引每次部署都会重建，但路径固定，所以不能长缓存。                                                                                                                                             |
| 目录式 URL（`/*/`）与 `/*.html`                                        | `public, max-age=0, must-revalidate`    | 陈旧的正文比一次请求更糟。**`/*/` 是真正生效的那条**：构建用 `format: "directory"` + `trailingSlash: "always"`，文章页的请求路径是 `/posts/x/`，永远不以 `.html` 结尾。                            |
| `/`、`/rss.xml`、`/sitemap-index.xml`、`/sitemap-0.xml`、`/robots.txt` | `public, max-age=0, must-revalidate`    | 同上；这些入口必须反映最近一次部署。                                                                                                                                                               |

`_headers` 的匹配对象是**请求路径**，不是最后落到磁盘上的文件——这正是上表里 `/*.html` 单独一条不够用的原因。

`/api/views/<postId>` 的 GET 在边缘缓存 60 秒（`caches.default`，键按请求 origin 构造，不随读者变化），与它自己声明的 `max-age=60` 一致；在此之前那头只是对中间层的承诺，Pages Functions 的响应并不会自动进入 CDN 缓存，于是每读一次都会在 D1 上做一次 `COUNT(*)`。`/api/comments/<postId>` 保持 `no-store`：作者随时可能批准一条评论，缓存会让读者看不到自己刚被批准的留言。`/avatar/<hash>` 命中上游时缓存 24 小时；回退生成的头像只缓存 1 小时，因为"这个地址当时没有 Gravatar"是会变的事实。

内容桶里不可变 release 对象的缓存策略是 `private, max-age=31536000, immutable`。媒体桶的缓存策略见 [CONTENT_PIPELINE.md](CONTENT_PIPELINE.md) 第 7 节。

## 4. 构建期的输入校验

Markdown / MDX 路径、URL、frontmatter 与媒体全部按**不可信数据**处理，进入严格校验：

- 内容路径拒绝绝对路径、`..`、反斜杠、NUL、大小写碰撞与保留目录名；
- frontmatter 使用 `.strict()` schema，未知键是错误；
- MDX 在构建前解析成真实 AST，拒绝 `import`/`export`、未知组件、`client:*` 指令、JavaScript 表达式、spread props 与事件处理器；
- 原始 HTML 经过白名单清洗，`style`、事件、任意 `class`/`id`/`data-*` 与危险协议全部剥除；
- R2 下载逐项校验内容与媒体的键前缀、字节上限、SHA-256、manifest 与 `meta.json`；媒体拉取另有每资产文件数、资产数和总字节预算。

需要说明的是：**这些校验防的是错误的输入与意外的注入，不是防范内容作者。** 作者仍然是唯一的写作者，站点不接收第三方提交。

## 5. 本项目不做的事

- 不在浏览器暴露 R2、Workers AI、Deploy Hook、D1 token 或任何其他 secret。评论端点只持有 D1 绑定与一个地址哈希密钥，二者都不发给客户端。
- 不在构建时调用 Workers AI、上传正文、自动改写文章或自动发布。
- 不添加 `unsafe-eval`，不放宽 CSP 域名，不用 `*` 或 `data:` 换取方便。`'wasm-unsafe-eval'` 是唯一的例外，且只允许预编译 WebAssembly（见 2.4）；它不等同于 `'unsafe-eval'`。
- 不通过忽略全部告警来获得绿色的漏洞扫描结果——依赖扫描的结果需要如实记录。
- 不设置 cookie，不做跨站跟踪，不读取 `Referer` 之外的浏览上下文，不记录读者的阅读进度或停留时间。
- 不保存邮箱原文、地址原文或任何可直接识别读者的字段。
