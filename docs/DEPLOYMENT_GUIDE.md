<!-- markdownlint-configure-file {"MD013": false, "MD024": false} -->

# 部署与配置指南

本文把「拿到这份仓库」到「站点上线、发布第一篇文章」的**完整顺序**串起来。它不替代已有文档，而是告诉你**什么时候该看哪一份**：

| 你想做的事                         | 看哪里                                               |
| ---------------------------------- | ---------------------------------------------------- |
| 在 Cloudflare 控制台点出资源       | [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md)（十二步） |
| 写文章、用哪些语法与组件           | [WRITING.md](WRITING.md)                             |
| 内容管线与 R2 桶布局、命令与退出码 | [CONTENT_PIPELINE.md](CONTENT_PIPELINE.md)           |
| 日常发布 / 回滚 / 清理 / 审核评论  | [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md)             |
| 隐私姿态、安全头与缓存规则         | [PRIVACY_AND_SECURITY.md](PRIVACY_AND_SECURITY.md)   |

> [!IMPORTANT]
> **本文描述的是流程，不是已经发生过的事。** 本仓库从未执行过任何云端写操作，也没有创建过任何 Cloudflare 资源（Pages 项目、R2 桶、域名、DNS、API Token、Deploy Hook）。文中所有带 `--apply` 的命令都需要**当次明确授权**之后才可执行。详见 [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md#请先读这一段)。

## 0. 全流程一图

```text
① 本地环境          Node 24 + pnpm 12.4.1 + pnpm install
        ↓
② 本地跑起来        cp .env.example .env → pnpm dev（无需任何云端凭据）
        ↓
③ 云端资源          Cloudflare 控制台十二步（全部手动）
        ↓
④ 填 .env           三组 R2 凭据 + Deploy Hook + D1（按角色）
        ↓
⑤ 取得工作区        首次：content:new；已有 active release：content:pull --checkout
        ↓
⑥ 写文章            media:add --cover → content:new → 编辑 Markdown
        ↓
⑦ 本地校验与预览    content:validate --publication → build + preview
        ↓
⑧ 首次发布          content:publish（dry-run）→ --apply
        ↓
⑨ 上线后验收        headers / RSS / sitemap / 搜索 / 404
        ↓
⑩ 日常循环          写 → 校验 → publish --apply →（必要时）rollback
        ↓
⑪ 维护              定期 cleanup；随时 comments:review
```

②之前完全离线；③⑤之后才需要凭据。

## 1. 环境要求

| 项      | 版本         | 说明                                           |
| ------- | ------------ | ---------------------------------------------- |
| Node.js | `24.x`       | 仓库内 `.node-version` 为 `24.16.0`            |
| pnpm    | `12.4.1`     | 由 `package.json` 的 `packageManager` 精确锁定 |
| Git     | 任意近期版本 | 用来保存仓库与本地改动                         |

`pnpm-workspace.yaml` 收紧了两项安装行为：只为 `esbuild` 与 `sharp` 放行安装脚本，并拒绝安装发布不足 24 小时的包版本。用 `pnpm install --frozen-lockfile` 严格按 lockfile 安装。

## 2. 本地跑起来（不需要任何云端凭据）

```bash
# 1. 复制环境变量模板。secret 值本地填写，仓库内永远为空。
cp .env.example .env

# 2. 按 lockfile 精确安装。
pnpm install --frozen-lockfile

# 3. 启动开发服务器。
pnpm dev
```

此时还没有作者工作区，`pnpm dev` 会用 **`empty` 模式**：站点正常启动，首页、归档、标签、搜索、404 全部可用，只是没有任何文章。**空内容不是未完成状态，而是明确的交付状态。**

想看点真实排版与全部语法，用夹具：

```bash
pnpm dev:fixtures      # 读取 tests/fixtures/，页面上有 TEST 模式横幅
```

想在本地试评论（内存存储，不碰 D1）：

```bash
pnpm build:fixtures         # dev:api 服务的是 dist-fixtures，必须先构建一次
pnpm dev:api                # 在 4390 端口伺服该构建，并挂上 /api/* 与 /avatar/*
```

`dev:api` 故意不用 4321/4322，因此它和 `pnpm preview`、e2e 测试可以同时运行。评论与阅读量存在**进程内存**里，重启即清空；它验证的是同一批处理器（`functions/lib/`），只有存储不同。

## 3. 云端资源

**这一步全部需要你在 Cloudflare 控制台（或 `wrangler`）手动完成**，本仓库不会代劳、也不会创建任何资源。完整清单与逐项要求见 **[CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md)**，共十二步：

| 步骤 | 做什么                                                            | 什么时候可以跳过                                       |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| 1–2  | 建两个 R2 桶；为媒体桶绑定 `media.example.invalid`                | 不能跳过，内容要存这里                                 |
| 3    | 建**三组**最小权限 R2 凭据（构建 / 作者 / 清理）                  | 不能跳过                                               |
| 4–8  | 建 Pages 项目、配置构建环境、`SITE_ENV`、构建 secret、Deploy Hook | 不能跳过                                               |
| 9    | 绑定 `blog.example.invalid` 并验证                                | 不能跳过                                               |
| 10   | 第一次远端发布                                                    | 见本文章节 7                                           |
| 11   | D1：评论与阅读量                                                  | **可跳过**，站点正常构建与阅读，只是没有评论区与阅读量 |
| 12   | R2/D1 备份与密钥轮换                                              | 正式运营前完成，之后定期执行                           |

三个要点，都是刻意的设计而不是遗漏：

- **两个桶职责分离**：`nano-blog-content` 私有（只走 S3 API + 最小权限凭据），`nano-blog-media` 通过自定义域公开。内容桶**绝不要**开公共访问。
- **三组凭据不合并**：构建凭据对两个桶只读；作者和清理凭据在 R2 平台上都是 Object Read & Write，分别保管和轮换。清理凭据只被 `content:cleanup --apply` 读取。全部写入 `.env`，日志中一律遮蔽。
- **没有 R2 runtime binding**：浏览器运行时不读取任何私有存储。页面全部构建期生成。

## 4. 填写 `.env`

`.env` 与所有 `.env.*` 都在 `.gitignore` 中（`.env.example` 除外）。**真实凭据不进仓库、不进日志、不进产物。**

变量按角色分四组，**你只需要填当前要用的那一组**：

### 4.1 站点标识（本地与云端都需要）

| 变量                  | 值                              | 说明                                          |
| --------------------- | ------------------------------- | --------------------------------------------- |
| `SITE_URL`            | `https://blog.example.invalid`  | 示例规范域名；Pages 构建要求显式 HTTPS origin |
| `PUBLIC_MEDIA_ORIGIN` | `https://media.example.invalid` | 媒体公开域名                                  |
| `SITE_TIME_ZONE`      | `Asia/Taipei`                   | 所有构建期日期判断的时区                      |
| `SITE_ENV`            | 见下                            | `local` \| `preview` \| `production`          |

`SITE_ENV` 决定三件事，**值必须精确**，猜是不会猜对的：

| 值           | 可索引 | 额外要求                                                                 |
| ------------ | ------ | ------------------------------------------------------------------------ |
| `production` | 是     | `SITE_URL` 与 `PUBLIC_MEDIA_ORIGIN` 必须是 HTTPS origin                  |
| `preview`    | 否     | 构建后往**构建目录**的 `_headers` 追加 `X-Robots-Tag: noindex, nofollow` |
| `local`      | 否     | 同上；`build:pages` 拒绝此值                                             |

未知值或缺失值会让 `build:pages` 直接失败。示例域名不是硬编码门禁；更换域名时更新 Pages 的构建变量和 Cloudflare 自定义域。

### 4.2 作者本地（发布/回滚/媒体/清理需要）

| 变量                                                        | 用于                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------- |
| `R2_ACCOUNT_ID`                                             | `content:pull` / `publish` / `rollback` / `comments:review` |
| `R2_AUTHOR_ACCESS_KEY_ID` / `R2_AUTHOR_SECRET_ACCESS_KEY`   | 同上（Object Read & Write，应视为具备删除能力）             |
| `R2_CLEANUP_ACCESS_KEY_ID` / `R2_CLEANUP_SECRET_ACCESS_KEY` | 仅 `content:cleanup --apply`                                |
| `CF_PAGES_DEPLOY_HOOK_URL`                                  | 任何带 `--apply` 的发布与回滚。**按密码对待**               |
| `CF_WORKERS_AI_ACCOUNT_ID` / `CF_WORKERS_AI_API_TOKEN`      | 仅 `content:seo --send`                                     |
| `CF_D1_DATABASE_ID` / `CF_D1_API_TOKEN`                     | 仅 `comments:review`                                        |

### 4.3 Pages 构建环境（在 Cloudflare 控制台设置，不写在本地 `.env`）

只需要**只读**凭据，不需要作者/清理/Workers AI/Deploy Hook：

- `R2_ACCOUNT_ID`、`R2_CONTENT_BUCKET`、`R2_MEDIA_BUCKET`、`R2_BUILD_ACCESS_KEY_ID`、`R2_BUILD_SECRET_ACCESS_KEY`
- `SITE_ENV`、`SITE_URL`、`PUBLIC_MEDIA_ORIGIN`、`SITE_TIME_ZONE`

构建 key 的 `Object Read only` 范围必须同时包含内容桶与媒体桶。`build:pages` 拉取并校验 active release、`meta.json`、original 和派生媒体，再生成 `runtime/media-index.json`。postbuild 从 `PUBLIC_MEDIA_ORIGIN` 生成产物 CSP；不是 HTTPS origin 等无效配置会阻断构建。若填入形式合法但指向错误站点的域名，构建无法识别，部署后媒体会加载失败，因此上线前仍须核对实际域名。

### 4.4 Pages Functions 环境（评论与阅读量）

- `COMMENTS_IP_SECRET`：≥32 字符随机串（`openssl rand -hex 32`），用于把读者地址哈希成限流键。**不设置它，评论端点会直接报错，而不是降级为保存地址原文**——后者是唯一真正要紧的行为，所以宁可直接失败。
- `COMMENTS_DB`：Production 和 Preview 分别绑定不同 D1 数据库，名称必须相同但数据库 ID 必须不同。两个环境均可能接收写请求；只配置一个数据库会让预览评论污染生产数据。

还有几个**不在 `.env.example`** 里的变量，只用于自动化测试，正常部署不要设置：`BUILD_NOW`（固定构建时刻）、`E2E_CHANNEL`、`E2E_BASE_URL`、`E2E_EMPTY`、`CI`。

## 5. 取得工作区

内容在本地的工作区是 `.ani-content/workspace/`（git 忽略）。**它是否存在，决定 `content:validate` 与 `content:publish` 读的是哪里**：

| 情况                          | 用什么                                                        |
| ----------------------------- | ------------------------------------------------------------- |
| 远端还没有任何 release        | 直接用 `content:new` 建立工作区（`baseReleaseId: null`）      |
| 远端**已经**有 active release | **必须**先 `pnpm content:pull --checkout`，不能用空 base 覆盖 |

```bash
# 远端已有 release 时：取得工作区
pnpm content:pull --checkout

# 只刷新本地 cache/runtime，不建工作区
pnpm content:pull

# 离线（只用已校验的本地缓存，绝不联网）
pnpm content:pull --offline --release <release-id>
```

`--checkout` 只在工作区不存在、或其摘要仍等于 `baseReleaseId` 时复制；检测到本地编辑会拒绝覆盖并返回退出码 3。

## 6. 写文章与导入媒体

### 6.1 新建

`content:new` 要求显式给出全部必填值，**不写占位文本、不覆盖已有文件、不自动改名**。

```bash
pnpm content:new --kind post \
  --path posts/dev/web/a.md \
  --title "一篇示例标题" \
  --description "一段 40 到 160 字的摘要，说明这篇文章讲了什么。" \
  --published-at "2026-09-15T09:00:00+08:00" \
  --cover-src /media/<64位sha256>/1600.webp \
  --cover-alt "对画面信息的具体描述" \
  --tags web-dev:"Web 开发" \
  --series astro-notes:"Astro 笔记":1
```

```bash
# 页面与目录索引
pnpm content:new --kind page  --path pages/about.md --title "关于" --description "……"
pnpm content:new --kind index --path posts/dev/_index.md --title "开发" --description "……" --order 0
```

新文件一律写入 **`draft: true`**、正文为空。草稿可以随工作区进入私有 release，但永远不会出现在公开产物里。准备公开时改成 `false` 或删掉该行。

路径规则：小写 kebab-case；必须以 `posts/` 或 `pages/` 开头；`index.md` 被拒绝（目录索引只能用 `_index.md`）；目录名 `page` 保留给分页。

### 6.2 导入媒体

`media:add` 默认**完全本地**：按文件签名判断类型、清除 EXIF/GPS 等隐私元数据、生成响应式派生图，写入 `.ani-content/workspace/media/<sha256>/`。不上传、不需要凭据。

```bash
# 只要本地派生，并打印可粘贴的 cover 块与图片行
pnpm media:add ./photo.jpg --alt "对画面信息的具体描述"

# 额外生成 16:9 的 1600×900 封面派生图
pnpm media:add ./photo.jpg --alt "对画面信息的具体描述" --cover --credit "来源或署名"

# 上传到公开媒体桶
pnpm media:add ./photo.jpg --alt "对画面信息的具体描述" --cover --apply
```

> [!WARNING]
> `--apply` 会打印一条必须阅读的警告：**媒体桶中的对象一经上传即可被公开 URL 访问，无论是否已经有文章引用它们。** 不要上传未公开的敏感素材、私有草稿附件或任何 secret。

媒体是内容寻址的：路径含源文件 SHA-256；同名对象已存在且内容不同会失败，内容相同则幂等跳过。封面源图最小 `1600×900`，`--alt` 为 4–160 字符且不能是文件名、路径或占位词。

**正文与 frontmatter 的全部字段、语法与组件见 [WRITING.md](WRITING.md)**——包括 `toc`、`comments`、callout、代码块标题、数学、Mermaid、脚注、视频嵌入、MDX 组件白名单与原始 HTML 允许列表。本节不重复。

## 7. 校验与本地预览

### 7.1 校验

```bash
# 作者工作区（存在工作区时默认读它）
pnpm content:validate

# 按发布标准：公开条目必须完整、媒体必须可解析
pnpm content:validate --publication
```

> [!IMPORTANT]
> **`content:validate` 的默认来源有先后顺序：先工作区，再物化的 runtime。** 如果没有作者工作区，它会去校验 `.ani-content/runtime/content/`——而那个目录里装的可能是上一次 `dev:fixtures` 留下的夹具内容。要明确指定来源，用 `--source`：
>
> ```bash
> pnpm content:validate --source workspace
> pnpm content:validate --source runtime
> pnpm content:validate --source fixtures
> pnpm content:validate --source directory --path ./some/dir
> ```

它从不联网、从不写盘。没有错误时退出码 0（**warning 不算失败**），有错误时退出码 3，并把每条问题打印成 `<文件> [<字段>]: <原因>`。

常见 warning 与 error 的区别值得记住：缺少本地媒体记录（未公开时）是 **warning**；正文出现 H1、公开文章正文为空、图片路径不是 `/media/<sha>/…`、路由冲突、标签或系列跨 release 不一致，都是 **error**。

### 7.2 本地预览

```bash
# 生产构建（本地 workspace / empty）
pnpm build

# 预览构建产物
pnpm preview
```

夹具链路：

```bash
pnpm build:fixtures && pnpm preview:fixtures
```

**这一步是上线前最后一道关卡**：构建会跑 Pagefind 索引与产物检查。想连测试一起跑：

```bash
pnpm verify      # 15 步（含两次构建），单独调用它不需要任何前置步骤
```

## 8. 发布

### 8.1 先看 dry-run

```bash
pnpm content:publish
```

**不上传任何对象、不移动指针、不联系 Deploy Hook。** 计划里会列出：

- `new objects` / `reused objects` 的数量与字节数；
- manifest 是「将写入」还是「完全相同，跳过」；
- `active.json` 的旧值 → 新值；
- deploy hook 是「不会联系（dry run）」还是「激活后触发」。

发布前会再读一次 active：如果工作区的 `baseReleaseId` 与当前 active 不一致，以**退出码 6**中止，**不会覆盖别人刚发布的 release**。

缺凭据时 dry-run 仍会输出完整本地计划，但标记 `remoteVerified: false` 并以退出码 4 结束——**它明确表示这份计划还不能安全 apply**。

### 8.2 应用（需要当次授权）

```bash
pnpm content:publish --apply
```

顺序固定：上传内容对象 → 上传 `manifest.json` → 以 compare-and-swap 条件更新 `active.json` → 触发 Deploy Hook → Pages 用只读凭据拉取 active release 和媒体并构建。发布、回滚、媒体上传与清理共享内容桶的条件写租约，避免互相踩踏。

发布前记录 dry-run 显示的旧 active release ID。命令显示 `deploy request accepted` 只代表 Hook 返回成功；还要在 Pages **Deployments** 中等待部署成功终态。若构建失败，按第 11 节把指针回滚到记录的旧 release，并再次确认 Pages 部署终态。

release 下的对象一经上传不会被覆盖：相同键 + 相同摘要幂等跳过，相同键但字节不同立即中止。

> [!CAUTION]
> **绝对不要手工拼一个 `active.json` 放进桶里。** 指针必须由发布命令以 CAS 语义写入（首次 `If-None-Match: *`，之后用精确 ETag 作 `If-Match`）。手写的指针绕过并发保护，会让后续发布互相覆盖。

### 8.3 Deploy Hook 失败了怎么办

**active 已经切换成功但 hook 最终失败时，命令不回滚已激活的内容**，而是以非零码结束并给出确定的补救命令：

```bash
pnpm content:publish --deploy-only --release <release-id> --apply
```

它只重新触发构建，不上传、不移动指针，且要求该 release **就是当前 active**；否则以退出码 6 失败——永远不会借机激活别的内容。

## 9. 上线后验收

Pages **Deployments** 中对应构建成功后，逐项确认：

| 检查                 | 期望                                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新文章出现           | 首页时间流、`/posts/`、归档，以及（若有）标签页与系列页                                                                                                                    |
| 文章页               | canonical、OG 图、`BlogPosting` JSON-LD 正常                                                                                                                               |
| `/rss.xml`           | 返回 `application/xml`，含新文章**全文**，链接为绝对地址                                                                                                                   |
| `/sitemap-index.xml` | 可访问，只含公开 HTML canonical URL，**不含** `draft` 与未来日期文章、不含 404 与 `/page/1/`                                                                               |
| `/search/`           | 能搜到新文章正文（Pagefind 索引已重建）                                                                                                                                    |
| 安全响应头           | `Content-Security-Policy`、`Referrer-Policy`、`X-Content-Type-Options`、`X-Frame-Options`、`Permissions-Policy`、`Cross-Origin-Opener-Policy`、`Strict-Transport-Security` |
| 预览环境             | 预发域名带 `X-Robots-Tag: noindex, nofollow`                                                                                                                               |
| 未知路径             | 返回 404 状态并显示站点自己的 404 页面，**不重定向**                                                                                                                       |
| 缓存                 | `/assets/*` 与 `/og/*` 一年 immutable；HTML/RSS/sitemap/robots 为 `max-age=0, must-revalidate`；`/_pagefind/*` 为 `max-age=3600, must-revalidate`                          |

想自动化这部分检查，`pnpm test:links`、`pnpm test:a11y`、`pnpm test:visual`、`pnpm test:performance` 都在本地对构建产物做等价断言。

## 10. 日常循环

```bash
# 1. 确认工作区是最新的
pnpm content:pull --checkout

# 2. 写
pnpm media:add ./cover.png --alt "..." --cover            # 本地派生
pnpm media:add ./cover.png --alt "..." --cover --apply    # 需要时才上传
pnpm content:new --kind post --path posts/... --title "..." ...
#    使用 media:add 输出的封面路径；编辑 Markdown，见 docs/WRITING.md

# 3. 校验 + 本地预览
pnpm content:validate --publication
pnpm dev

# 4. 发布
pnpm content:publish              # dry-run 看计划
pnpm content:publish --apply      # 授权后执行
```

**审核评论不在这个循环里。** 评论存在 D1，与 R2 上的不可变 release 无关：发布文章不需要先清空队列，批准一条评论也不需要重新构建或部署。

```bash
pnpm comments:review                                    # 列出待审（含 Markdown 与渲染后 HTML）
pnpm comments:review --approve <id> --apply             # 批准
pnpm comments:review --reject  <id> --apply             # 拒绝（保留记录，永不显示）
```

评论一律以 `pending` 写入，**只在批准后可见**——这就是「先审后发」的全部机制，没有别的开关。

## 11. 回滚与清理

### 11.1 回滚

先验证目标 release 的内容和全部引用媒体，再切换 `active.json` 并触发一次构建，**不复制、不修改旧 release**：

```bash
pnpm content:rollback --release <release-id>            # dry-run：内容与媒体逐文件哈希校验后打印指针差异
pnpm content:rollback --release <release-id> --apply    # 授权后执行
```

不存在、摘要不符或 manifest 不完整的 release 一律被拒绝（退出码 3）；active 已指向它时以 0 结束并说明「nothing changed」；并发更新会让 CAS 前置条件失败（退出码 6）。

### 11.2 清理

```bash
pnpm content:cleanup                                    # dry-run：打印保留集、删除清单与 plan digest
pnpm content:cleanup --apply --plan <digest>            # 必须带同一个 digest
```

保留规则固定：始终保留 active release、最近 10 个完整 release、所有 90 天以内的 release，以及被上述任一保留 manifest 引用媒体的**整族对象**（meta、original 和全部派生文件）。执行前会重新读取 active 并重算计划，任何变化都让计划失效（退出码 7），重跑 dry-run 取新 digest 即可。

删除操作只在这一条命令的进程中通过 `R2_CLEANUP_*` 执行；作者 key 在平台上同样是 Object Read & Write，不能把分组理解成强制的无删除权限。

## 12. 排查

| 现象                                                                      | 退出码 | 处理                                                                   |
| ------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------- |
| `This workspace is based on release X, but active.json now points at Y`   | 6      | 有人在你之后发布了。先 `pnpm content:pull --checkout`，再重新编辑/发布 |
| `This workspace has no base release, but active.json already points at X` | 6      | 空 base 工作区不能替换已有 release。先 checkout                        |
| `remoteVerified: false`                                                   | 4      | R2 只读/作者凭据缺失。补 `.env` 后重跑 dry-run                         |
| `active.json does not exist yet`                                          | 3      | 远端还没有 release。第一个 release 由空 base 工作区发布                |
| `CF_PAGES_DEPLOY_HOOK_URL is required to trigger a Pages build`           | 4      | 补上 Deploy Hook（按密码对待，绝不提交）                               |
| `The plan digest is now …, but --plan supplied …`                         | 7      | 桶在 dry-run 之后变了。重跑 dry-run                                    |
| Deploy Hook 失败                                                          | 5      | 用 `--deploy-only --release <id> --apply` 重试                         |
| 评论提交后不显示                                                          | —      | 正常：默认待审。`pnpm comments:review` 批准后才可见                    |
| 校验报 `no local media record`                                            | 0      | 未公开时是 warning。要发布就先 `media:add` 对应源文件                  |

**不存在退出码 1。** 非 CLI 类型的错误（例如内容路径解析失败）统一映射为退出码 5。

任何一步失败先看 stderr 上的 `error: <message>` 与汇总行；`--json` 模式下 stdout 上只有那一个 JSON 对象，错误在 `errors` 数组里。日志与输出中的 secret 一律遮蔽为 `***`，未设置的显示为 `unset`。

## 13. 部署形态小结

| 问题                     | 答案                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 谁来构建？               | Cloudflare Pages，构建命令 `pnpm build:pages`，输出目录 `dist`                                                                       |
| 构建时内容从哪来？       | 用只读凭据拉取 R2 上的 active release 与全部引用媒体，失败即终止，**不回退到缓存或空内容**                                           |
| 部署由谁触发？           | `content:publish --apply`（或回滚）POST 到 Pages Deploy Hook                                                                         |
| 仓库里有 CI/部署配置吗？ | **有 CI，没有部署配置。** `.github/workflows/verify.yml` 在 push 与 PR 上跑 `pnpm verify`；没有 wrangler 配置，也没有 `_routes.json` |
| 需要 `wrangler` 吗？     | 不需要。只有 D1 建库/建表与 `comments:review` 的兜底路径会用到它                                                                     |
| 运行时有哪些端点？       | 只有 `/api/comments`、`/api/views`、`/avatar`（Pages Functions + D1）                                                                |
| 页面是 SSR 吗？          | 不是。全站构建期生成（SSG），无 adapter                                                                                              |
| 浏览器会拿到 secret 吗？ | 不会。评论端点只持有 D1 绑定与一个地址哈希密钥，二者都不发给客户端                                                                   |

## 14. 相关文档

- [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md) —— Cloudflare 控制台十二步清单
- [RELEASE_RUNBOOK.md](RELEASE_RUNBOOK.md) —— 发布、回滚、清理与评论审核的操作手册
- [WRITING.md](WRITING.md) —— frontmatter 字段、路径映射、全部语法与组件
- [CONTENT_PIPELINE.md](CONTENT_PIPELINE.md) —— R2 桶布局、manifest 与 active、命令与退出码
- [PRIVACY_AND_SECURITY.md](PRIVACY_AND_SECURITY.md) —— 隐私姿态与安全响应头
- [README.md](../README.md) —— 技术栈、目录结构与命令一览
