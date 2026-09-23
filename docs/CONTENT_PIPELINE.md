<!-- markdownlint-configure-file {"MD013": false, "MD024": false} -->

# 内容管线

本文描述内容从作者本地到公开站点的完整数据流，以及所有作者命令的确定行为。

## 0. 两条不可动摇的规则

### 默认 dry-run

所有可能产生远端变更的命令**默认只读取、校验并输出计划**。没有显式 `--apply` 就不会发生任何远端写入；`content:seo` 没有 `--send` 就不会发出任何网络请求。

内部实现上这不是靠「记得检查标志位」，而是结构性的：dry-run 时存储适配器被包在 `DryRunStorage` 里、Deploy Hook 被替换为 `DryRunDeployHook`，被包装的适配器的变更计数器会保持为 0。自动测试会断言「没有 `--apply` 时对存储适配器产生零次 put/delete/hook 调用」。

### 本仓库没有执行过任何云端写操作

项目从未创建 Cloudflare Pages 项目、R2 桶、域名、DNS 记录、API Token 或 Deploy Hook，也没有执行过任何带 `--apply` 的内容、媒体、发布、回滚或清理命令。本文描述的是**流程**。

## 1. 总体数据流

```text
本地作者工作区
  → 本地校验与 dry-run
  → 内容 release 和内容清单写入私有 R2
  → 最后原子切换 active.json
  → 成功后调用保密的 Pages Deploy Hook
  → Pages 构建用只读凭据拉取 active release 与引用的媒体族
  → Astro SSG
  → Pagefind 索引
  → dist 静态产物

本地媒体源文件
  → 去 EXIF、计算 SHA-256、生成响应式版本
  → dry-run
  → 公开媒体 R2 的内容寻址不可变路径
```

博客的请求链路里**没有私有 R2 请求**：站点是纯静态的，浏览器运行时不读取私有桶、不调用数据库、不需要登录。

回滚只把 `active.json` 切回某个已验证的旧 release，再触发一次 Pages 构建；**不复制、不修改旧 release**。

## 2. 两个桶

| 桶     | 默认名称            | 公开性                            | 用途                                        |
| ------ | ------------------- | --------------------------------- | ------------------------------------------- |
| 内容桶 | `nano-blog-content` | 私有                              | 不可变内容 release、manifest、`active.json` |
| 媒体桶 | `nano-blog-media`   | 通过 `media.example.invalid` 公开 | 已去敏并生成响应式版本的图片、音频与附件    |

桶名可由 `R2_CONTENT_BUCKET` 与 `R2_MEDIA_BUCKET` 覆盖。

S3 客户端固定使用：

- endpoint `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`
- region `auto`
- 只读取项目专用环境变量，不读取通用 AWS profile，也绝不把 R2 密钥传给浏览器

## 3. 私有内容桶的对象布局

```text
active.json
_control/mutation-lease.json
releases/<release-id>/manifest.json
releases/<release-id>/content/posts/.../*.md
releases/<release-id>/content/posts/.../*.mdx
releases/<release-id>/content/posts/.../_index.md
releases/<release-id>/content/pages/.../*.md
releases/<release-id>/content/pages/.../*.mdx
```

- 文本文件统一 UTF-8、LF 换行、无 BOM。
- manifest 中的文件项按 Unicode code point 路径升序排列。
- release 下的所有对象**一经上传不得覆盖**：相同键 + 相同摘要幂等跳过，相同键但字节不同立即中止。
- `active.json` 是唯一可变的发布指针，且更新必须在 release 校验通过后发生。`_control/mutation-lease.json` 是发布、回滚、清理与媒体上传共用的短期互斥记录；它通过条件写取得、续租和释放，不属于 release。

## 4. release-id

```text
YYYYMMDDTHHmmssZ-<digest12>
```

- 时间部分是 UTC，例如 `20260915T080000Z`（毫秒被丢弃）。
- `digest12` 是 release 内容摘要 SHA-256 的前 12 个小写十六进制字符。
- 校验正则等价于 `^\d{8}T\d{6}Z-[0-9a-f]{12}$`。
- 构建会断言 id 的后缀与内容摘要一致，不一致即失败。

内容摘要的定义：对

```json
{ "schemaVersion": 1, "files": [ ... ], "media": [ ... ] }
```

做 canonical JSON（键按码点排序、无空白、`undefined` 成员省略、`-0` 归一为 `0`）后取 SHA-256，写成 `sha256:<64 位小写十六进制>`。两个数组都先按 `path` 的 Unicode 码点升序排序。**`createdAt` 与 `releaseId` 不参与摘要**，所以同一份内容永远得到同一个摘要。

## 5. `manifest.json`

严格验证，**未知顶层字段一律拒绝**，九个字段全部必填：

```json
{
  "schemaVersion": 1,
  "releaseId": "20260915T080000Z-0123456789ab",
  "createdAt": "2026-09-15T08:00:00.000Z",
  "baseReleaseId": null,
  "contentPrefix": "releases/20260915T080000Z-0123456789ab/content/",
  "contentDigest": "sha256:<64 位小写十六进制>",
  "files": [
    {
      "path": "posts/dev/web/a.md",
      "sha256": "<64 位小写十六进制>",
      "bytes": 1234,
      "contentType": "text/markdown; charset=utf-8"
    }
  ],
  "media": [
    {
      "path": "/media/<源文件 SHA-256>/1600.webp",
      "sha256": "<64 位小写十六进制>"
    }
  ]
}
```

| 字段            | 类型                   | 说明                                     |
| --------------- | ---------------------- | ---------------------------------------- |
| `schemaVersion` | literal `1`            | 固定值                                   |
| `releaseId`     | 字符串                 | 必须匹配 release-id 格式                 |
| `createdAt`     | ISO datetime（带偏移） | 写入时用 `toISOString()`                 |
| `baseReleaseId` | 字符串或 `null`        | 这个 release 基于哪一个 release          |
| `contentPrefix` | 字符串                 | 必须等于 `releases/<releaseId>/content/` |
| `contentDigest` | 字符串                 | `sha256:<64 位小写十六进制>`             |
| `files[]`       | 对象数组               | `path`、`sha256`、`bytes`、`contentType` |
| `media[]`       | 对象数组               | 只有 `path` 与 `sha256`                  |

`contentType` 由扩展名决定：`.md` / `.mdx` → `text/markdown; charset=utf-8`，其他 → `application/octet-stream`。

manifest 之外的语义校验还包括：`files[].path` 必须是安全的相对路径且能通过内容路径解析、`contentType` 必须与扩展名相符、文件与媒体列表必须严格升序且无重复、媒体项的 `sha256` 必须等于其路径中嵌入的摘要、不得存在大小写碰撞、重算的 `contentDigest` 必须与字段一致。

manifest 的键是 `releases/<release-id>/manifest.json`，上传时是 2 空格缩进的 JSON 加一个换行。

## 6. `active.json`

只包含当前指针，五个字段全部必填：

```json
{
  "schemaVersion": 1,
  "releaseId": "20260915T080000Z-0123456789ab",
  "manifestKey": "releases/20260915T080000Z-0123456789ab/manifest.json",
  "contentDigest": "sha256:<64 位小写十六进制>",
  "activatedAt": "2026-09-15T08:02:00.000Z"
}
```

`manifestKey` 必须恰好等于该 release 的 manifest 键，否则校验失败。

### 6.1 compare-and-swap

`active.json` 是唯一可变对象，写入必须具备条件语义：

- **首次创建**：`If-None-Match: *`
- **后续更新**：以开始发布时读取到的**精确 ETag** 作为 `If-Match`
- 每次写入都带 `Cache-Control: no-store`
- 对象存储没有返回 ETag 时，命令以远端错误失败并明确拒绝无条件写入
- 条件失败（HTTP 412 / 409）被转换为并发冲突错误（退出码 6）

如果新指针与当前指针的 `releaseId` 与 `contentDigest` 都相同，命令会短路为「无变更」，不发出写请求。

## 7. 媒体桶的对象布局与内容寻址

```text
media/<源文件 SHA-256>/meta.json
media/<源文件 SHA-256>/480.avif
media/<源文件 SHA-256>/480.webp
media/<源文件 SHA-256>/800.avif
media/<源文件 SHA-256>/800.webp
media/<源文件 SHA-256>/1200.avif
media/<源文件 SHA-256>/1200.webp
media/<源文件 SHA-256>/1600.avif
media/<源文件 SHA-256>/1600.webp
media/<源文件 SHA-256>/original.<安全扩展名>
```

- 路径里的 `<源文件 SHA-256>` 是**源文件**的摘要，不是派生图的摘要。内容寻址意味着同一条路径永远对应同一份字节，因此不允许覆盖。
- 只生成不超过原图宽度的尺寸；始终至少保留一个 WebP 与原始格式回退。
- 派生宽度固定为 480、800、1200、1600。
- 封面另需一个固定 16:9 的 1600×900 WebP 派生图。
- `meta.json` 记录源摘要、MIME、原始图与各衍生图的宽高、字节数、摘要、创建时间，以及作者填写的 alt、来源、许可与可选署名。

缓存策略：

| 对象             | `Cache-Control`                          |
| ---------------- | ---------------------------------------- |
| 散列媒体与派生图 | `public, max-age=31536000, immutable`    |
| `meta.json`      | `public, max-age=86400, must-revalidate` |

`meta.json` 之所以不 immutable，是为了让非内容字段（例如 alt 或署名）在必要时可以修正。

发布 release 时，内容桶里的不可变对象使用 `private, max-age=31536000, immutable`。

## 8. 四种内容源模式

模式由各 `package.json` 脚本显式传给构建脚本，**不能**由浏览器参数改变。

| 模式        | 触发方式                                                              | 内容来自                                     | 产物目录        |
| ----------- | --------------------------------------------------------------------- | -------------------------------------------- | --------------- |
| `empty`     | `pnpm dev` / `pnpm build`，且 `.ani-content/workspace/content` 不存在 | 空                                           | `dist`          |
| `workspace` | `pnpm dev` / `pnpm build`，且作者工作区存在                           | `.ani-content/workspace/content`             | `dist`          |
| `fixtures`  | `pnpm dev:fixtures` / `pnpm build:fixtures`                           | `tests/fixtures/content`                     | `dist-fixtures` |
| `r2`        | `pnpm build:pages`（强制）                                            | 先 `content:pull` 拉取 active release 与媒体 | `dist`          |

选择规则非常明确：没有传 `--source` 时，只看 `.ani-content/workspace/content` 是否存在——存在即 `workspace`，不存在即 `empty`。**缺失的工作区不会回退到 fixtures 或 R2。**

其他要点：

- `--source workspace` 显式指定但目录不存在时，构建失败并提示用 `pnpm content:pull --checkout` 或 `pnpm content:new` 建立工作区。
- `build:pages` **不调用**通用的内容准备步骤。它要求 `SITE_ENV` 只能是 `production` 或 `preview`，`SITE_URL` 与 `PUBLIC_MEDIA_ORIGIN` 必须是显式 HTTPS origin。随后主动调用 `content:pull`；失败或缺少完整的 `r2` 来源记录就中止构建。
- `r2` 模式由 `content:pull` 物化：先逐项校验内容 release 及其引用媒体族，再原子替换 runtime。在线拉取不会信任本地缓存，只有显式 `--offline` 才使用已经完整校验的缓存。

### 8.1 `.ani-content/` 目录分工

| 目录                                     | 作用                                                      | Git     |
| ---------------------------------------- | --------------------------------------------------------- | ------- |
| `.ani-content/cache/releases/<id>/`      | 已校验的下载缓存（`manifest.json`、`content/`、`media/`） | ignore  |
| `.ani-content/workspace/content/`        | 作者编辑工作区                                            | ignore  |
| `.ani-content/workspace/media/<sha256>/` | 尚未上传的媒体衍生物                                      | ignore  |
| `.ani-content/runtime/content/`          | 当前一次 dev/build 的原子物化输入                         | ignore  |
| `.ani-content/seo-suggestions/`          | 手动 AI 建议（`.json` 与 `.diff`）                        | ignore  |
| `tests/fixtures/content/`                | 自动测试专用 Markdown/MDX                                 | tracked |
| `tests/fixtures/media/`                  | 自动测试专用媒体                                          | tracked |

另有 `.ani-content/workspace/workspace.json`，记录 `schemaVersion`、`baseReleaseId`、`baseContentDigest`、`createdAt`、`updatedAt`。

各模式在 `.ani-content/` 下的写入：

- **empty**：先删除整个 `.ani-content/runtime`（并清理 `.astro` 缓存），然后建立空的 `runtime/content/posts`、`runtime/content/pages` 与 `runtime/media`；写 `runtime/media-index.json` 为 `{ "schemaVersion": 1, "assets": [] }`。
- **workspace**：同样的 runtime 布局，内容从作者工作区复制；媒体从 `.ani-content/workspace/media` 物化，并写出 `runtime/media-index.json`。
- **fixtures**：同样的 runtime 布局，内容与媒体来自 `tests/fixtures/`；完全不读取 `.ani-content/workspace`。
- **r2**：`content:pull` 验证内容桶和媒体桶后写入 `.ani-content/cache/releases/<id>/`，原子生成 `runtime/content/`、`runtime/media/`、`runtime/media-index.json` 和 `runtime/source.json`。索引包括图片、音频和附件；非图片不伪造宽高。

### 8.2 `source.json`

每次物化都会写 `.ani-content/runtime/source.json`，记录本次使用的模式、release、摘要与时间。两个写入方使用**不同**的键名，阅读时需要注意：

准备步骤（`empty` / `workspace` / `fixtures`）写：

```json
{
  "schemaVersion": 1,
  "mode": "workspace",
  "releaseId": null,
  "contentDigest": "sha256:<64 位小写十六进制>",
  "materializedAt": "2026-09-15T08:00:00.000Z"
}
```

拉取步骤（`r2`）写：

```json
{
  "schemaVersion": 1,
  "mode": "r2",
  "releaseId": "20260915T080000Z-0123456789ab",
  "contentDigest": "sha256:<64 位小写十六进制>",
  "materializedAt": "2026-09-15T08:00:00.000Z"
}
```

两个写入方使用相同的 `contentDigest` / `materializedAt` 键名；显式离线拉取还会写 `offline: true`。

### 8.3 防泄漏

生产 Pages 构建在 Astro 启动前断言模式只能是 `r2`。fixture 构建输出到独立的 `dist-fixtures`。

postbuild 阶段会对构建目录做两次检查：

- 必需产物必须存在：`index.html`、`404.html`、`robots.txt`、`sitemap-index.xml`、`_headers`、`favicon.svg`；搜索索引目录 `_pagefind` 必须存在。
- 泄漏守卫：扫描构建目录中的每个文件，禁止出现 `TEST FIXTURE`、`data-test-fixture`、`tests/fixtures`、`tests\fixtures` 这几个标记。fixture 构建反过来必须包含哨兵字符串 `ANI_NANO_FIXTURE_SENTINEL_7f3a9c1e`，否则守卫会「空过」而被判为失败；正常构建中一旦出现该哨兵即失败。

## 9. 硬性上限

| 上限                          | 值      |
| ----------------------------- | ------- |
| 单个 manifest                 | 5 MiB   |
| 单个 Markdown / MDX 文件      | 2 MiB   |
| 单个 release 的内容文件数     | 10,000  |
| 单个 release 的内容总量       | 250 MiB |
| `active.json` 读取上限        | 64 KiB  |
| 拉取并发                      | 8       |
| 单个媒体 `meta.json`          | 256 KiB |
| 单个媒体资产文件数（含 meta） | 10      |
| 单个 release 的媒体资产数     | 256     |
| 单个 release 的媒体总量       | 512 MiB |

超过任一上限立即失败，不做部分写入。

## 10. 重试与容错

| 操作                                 | 策略                                                     |
| ------------------------------------ | -------------------------------------------------------- |
| List / Head / Get                    | 最多重试 3 次（合计最多 4 次尝试），带抖动指数退避       |
| 不可变对象 PUT（`If-None-Match: *`） | 同上                                                     |
| `active.json` 条件写                 | **只尝试一次**，失败即按并发冲突处理                     |
| Delete                               | **只尝试一次**；失败后重新读取，若对象已不存在则视为成功 |
| Deploy Hook                          | 每次请求 15 秒超时；最多 3 次，只对 429 与 5xx 重试      |

可重试状态码为 408、429 与 5xx；退避为 `min(4000, 250 × 2^(n-1))` 毫秒再加最多 25% 的抖动。

所有 ListObjectsV2 操作都会循环处理 `IsTruncated` 与 continuation token，不会假设一页包含全部对象。

下载时逐项校验键前缀、字节上限、SHA-256 与 manifest；拒绝绝对路径、`..`、反斜杠、NUL、符号链接与大小写碰撞。下载到临时目录，全部校验通过后再原子替换 `.ani-content/runtime`，失败时不会留下半新半旧的状态。

CI / Pages 中的拉取失败必须 fail closed，不会偷偷使用旧缓存。只有本地显式 `--offline` 才可以使用已经完整校验且摘要匹配的缓存。

## 11. 凭据分组

三组最小权限凭据，分别用于不同场景：

| 分组       | 环境变量                                                    | 允许                             | 不允许                                      |
| ---------- | ----------------------------------------------------------- | -------------------------------- | ------------------------------------------- |
| Pages 构建 | `R2_BUILD_ACCESS_KEY_ID` / `R2_BUILD_SECRET_ACCESS_KEY`     | 只读列出与读取内容桶、媒体桶对象 | 写入、删除、管理桶                          |
| 作者       | `R2_AUTHOR_ACCESS_KEY_ID` / `R2_AUTHOR_SECRET_ACCESS_KEY`   | 两个指定桶的 Object Read & Write | 管理桶、DNS、Pages 项目或 API Token         |
| 清理       | `R2_CLEANUP_ACCESS_KEY_ID` / `R2_CLEANUP_SECRET_ACCESS_KEY` | 两个指定桶的 Object Read & Write | 只在 `content:cleanup --apply` 的进程中读取 |

Cloudflare 没有 S3 Put 而无 Delete 的对象权限档位；作者 key 在平台权限上应视为可删除。单独的清理 key 用于操作隔离、审计与独立轮换。代码只在 `content:cleanup --apply` 路径调用对象删除。

另外两个 secret：

- `CF_WORKERS_AI_API_TOKEN` 只含 Workers AI Run 权限，只在手动执行 `content:seo --send` 时使用。
- `CF_PAGES_DEPLOY_HOOK_URL` 按密码处理，只在真正要触发部署时读取。

所有 secret 都在 `.gitignore` 覆盖范围内；日志与输出中一律遮蔽为 `***`，未设置的 secret 只显示 `unset`，默认完全不输出任何片段。

`BUILD_NOW` 只由自动测试进程临时注入，不写入 `.env.example`，也不写入 Pages。

## 12. 命令参考

每个命令都支持 `--help`（或 `-h`）、`--json`，以及全局的 `--apply` 与 `--dry-run`。

`--apply` 与 `--dry-run` 同时出现是参数错误。`--help` 优先于其他参数的解析，始终以退出码 0 结束。

`--json` 模式下 stdout 上**只有一个 JSON 对象**，固定包含七个顶层键：

```json
{
  "ok": true,
  "code": 0,
  "command": "content:validate",
  "dryRun": true,
  "summary": "…",
  "actions": [{ "kind": "verify", "target": "…", "detail": "…" }],
  "errors": []
}
```

`kind` 的取值集合为：`plan`、`put`、`reuse`、`skip`、`delete`、`activate`、`deploy`、`download`、`write`、`verify`、`noop`。

### 12.1 `content:pull`

只读拉取 active 或指定 release，校验后写入本地缓存与 runtime。**不改远端**——内容端口永远以 `dryRun: true` 创建。

```bash
pnpm content:pull
pnpm content:pull --release 20260915T080000Z-0123456789ab
pnpm content:pull --checkout
pnpm content:pull --offline --release 20260915T080000Z-0123456789ab
```

| 参数             | 作用                                                                                |
| ---------------- | ----------------------------------------------------------------------------------- |
| `--release <id>` | 拉取指定 release；缺省时读取 `active.json`                                          |
| `--checkout`     | 物化后把 release 复制成作者工作区，并写入 `baseReleaseId`；检测到本地编辑时拒绝覆盖 |
| `--offline`      | 只用已经完整校验、摘要匹配的本地缓存，完全不联网，也没有远端校验                    |

需要 Pages 构建凭据（`build` 角色）。`--offline` 路径不创建任何端口，因此不需要凭据。

### 12.2 `content:new`

在 `.ani-content/workspace/content` 创建符合 schema 的文件。**不上传任何东西**，也不需要凭据。

```bash
pnpm content:new --kind post \
  --path posts/dev/web/a.md \
  --title "标题" \
  --description "40 到 160 字的摘要。" \
  --published-at "2026-09-15T09:00:00+08:00" \
  --cover-src /media/<64 位源文件 SHA-256>/1600.webp \
  --cover-alt "对画面信息的具体描述" \
  --tags web-dev:"Web 开发" \
  --series astro-notes:"Astro 笔记":1

pnpm content:new --kind page --path pages/about.md --title "关于" --description "…"
pnpm content:new --kind index --path posts/dev/_index.md --title "开发" --description "…" --order 0
```

| 参数                         | 说明                                        |
| ---------------------------- | ------------------------------------------- |
| `--kind`                     | `post` / `page` / `index`，必填             |
| `--path`                     | 必填，必须是合法的内容路径                  |
| `--title`、`--description`   | 必填                                        |
| `--published-at`             | post 必填，带偏移的 ISO 8601                |
| `--cover-src`、`--cover-alt` | post 必填；封面必须来自已存在的本地媒体记录 |
| `--credit`                   | 可选                                        |
| `--tags <id:label>`          | 可重复                                      |
| `--series <id:title:order>`  | 可重复一次                                  |
| `--order`                    | 只用于 `--kind index`                       |

新文件一律写入 `draft: true`，正文为空。已存在的文件**永远不会被覆盖或改名**。

### 12.3 `media:add`

本地检查、去敏、转码并打印上传计划；`--apply` 才写媒体桶。

```bash
pnpm media:add ./photo.jpg --alt "对画面信息的具体描述"
pnpm media:add ./photo.jpg --alt "对画面信息的具体描述" --cover --credit "来源" --source "出处"
pnpm media:add ./photo.jpg --alt "对画面信息的具体描述" --cover --apply
```

| 参数       | 说明                                    |
| ---------- | --------------------------------------- |
| `<file>`   | 恰好一个位置参数，必填                  |
| `--alt`    | 必填，4–160 字符                        |
| `--cover`  | 额外生成固定的 16:9 1600×900 封面派生图 |
| `--credit` | 可选，1–200 字符                        |
| `--source` | 可选，1–200 字符                        |

不带 `--apply` 时仍然会把派生图写进 `.ani-content/workspace/media/<sha256>/`，并打印可直接粘贴的 `cover` 块与 Markdown 图片行——只是不上传。

类型按**文件签名**判断，不看扩展名。图片上限 25 MiB，其他文件上限 50 MiB。封面源图至少 1600×900，明显是单色占位图时会阻止作为封面。

带 `--apply` 时会打印一条必须阅读的警告：**媒体桶中的对象一经上传即可被公开 URL 访问，无论是否已经有文章引用它们。**

需要作者凭据（`author` 角色）。

### 12.4 `content:validate`

校验 schema、路径、路由冲突、链接、媒体、日期、标签、系列与许可。**从不联网、从不写盘**，也不需要凭据。

```bash
pnpm content:validate
pnpm content:validate --publication
pnpm content:validate --source runtime
pnpm content:validate --source fixtures
pnpm content:validate --source directory --path ./some/dir
```

| 参数            | 说明                                               |
| --------------- | -------------------------------------------------- |
| `--source`      | `workspace` / `runtime` / `fixtures` / `directory` |
| `--path`        | 与 `--source directory` 配合                       |
| `--publication` | 按发布标准检查：公开条目必须完整且媒体可解析       |

没有 `--source` 时的解析顺序为：作者工作区 → 已物化的 runtime → `empty`。

### 12.5 `content:seo`

先显示将发送的数据；`--send` 才调用 Workers AI；只生成建议文件，**不改正文**。

```bash
pnpm content:seo posts/dev/web/a.md
pnpm content:seo posts/dev/web/a.md --send
```

不带 `--send` 时零网络请求、零凭据，只打印字段清单、字符数、模型与接收方。

带 `--send` 时发送：标题、现有 description、H1–H3 文本、标签，以及去除了代码块、行内代码、图片与链接、URL 查询串与疑似 secret 之后、最多 6000 个 Unicode 字符的正文摘录。模型固定为 `@cf/qwen/qwen3.8-27b`；模型不可用时命令明确失败，**不会静默换模型**。

返回值经过本地 schema 校验后写入 `.ani-content/seo-suggestions/` 的带时间戳 `.json` 与 `.diff`。模型只可建议：40–160 字符的 description、可选的 `ogTitle` 与 `ogDescription`、3–8 个关键词、可读性或标题问题说明。

构建、预览、发布与 CI **永远不会**调用 Workers AI。

`--send` 需要 `CF_WORKERS_AI_ACCOUNT_ID` 与 `CF_WORKERS_AI_API_TOKEN`。

### 12.6 `content:publish`

校验工作区并生成完整的不可变 release 计划；`--apply` 才上传、切 active、触发部署。

```bash
pnpm content:publish
pnpm content:publish --apply
pnpm content:publish --deploy-only --release 20260915T080000Z-0123456789ab --apply
pnpm content:publish --source workspace
pnpm content:publish --source directory --path ./some/dir
```

dry-run 会输出：新增/复用对象数与总字节、content digest、`active.json` 指针变化、是否会触发 hook。缺少凭据时仍会输出完整的本地计划，但标记 `remoteVerified: false` 并以退出码 4 结束。

`--apply` 的顺序固定为：上传内容 → 上传 manifest → 条件更新 `active.json` → 触发 Deploy Hook。

发布前会再次读取 active；工作区的 `baseReleaseId` 与当前 active 不一致时中止，**禁止覆盖他人刚发布的 release**。

**active 更新成功而 Deploy Hook 最终失败时，不回滚已激活的内容。** 命令以非零退出码结束，并给出确定的重试命令 `pnpm content:publish --deploy-only --release <id> --apply`。该模式会确认 active 仍指向目标 release，否则以退出码 6 失败。

需要作者凭据；`--apply` 时还需要 `CF_PAGES_DEPLOY_HOOK_URL`。

### 12.7 `content:rollback`

指定 release，验证完整性并展示指针差异；`--apply` 才切 active 并触发部署。

```bash
pnpm content:rollback --release 20260915T080000Z-0123456789ab
pnpm content:rollback --release 20260915T080000Z-0123456789ab --apply
```

dry-run 本身会下载并逐文件哈希校验目标 release——这是网络**读取**。不接受不存在、摘要错误或 manifest 不完整的 release。如果 active 已经指向该 release，命令直接以退出码 0 结束。

需要作者凭据；`--apply` 时还需要 `CF_PAGES_DEPLOY_HOOK_URL`。

### 12.8 `content:cleanup`

计算安全保留集和删除清单；需要 `--apply --plan <digest>` 才执行匹配的计划。

```bash
pnpm content:cleanup
pnpm content:cleanup --apply --plan <digest>
```

保留规则：

- 始终保留当前 active release；
- 保留最近 **10** 个完整 release；
- 保留所有 **90 天以内**的 release（完整与否都保留）；
- 保留被上述任一保留 manifest 引用的**全部媒体**。

只有同时满足「超过 90 天」「不在最近 10 个之内」「未被任何保留 manifest 引用」的对象才进入删除清单。没有时间戳的对象、以及不符合 release 目录布局或 `media/<64 位十六进制>/` 布局的对象都归入「未识别」且**永不删除**。`active.json` 永远被跳过。

dry-run 生成 canonical 删除清单摘要；`--apply` 必须提供**相同**的摘要，并且会重新读取 active、重新计算计划。任何变化都让计划失效并以退出码 7 失败。删除的键与字节数参与摘要，`keepMedia` 与 `unrecognised` 不参与。

dry-run 使用作者凭据；`--apply` 使用清理凭据。

### 12.9 `comments:review`

审核读者提交的评论。这是让评论**进入公开页面**的唯一途径：评论一律以 `pending` 写入，只有在这里批准后才对外可见。

```bash
pnpm comments:review                       # 待审队列，默认 dry-run
pnpm comments:review --status approved     # 已批准的历史
pnpm comments:review --approve <id> --apply
pnpm comments:review --reject <id> --apply
```

待审队列会完整打印每条评论的 Markdown 原文**与渲染后的 HTML**。后者是审核时真正要看的东西：一个链接在净化后被去掉了目的地，看 Markdown 是看不出来的。

写入前会先按 id 找到该条并完整打印，因此打错 id 在写入之前就失败，不会改到别的评论。目标已是目标状态时报告 `noop` 而不重复写。

**审核不属于内容发布流程**：评论存在 D1，与 R2 上的不可变 release 无关，批准一条评论不需要重新构建或重新部署站点。

凭据：`R2_ACCOUNT_ID`、`CF_D1_DATABASE_ID`、`CF_D1_API_TOKEN`（仅该库的 D1 edit 权限）。三者都在脱敏名单里。没有 token 时可用 `wrangler d1 execute` 作为等价路径。

## 13. 退出码

所有命令共用一套固定退出码：

| 退出码 | 含义                       |
| ------ | -------------------------- |
| `0`    | 成功，或成功且无变更       |
| `2`    | 参数错误                   |
| `3`    | 内容或 manifest 校验失败   |
| `4`    | 凭据或必需环境缺失         |
| `5`    | 网络 / Cloudflare 服务失败 |
| `6`    | `active.json` 并发冲突     |
| `7`    | cleanup plan 已过期        |

需要注意两点：

- **不存在退出码 1。**
- 非 CLI 类型的错误会统一映射为退出码 5。例如内容路径解析失败抛出的错误不是 CLI 错误类型，因此 `content:new` 传了非法路径时得到的是退出码 5，而不是 3。

补充规则：

- 没有远端凭据时，纯本地的 `media:add` 与内容校验仍然工作；需要远端读取的 `pull` / `rollback` / `cleanup` 以退出码 4 失败。
- `content:publish` 的 dry-run 可以输出本地 release 计划，但必须标记 `remoteVerified: false` 并以退出码 4 结束——它不会声称可以安全 apply。
