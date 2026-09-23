<!-- markdownlint-configure-file {"MD013": false, "MD024": false} -->

# Cloudflare 配置指南

本文是给**维护者**的操作清单：需要在 Cloudflare 控制台（或 `wrangler`）里亲手完成的十二步配置。

## 请先读这一段

- **本仓库从不执行任何云端写操作。** 代码里没有调用 Cloudflare 管理 API 的部分，也不会创建或删除 Pages 项目、R2 桶、域名、DNS 记录、API Token 或 Deploy Hook。
- **这些步骤全部需要你手动完成**，而且**从来没有被执行过**——这份文档描述的是「应该怎么做」，不是「已经做了什么」。
- 站点页面全部在构建期生成，浏览器运行时不读取私有 R2、不调用 Cloudflare 管理 API。
- **评论与阅读量需要 Pages Functions 与一个 D1 数据库**（第 11 步）。除这两项之外没有别的运行时：没有 R2 runtime binding，没有其他 Worker，没有管理 API 调用。
- 所有命令默认 dry-run；只有在**当次明确授权**之后才允许执行带 `--apply` 的命令。

> [!NOTE]
> 本文里的 `blog.example.invalid` 与 `media.example.invalid` 是**占位域名**，`.invalid` 是保留后缀、永不解析，因此照抄不会指向任何真实站点。请把每一处换成你自己的域名；`blog.` 与 `media.` 只是本文示例使用的两个子域习惯。

开始之前请准备好：一个 Cloudflare 账户、一个指向你自己的域名的区域（zone），以及本仓库的一份本地克隆。

## 第 1 步：创建两个 R2 桶

在 R2 中创建两个职责严格分离的桶：

| 桶名                | 公开性           | 用途                                        |
| ------------------- | ---------------- | ------------------------------------------- |
| `nano-blog-content` | **私有**         | 不可变内容 release、manifest、`active.json` |
| `nano-blog-media`   | 通过自定义域公开 | 已去敏并生成响应式版本的图片、音频与附件    |

要点：

- 内容桶**绝对不要**开启公共访问，也不要绑定任何自定义域。它只通过 S3 兼容 API 和最小权限凭据访问。
- 两个桶的默认位置可以留空（自动），本项目的键布局不依赖区域。
- 桶名可以在 `.env` 里用 `R2_CONTENT_BUCKET` 与 `R2_MEDIA_BUCKET` 覆盖；如果你改了名字，记得同步修改 Pages 的环境变量。

## 第 2 步：为媒体桶绑定 `media.example.invalid`

1. 在媒体桶的 **Settings → Custom Domains** 中添加 `media.example.invalid`。
2. 确认该域名的 DNS 记录由 Cloudflare 自动创建并处于已代理状态。
3. 确认自定义域提供**只读公共访问**：匿名 GET 应当返回对象，PUT / DELETE 一律拒绝。
4. 确认对象返回正确的 `Content-Type`（由 `media:add` 在上传时设置）。
5. 缓存方面：散列媒体与派生图带 `Cache-Control: public, max-age=31536000, immutable`，`meta.json` 带 `public, max-age=86400, must-revalidate`。这些响应头由上传命令写在对象上，控制台侧不需要额外规则；如需在边缘再加一层缓存规则，请保持同样的语义，**不要**把 `meta.json` 变成 immutable。

验证方式：随便取一个已上传的对象，匿名访问 `https://media.example.invalid/media/<64 位摘要>/1600.webp`，应当返回图片而不是 403。

## 第 3 步：创建三组最小权限 R2 凭据

在 R2 的 **Manage R2 API Tokens** 中创建三组凭据，严格按下面的权限划分，不要合并成一组。

### 3.1 Pages 构建凭据（只读）

| 项       | 值                                                      |
| -------- | ------------------------------------------------------- |
| 权限     | Object Read only（List + Get）                          |
| 范围     | `nano-blog-content` 与 `nano-blog-media`                |
| 环境变量 | `R2_BUILD_ACCESS_KEY_ID` / `R2_BUILD_SECRET_ACCESS_KEY` |
| 使用位置 | **仅** Cloudflare Pages 的构建环境                      |

**可以**：列出并读取内容桶与媒体桶中的对象。`build:pages` 会下载并校验 active release，以及该 release 引用的每个 `meta.json`、original 和响应式派生文件。
**不可以**：写入或删除任何对象，也不可以管理桶。

### 3.2 作者凭据（对象读写）

| 项       | 值                                                        |
| -------- | --------------------------------------------------------- |
| 权限     | Object Read & Write                                       |
| 范围     | `nano-blog-content` 与 `nano-blog-media`                  |
| 环境变量 | `R2_AUTHOR_ACCESS_KEY_ID` / `R2_AUTHOR_SECRET_ACCESS_KEY` |
| 使用位置 | **仅**作者本地                                            |

**可以**：列出、读取、写入两个桶中所需的对象。
**不可以**：管理桶、DNS、Pages 项目或 API Token。

> [!CAUTION]
> Cloudflare 的 R2 S3 token UI 没有「可 Put、不可 Delete」这一档；`Object Read & Write` 应按**具备对象删除能力**对待。项目代码只有 `content:cleanup --apply` 会调用删除，但这不是 IAM 保证。作者 key 必须和密码一样保管、限制到这两个桶，并定期轮换。

### 3.3 清理凭据（删除）

| 项       | 值                                                          |
| -------- | ----------------------------------------------------------- |
| 权限     | Object Read & Write（含删除）                               |
| 范围     | 仅这两个指定桶                                              |
| 环境变量 | `R2_CLEANUP_ACCESS_KEY_ID` / `R2_CLEANUP_SECRET_ACCESS_KEY` |
| 使用位置 | **仅** `content:cleanup --apply` 的进程中读取               |

**可以**：删除两个桶中的对象，以及规划删除所必需的读取。
**不可以**：用于任何其他命令。`content:cleanup` 的 dry-run 阶段用的是作者凭据，不是这组。它和作者 key 在 Cloudflare 平台上的权限等级相同；单独创建的价值是职责隔离、审计和独立吊销，而不是声称作者 key 技术上无法删除。

### 3.4 另外两个 secret

| 变量                       | 权限范围              | 使用位置                                       |
| -------------------------- | --------------------- | ---------------------------------------------- |
| `CF_WORKERS_AI_API_TOKEN`  | **仅** Workers AI Run | 作者本地，只在 `content:seo --send` 时         |
| `CF_PAGES_DEPLOY_HOOK_URL` | ——                    | 作者本地，只在真正要触发部署时。**按密码处理** |

把这三组凭据与两个 secret 填进本地的 `.env`（从 `.env.example` 复制）。仓库中任何文件都不含真实凭据；`.env` 与所有 `.env.*` 文件都被 `.gitignore` 覆盖。日志与命令输出中这些值一律遮蔽。

## 第 4 步：建立 Pages Git 项目

1. 在 **Workers & Pages** 中创建一个 Pages 项目，连接到存放本仓库的 Git 仓库。
2. **Production branch 固定为 `main`。**
3. 仓库中的 `functions/` 会随 Pages 部署自动形成 Pages Functions；不要另建独立 Worker，也不要配置 R2 runtime binding。
4. 初次连接 Git 时，Pages 可能立即构建。远端还没有 `active.json` 时，这一次构建**应当失败**；先继续完成 Deploy Hook 和首次发布，不要把它误判为仓库构建故障。

## 第 5 步：配置构建环境

在项目的构建配置中设置：

| 项        | 值                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------- |
| Node 版本 | `24`（与仓库 `.node-version` = `24.16.0`、`package.json` 的 `engines.node` = `>=24 <25` 一致） |
| pnpm 版本 | `12.4.1`（与 `packageManager` 一致）                                                           |
| 构建命令  | `pnpm build:pages`                                                                             |
| 输出目录  | `dist`                                                                                         |

`pnpm build:pages` 会强制使用 `r2` 内容源：先用只读凭据拉取并逐项校验 active release 的内容和媒体，原子生成 `runtime/content`、`runtime/media` 与 `runtime/media-index.json`，再构建、生成 Pagefind 索引并执行产物与非 fixture 检查。在线拉取失败即终止，**不会**回退到缓存或空内容。

## 第 6 步：配置 `SITE_ENV`

为两个环境分别设置，值必须精确：

| 环境       | 变量       | 值           |
| ---------- | ---------- | ------------ |
| Production | `SITE_ENV` | `production` |
| Preview    | `SITE_ENV` | `preview`    |

行为差异：

- `production`：允许索引；`SITE_URL` 和 `PUBLIC_MEDIA_ORIGIN` 都必须是显式 HTTPS origin，不能带凭据、路径、query 或 fragment。
- `preview`：强制 noindex。构建后的步骤会往**构建目录**中的 `_headers` 追加一条 `X-Robots-Tag: noindex, nofollow`；版本控制中的 `public/_headers` 永远不会被改写。
- 未知值或缺失值会让 `build:pages` 直接失败——这是刻意的，环境判断不能靠猜。

同时请设置这两个非敏感变量（两个环境都需要）：

| 变量                  | 值                              |
| --------------------- | ------------------------------- |
| `SITE_URL`            | 你的公开域名                    |
| `PUBLIC_MEDIA_ORIGIN` | `https://media.example.invalid` |
| `SITE_TIME_ZONE`      | `Asia/Taipei`                   |

表中域名是这份自用配置的示例，不是代码里的硬编码门禁；迁移域名时同时修改两个环境的变量和 Cloudflare 自定义域即可。Cloudflare 内置的 `CF_PAGES_*` 变量只用于报告，**不替代** canonical 与环境判定。

## 第 7 步：设置 R2 只读构建 secret

把第 3.1 步的凭据填进 Pages 的构建环境变量：

- `R2_ACCOUNT_ID`
- `R2_CONTENT_BUCKET`（`nano-blog-content`）
- `R2_MEDIA_BUCKET`（`nano-blog-media`）
- `R2_BUILD_ACCESS_KEY_ID`
- `R2_BUILD_SECRET_ACCESS_KEY`

构建环境**不需要**作者凭据、清理凭据、Workers AI token 或 Deploy Hook。

`public/_headers` 中的媒体 origin 故意写成不可解析的 `https://media.example.invalid`。postbuild 必须把其中两处替换成 `PUBLIC_MEDIA_ORIGIN`；模板缺失、重复次数不对或生产/预览环境不是 HTTPS 都会让构建失败。

## 第 8 步：创建 Deploy Hook

1. 在 Pages 项目的 **Settings → Builds & deployments → Deploy hooks** 中创建一个 hook，分支选 `main`。
2. 复制生成的 URL。
3. **只**把它填进**作者本地的** `.env`，变量名 `CF_PAGES_DEPLOY_HOOK_URL`。

不要把它提交进仓库，也不要放进 Pages 自己的环境变量——只有本地发布与回滚命令会读取它。它按密码对待。

发布流程是：内容上传 → manifest 上传 → 条件更新 `active.json` → POST 这个 hook → Pages 用只读凭据拉取 active release → 构建。Hook 返回 2xx 只表示 Cloudflare**接受了部署请求**，不表示构建或发布已经成功；终态必须到 Pages 的 **Deployments** 页面确认。

## 第 9 步：绑定 `blog.example.invalid` 并验证

1. 在 Pages 项目的 **Custom domains** 中添加 `blog.example.invalid`。
2. 等证书签发完成，确认 HTTPS 正常并且 HTTP 会跳转到 HTTPS。
3. 逐项验证：

| 检查       | 期望                                                                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安全响应头 | 一个 HTML 响应上能看到 `Content-Security-Policy`、`Referrer-Policy`、`X-Content-Type-Options`、`X-Frame-Options`、`Permissions-Policy`、`Cross-Origin-Opener-Policy`、`Strict-Transport-Security` |
| 预览环境   | 预发域名带 `X-Robots-Tag: noindex, nofollow`                                                                                                                                                      |
| 404        | 未知路径返回 404 状态并显示站点自己的 404 页面，不重定向                                                                                                                                          |
| RSS        | `/rss.xml` 返回 `application/xml`，链接是绝对地址                                                                                                                                                 |
| sitemap    | `/sitemap-index.xml` 与 `/sitemap-0.xml` 可访问，只含公开 HTML canonical URL                                                                                                                      |
| robots     | `/robots.txt` 允许抓取并声明 sitemap                                                                                                                                                              |
| 缓存       | `/assets/*` 与 `/og/*` 为一年 immutable；HTML、RSS、sitemap、robots 为 `max-age=0, must-revalidate`；`/_pagefind/*` 为 `max-age=3600, must-revalidate`                                            |

这些规则以仓库中的 `public/_headers` 为模板，构建后会绑定真实媒体 origin，再由 Pages 读取，说明见 [PRIVACY_AND_SECURITY.md](PRIVACY_AND_SECURITY.md)。

`public/_redirects` 目前只有说明注释：站点没有旧地址，规范也禁止把未知旧 URL 全部导向首页。改变已发布文章的路径时，在那里显式添加一条 301。

## 第 10 步：第一次远端发布

远端还没有任何 release 时，`active.json` 并不存在。

**在这之前，请先取得当次明确授权。** 本仓库从未执行过这一步。

第一篇文章的 `content:new` 要求封面已经存在，所以顺序是先导入封面，再新建文章：

```bash
# 1. 本地生成封面记录；确认输出后再上传公开媒体桶
pnpm media:add ./cover.jpg --alt "封面的具体描述" --cover
pnpm media:add ./cover.jpg --alt "封面的具体描述" --cover --apply

# 2. 使用上一步输出的 /media/<digest>/1600.webp 创建并编辑文章
pnpm content:new --kind post --path posts/example.md --title "..." \
  --description "..." --published-at "..." \
  --cover-src /media/<digest>/1600.webp --cover-alt "封面的具体描述"

# 3. 确认凭据齐全（先跑 dry-run，它不产生远端写入）
pnpm content:validate
pnpm content:publish

# 4. 先记录当前 active release id（首次为 none），得到授权后才写入
pnpm content:publish --apply
```

命令报告 `deploy request accepted` 后，到 Pages 的 **Deployments** 页面等待该 deployment 到达成功终态，再做域名验收。失败时保留刚才记录的旧 release id，按 [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md) 的回滚步骤恢复指针。

第一条合法 release 可以从一个 `baseReleaseId: null` 的空工作区发布（用 `pnpm content:new` 建立）。如果远端**已经**有 active release，必须先 `pnpm content:pull --checkout` 取得工作区，不能用空 base 覆盖。

**绝对不要手工拼一个 `active.json` 放进桶里。** 指针必须由发布命令以 compare-and-swap 语义写入：首次创建用 `If-None-Match: *`，后续更新用读取到的精确 ETag 作为 `If-Match`。手写的指针绕过了并发保护，会让后续发布互相覆盖。

第一次发布之后，按 [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md) 走日常流程。

## 第 11 步：评论与阅读量（D1）

评论与阅读量需要一处能写入的存储。它们用 D1，通过 Pages Functions 提供两个端点与一个头像代理。**不做这一步站点也能正常构建与阅读**——只是没有评论区和阅读量显示。

> [!IMPORTANT]
> 这一步会让 Pages 项目从「纯静态托管」变成「静态资源 + Functions」。请求链路里仍然没有私有 R2 访问，页面也仍在构建期生成；新增的只有 `/api/*` 与 `/avatar/*` 三个端点。

### 11.1 创建 Production 与 Preview 两个数据库

```bash
npx wrangler d1 create nano-blog-comments
npx wrangler d1 create nano-blog-comments-preview
```

两个环境会接收真实 HTTP 写请求，**不能共用同一个 D1**。记下两个 `database_id`：Production id 填入本仓库 `.env` 的 `CF_D1_DATABASE_ID`（供 `comments:review` 使用）；两个 id 分别用于下面的 Pages Production / Preview 绑定。若完全不需要 Preview，请在 Pages 的 branch control 中禁用 Preview 部署，而不是把 Preview 指向生产库。

### 11.2 应用表结构

表结构在 `migrations/0001_comments_and_views.sql`。它**不在构建时执行**，也不需要手动拼 SQL：

```bash
npx wrangler d1 execute nano-blog-comments --remote --file=migrations/0001_comments_and_views.sql
npx wrangler d1 execute nano-blog-comments-preview --remote --file=migrations/0001_comments_and_views.sql
```

### 11.3 在 Pages 上绑定

在 Pages 项目的 **Settings → Bindings → Add → D1 database bindings** 中，为两个环境各添加一条：

| 环境       | 变量名        | 值                           |
| ---------- | ------------- | ---------------------------- |
| Production | `COMMENTS_DB` | `nano-blog-comments`         |
| Preview    | `COMMENTS_DB` | `nano-blog-comments-preview` |

变量名必须是 `COMMENTS_DB`，代码按这个名字读取。绑定新增或修改后需要重新部署才生效。

### 11.4 设置地址哈希密钥

在 **Settings → Environment variables** 里为 Production 与 Preview 分别添加 secret：

| 变量名               | 值                                           |
| -------------------- | -------------------------------------------- |
| `COMMENTS_IP_SECRET` | 至少 32 字符的随机串，`openssl rand -hex 32` |

它用于把读者地址哈希成一个限流用的键。两个环境使用不同的随机值。**不设这个变量，评论端点会直接报错而不是降级为保存地址原文**——后者是唯一真正要紧的行为，因此宁可直接失败。

密钥一旦更换，所有既有限流键失效（读者会被重新计数一次）。这没有安全后果。

### 11.5 审核命令所需的凭据

`pnpm comments:review` 通过 Cloudflare API 读写 D1，需要在本机 `.env` 里填两项：`CF_D1_DATABASE_ID`（11.1 的值）与 `CF_D1_API_TOKEN`（一个仅有该数据库 D1 edit 权限的 token）。两者都在 `scripts/lib/redact.ts` 的脱敏名单里，不会被打印。

**不想配 token 也可以**：`npx wrangler d1 execute nano-blog-comments --remote --command "UPDATE comments SET status='approved' WHERE id='<id>'"` 是等价的兜底路径，本仓库不依赖 wrangler。

### 11.6 验收

1. 打开任一文章页，页面底部应出现评论区；右侧元数据区出现阅读量。
2. 提交一条评论，应显示「已提交，等待作者审核。」
3. 刷新页面，该评论**不应**出现——它还在待审队列里。
4. 运行 `pnpm comments:review`，应看到这条评论及其 Markdown 与渲染结果。
5. `pnpm comments:review --approve <id> --apply`，刷新页面，评论出现且带有头像。
6. 在任一文章 frontmatter 写 `comments: false` 并重新发布，该文章的评论区消失。
7. **用命令行确认第 6 步的服务端一半真的生效**，不要只看页面：

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -X POST \
     -H 'content-type: application/x-www-form-urlencoded' \
     -d 'authorName=a+b&email=a@b.com&bodyMarkdown=hello+there' \
     https://blog.example.invalid/api/comments/<那篇文章的 id>
   ```

   期望 **403**。这一步不能省：控制依赖构建产出的 `/comments-closed.json` 被 Function 读取，而"页面没有表单"与"端点拒绝提交"是两件事。这一条曾经只被浏览器测试覆盖，而那个测试打的是测试桩——桩自己注入了开关，部署路径上却从没读过清单，于是 403 分支在生产上不可达。现在两边共用同一个加载器，但清单本身仍是构建产物：**确认它确实被发布了**（`curl -s https://blog.example.invalid/comments-closed.json`）。

8. **确认部署响应头与搜索**。本地验证服务器会应用 `_headers`，但真实 Cloudflare 响应仍需上线验收：

   ```bash
   curl -sI https://blog.example.invalid/ | grep -i content-security-policy
   ```

   期望看到 `script-src 'self' 'wasm-unsafe-eval'`。然后在浏览器里打开 `/search/` **真搜一次**——Pagefind 是 WebAssembly，缺 `'wasm-unsafe-eval'` 时搜索框会显示"搜索暂时不可用"，而静态页面、构建、单元测试与本地 e2e 全都是绿的。

## 第 12 步：备份、恢复与密钥轮换

- **R2**：不可变 release 和媒体不是备份。定期把两个桶复制到独立账户、独立桶或其他对象存储，并做抽样恢复；不要给备份任务复用作者 key。`content:rollback` 只能切换仍然存在且内容、媒体均通过哈希校验的 release，无法恢复已经被误删的对象。
- **D1 变更前**：先运行 `npx wrangler d1 time-travel info nano-blog-comments` 记录当前 bookmark，再执行迁移或批量审核。Time Travel 是原地覆盖的破坏性恢复，执行前要先导出当前状态，并保存命令返回的 undo bookmark。
- **D1 长期备份**：定期运行 `npx wrangler d1 export nano-blog-comments --remote --output=./nano-blog-comments-YYYYMMDD.sql`，把 SQL 文件加密后存到独立备份位置。官方当前 Time Travel 窗口为 Free 7 天、Paid 30 天，不能替代长期备份。
- **D1 恢复**：优先按 bookmark 或时间点执行 `npx wrangler d1 time-travel restore nano-blog-comments --bookmark=<bookmark>`；从 SQL 恢复前先建新库演练导入和验收，不要直接覆盖唯一的生产副本。
- **密钥**：至少按季度轮换 R2 build/author/cleanup、D1 API token、Workers AI token、Deploy Hook 和 `COMMENTS_IP_SECRET`；发生泄露时立即吊销。先添加新凭据并完成一次构建/只读验证，再移除旧凭据，避免无谓停机。

## 附：本项目不做的事

- 不配置 R2 runtime binding——浏览器运行时不读取任何私有存储。
- 不创建除评论与阅读量之外的任何 Worker。
- 不调用 Cloudflare 管理 API。
- 不提交 Deploy Hook、API Token 或任何 secret。
- 不把私有内容桶设为公开，不给 Pages 构建 key 写权限；作者 key 虽按平台限制具备对象读写能力，但正常作者命令不会调用删除。
