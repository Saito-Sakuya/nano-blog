<!-- markdownlint-configure-file {"MD013": false, "MD024": false} -->

# 发布运行手册

本文写给**执行发布的人**。它按真实操作顺序列出每一步命令、每一步的预期输出，以及失败时该怎么办。

贯穿全文的两条规则：

1. **默认 dry-run。** 所有可能写入云端的命令在没有 `--apply`（或 `--send`）时只读取、校验并输出计划，不产生任何远端变更。
2. **本仓库从未执行过任何云端写操作，也没有创建过任何 Cloudflare 资源。** 本文描述的是流程，不是已经发生过的事。

## 0. 前置条件

| 需要                                                                                          | 用于哪一步                                                                 |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 已在 `.env` 填写 `R2_ACCOUNT_ID` 与 `R2_AUTHOR_ACCESS_KEY_ID` / `R2_AUTHOR_SECRET_ACCESS_KEY` | `content:pull`、`content:publish`、`content:rollback`、`media:add --apply` |
| 已在 `.env` 填写 `CF_PAGES_DEPLOY_HOOK_URL`                                                   | 任何带 `--apply` 的发布与回滚                                              |
| 已在 `.env` 填写 `R2_CLEANUP_ACCESS_KEY_ID` / `R2_CLEANUP_SECRET_ACCESS_KEY`                  | `content:cleanup --apply`                                                  |
| 已在 `.env` 填写 `CF_WORKERS_AI_ACCOUNT_ID` / `CF_WORKERS_AI_API_TOKEN`                       | 仅 `content:seo --send`                                                    |
| Cloudflare 侧已按 [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md) 完成构建与密钥配置               | 全部远端步骤                                                               |

`content:new`、`content:validate`、不带 `--apply` 的 `media:add` 和 `content:seo` 都不需要任何凭据，完全在本地工作。

## 1. 顺序总览

```text
media:add --cover     首先生成本地封面记录，必要时 --apply 上传
  ↓
content:new           使用 media:add 输出的封面路径新建草稿
  ↓
编辑 Markdown / MDX；按需 media:add 导入插图
  ↓
content:validate      校验（本地）
  ↓
content:seo           可选的 AI 元数据建议（默认不联网）
  ↓
content:publish       先 dry-run 看计划
  ↓
content:publish --apply   上传 → 写 manifest → 切 active → 触发 Deploy Hook
  ↓
验证站点
  ↓
（需要时）content:rollback
  ↓
content:cleanup       回收过期 release 与媒体
  ↓
（持续）comments:review   审核读者评论——与发布流程相互独立
```

**审核不在发布流程里。** 评论存在 D1，与 R2 上的不可变 release 无关：发布文章不需要先清空评论队列，批准一条评论也不需要重新构建或重新部署。它是随时可以做的独立操作，见第 12 节。

## 2. 新建与编辑

### 2.1 建立或取得工作区

首次发布前，若远端还没有任何 active release，可以先用 `media:add --cover` 生成本地封面记录，再用 `content:new` 建立空 base 工作区。若远端**已经**有 active release，**必须**先 checkout，不能用空 base 覆盖：

```bash
pnpm content:pull --checkout
```

`--checkout` 只在工作区不存在、或工作区摘要仍等于其 `baseReleaseId` 摘要时才复制。检测到本地编辑时会拒绝覆盖并给出退出码 3。

如果只需要刷新本地的 `cache/runtime` 而不创建工作区：

```bash
pnpm content:pull
pnpm content:pull --release 20260915T080000Z-0123456789ab
pnpm content:pull --offline --release 20260915T080000Z-0123456789ab
```

### 2.2 新建文件

`content:new` 需要显式提供全部必填值，不会写入空值或占位文本，也永远不会覆盖或自动改名已存在的文件。

新建文章（必须同时给出 path、title、description、publishedAt、cover-src、cover-alt）。先运行第 3 节的 `media:add --cover`，把输出的真实封面路径填入 `--cover-src`；下列摘要只是命令格式示例：

```bash
pnpm content:new --kind post \
  --path posts/dev/web/a.md \
  --title "一篇示例标题" \
  --description "一段 40 到 160 字的摘要，说明这篇文章讲了什么。" \
  --published-at "2026-09-15T09:00:00+08:00" \
  --cover-src /media/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/1600.webp \
  --cover-alt "对画面信息的具体描述" \
  --tags web-dev:"Web 开发" \
  --series astro-notes:"Astro 笔记":1
```

新建页面与目录索引：

```bash
pnpm content:new --kind page \
  --path pages/about.md \
  --title "关于" \
  --description "这个站点是什么，以及它为什么这样写。"

pnpm content:new --kind index \
  --path posts/dev/_index.md \
  --title "开发" \
  --description "浏览此目录下的公开文章与子目录。" \
  --order 0
```

要点：

- 新文件一律写入 `draft: true`，正文为空。这是刻意的：草稿可以随工作区进入私有 release，但永远不会出现在公开产物里。
- `--cover-src` 必须指向一个**已存在的本地媒体记录**的 `/media/<sha256>/1600.webp` 派生图；没有记录时命令失败，不会凭空写一个封面。
- 路径必须小写 kebab-case，必须以 `posts/` 或 `pages/` 开头，`index.md` 被拒绝，目录索引只能用 `_index.md`，目录名 `page` 被保留给分页。
- 路径不合法时命令以退出码 5 失败（`ContentPathError` 不是 CLI 错误类型，会走通用远端错误分支）；文件已存在时以退出码 3 失败。

### 2.3 编辑

正文、frontmatter 字段与全部语法见 [WRITING.md](WRITING.md)。准备公开时把 `draft: true` 去掉或改为 `false`。

## 3. 导入媒体

`media:add` 默认只做本地计划：它会读文件、按**文件签名**（不是扩展名）判断类型、清除 EXIF/GPS 等隐私元数据、生成响应式派生图，并把派生图写入 `.ani-content/workspace/media/<sha256>/`。**不上传任何对象，也不需要凭据。**

```bash
# 仅本地派生，输出可直接粘贴的 cover 块与 Markdown 图片行
pnpm media:add ./photo.jpg --alt "对画面信息的具体描述"

# 同时生成 16:9 的 1600×900 封面派生图
pnpm media:add ./photo.jpg --alt "对画面信息的具体描述" --cover \
  --credit "来源或署名" --source "素材出处"

# 上传到公开媒体桶
pnpm media:add ./photo.jpg --alt "对画面信息的具体描述" --cover --apply
```

硬性约束：

| 约束                 | 值                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------- |
| 图片大小上限         | 25 MiB                                                                             |
| 其他文件大小上限     | 50 MiB                                                                             |
| 允许类型             | JPEG、PNG、GIF、WebP、AVIF、TIFF；MP3、M4A、OGG、WAV、FLAC；PDF、EPUB、ZIP、纯文本 |
| 封面源图最小尺寸     | 1600 × 900                                                                         |
| 派生宽度             | 480、800、1200、1600（只生成不超过原图宽度的尺寸）                                 |
| alt 长度             | 4–160 个 Unicode 字符，且不能是文件名、路径或占位词                                |
| credit / source 长度 | 1–200 个字符                                                                       |

`--apply` 会打印一条必须阅读的警告：**媒体桶中的对象一经上传即可被公开 URL 访问，无论是否已经有文章引用它们。** 不要把未公开的敏感素材、私有草稿附件或任何 secret 放进去。

媒体是内容寻址的：路径含源文件 SHA-256，同名对象一旦存在且内容不同就会失败；内容相同则幂等跳过。

## 4. 校验

```bash
# 校验作者工作区（默认）
pnpm content:validate

# 按发布标准校验：公开条目必须完整，且媒体必须可解析
pnpm content:validate --publication

# 校验其他来源
pnpm content:validate --source runtime
pnpm content:validate --source fixtures
pnpm content:validate --source directory --path ./some/dir
```

`content:validate` 从不联网、从不写盘。它检查 schema、路径、路由冲突、链接、媒体、日期、标签、系列与许可。没有错误时退出码 0（warning 不算失败），有错误时退出码 3，并把每条问题打印为 `<文件> [<字段>]: <原因>`。

提示：也可以直接用 `--json` 拿到机器可读结果，顶层固定为 `ok`、`code`、`command`、`dryRun`、`summary`、`actions`、`errors` 七个键，stdout 上只有这一个 JSON 对象。

## 5. 可选的 SEO 建议

```bash
# 默认：只在本地显示将发送哪些字段，零网络请求
pnpm content:seo posts/dev/web/a.md

# 真正发送
pnpm content:seo posts/dev/web/a.md --send
```

不带 `--send` 时命令只打印字段清单、字符数、模型与接收方，不发出任何请求。带 `--send` 时才会把去除了代码块、URL 查询串与疑似 secret 之后、最多 6000 个 Unicode 字符的摘录发送给 Cloudflare Workers AI（模型固定为 `@cf/qwen/qwen3.8-27b`）。

命令**只写建议文件**到 `.ani-content/seo-suggestions/`（带时间戳的 `.json` 与 unified `.diff`），**不会**修改 Markdown、frontmatter 或任何已发布内容。构建、预览、发布与 CI 永远不会调用 Workers AI。

## 6. 发布

### 6.1 先看 dry-run

```bash
pnpm content:publish
```

这一步会校验工作区、以只读方式读取媒体记录、读取当前 `active.json`，并把完整计划对上桶做核对。它**不上传任何对象、不移动指针、不构造 HTTP Deploy Hook**。

计划中会明确列出：

- `new objects` / `reused objects` 的数量与字节数；
- manifest 是「将写入」还是「完全相同，跳过」；
- `active.json` 的旧值 → 新值；
- `deploy hook` 是「不会联系（dry run）」还是「激活后触发」。

发布前还会再次读取 active：如果工作区的 `baseReleaseId` 与当前 active 不一致，命令以退出码 6 中止，**不会覆盖别人刚发布的新 release**。

如果缺少凭据，dry-run 仍然会输出完整的本地计划，但会标记 `remoteVerified: false` 并以退出码 4 结束——它明确表示这份计划**还不能安全地 apply**。

### 6.2 应用

```bash
pnpm content:publish --apply
```

执行顺序是固定的：

1. 上传内容对象（`put`，已存在且摘要相同的对象走 `reuse`）；
2. 上传 `manifest.json`；
3. 以 compare-and-swap 条件更新 `active.json`（首次创建用 `If-None-Match: *`，之后用读取到的精确 ETag 作为 `If-Match`）；
4. 触发 Pages Deploy Hook。

release 下的任何对象一经上传都不会被覆盖。相同键 + 相同摘要幂等跳过；相同键但字节不同立即中止。

成功后的输出会给出 release ID、上传与复用计数，并说明部署请求已被接受。它不保证 Pages 构建成功。

成功后工作区的 `baseReleaseId` 会被更新为本次 release。

### 6.3 验证

发布前保存旧 active release ID；Hook 返回 2xx 后，到 Pages **Deployments** 等待对应 deployment 到达成功终态，再在站点上确认：

- 新文章出现在首页时间流、`/posts/`、归档与（若有）标签/系列页；
- 文章页的 canonical、OG 图、`BlogPosting` JSON-LD 正常；
- `/rss.xml` 含新文章全文，`/sitemap-index.xml` 含新 URL；
- `/search/` 能搜到新文章正文（Pagefind 索引已重建）；
- `_headers` 中的 CSP 未产生控制台违规。

## 7. Deploy Hook 失败的处理

**active 已经切换成功、但 Deploy Hook 最终失败时，命令不会回滚已激活的内容。** 它以非零退出码结束，并给出确定的补救命令：

```bash
pnpm content:publish --deploy-only --release <release-id> --apply
```

`--deploy-only` 只重新触发一次构建，不上传任何对象、不移动指针。它要求 `--release` 指定的 release **就是当前 active 指向的 release**；如果 `active.json` 指向别处，命令以退出码 6 失败——它永远不会借机激活别的内容。

Deploy Hook 最多重试 3 次，只对 429 与 5xx 重试，使用带抖动的指数退避。
每次请求有 15 秒超时。若 Hook 接受请求但后续 Pages 构建失败，查看该次构建日志；旧 release 仍可用时执行第 8 节的回滚，并等待回滚对应的 Pages deployment 成功。只有旧 release 的内容和媒体都完整时，回滚才会移动指针。

先用 `--json` 的 `dryRun: true` 形式确认目标正确：

```bash
pnpm content:publish --deploy-only --release 20260915T080000Z-0123456789ab
```

## 8. 回滚

回滚只切换 `active.json` 指针再触发一次构建，**不复制、不修改旧 release**。

```bash
# 1. 先 dry-run：命令会下载并逐文件哈希校验目标内容与媒体，然后打印指针差异
pnpm content:rollback --release 20260915T080000Z-0123456789ab

# 2. 确认后应用
pnpm content:rollback --release 20260915T080000Z-0123456789ab --apply
```

- 不存在、摘要不符或 manifest 不完整的 release，以及缺少或损坏的引用媒体，一律被拒绝（退出码 3）。
- 如果 active 已经指向该 release，命令以退出码 0 结束并说明「nothing changed」。
- 回滚期间任何人并发的 active 更新会让 CAS 前置条件失败，命令以退出码 6 结束。

## 9. 清理

```bash
# 1. dry-run：列出保留集与删除清单，并打印 plan digest
pnpm content:cleanup

# 2. 用同一个 digest 执行
pnpm content:cleanup --apply --plan <digest>
```

保留规则是固定的：

- **始终保留** 当前 active release；
- 保留**最近 10 个完整 release**；
- 保留**所有 90 天以内**的 release（完整与否都留）；
- 保留**被上述任一保留 manifest 引用的整个媒体族**，包含 `meta.json`、original 和所有派生版本。

只有同时满足「超过 90 天」「不在最近 10 个之内」「未被任何保留 manifest 引用」的对象才会进入删除清单。无法识别发布时间戳的对象、以及不符合 release 目录布局或 `media/<64 位十六进制>/` 布局的对象都不会被删除。

`--apply` 必须携带与 dry-run 完全一致的 plan digest。执行前命令会重新读取 active 并重新计算计划；**任何变化都会让计划失效并以退出码 7 失败**，此时重新跑一次 dry-run 取新 digest 即可。

删除操作只在这一条命令的进程中通过 `R2_CLEANUP_*` 执行；dry-run 阶段用的是作者凭据，不是清理凭据。Cloudflare 的作者 key 同属 Object Read & Write，应视为可删除对象；单独清理 key 是操作隔离和独立轮换。

## 9.1 备份与灾难恢复

`content:rollback` 依赖 R2 中的旧对象，不能代替备份。定期把内容桶与媒体桶复制到独立存储，并抽样恢复一份 release 的内容、`meta.json`、original 与派生文件。清理前确认最近一次备份可用。

D1 中的评论与阅读量不随内容指针回滚。批量修改或迁移之前记录 `npx wrangler d1 time-travel info nano-blog-comments` 的 bookmark，定期用 `npx wrangler d1 export nano-blog-comments --remote --output=./nano-blog-comments-YYYYMMDD.sql` 导出并加密异地保存。Time Travel 的 Free/Paid 窗口分别为 7/30 天；`time-travel restore` 会原地覆盖并取消进行中的查询，先导出当前状态和演练恢复，再在维护窗口执行。详见 [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md)。

## 10. 退出码

| 退出码 | 含义                       |
| ------ | -------------------------- |
| `0`    | 成功，或成功且无变更       |
| `2`    | 参数错误                   |
| `3`    | 内容或 manifest 校验失败   |
| `4`    | 凭据或必需环境缺失         |
| `5`    | 网络 / Cloudflare 服务失败 |
| `6`    | `active.json` 并发冲突     |
| `7`    | cleanup plan 已过期        |

注意：**不存在退出码 1。** 此外，非 CLI 类型的错误（例如内容路径解析抛出的 `ContentPathError`）会统一映射为退出码 5。

## 11. 常用排查

| 现象                                                                      | 退出码 | 处理                                                                                      |
| ------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------- |
| `This workspace is based on release X, but active.json now points at Y`   | 6      | 有人在你之后发布了。先 `pnpm content:pull --checkout` 移到当前 release，再重新编辑/发布。 |
| `This workspace has no base release, but active.json already points at X` | 6      | 空 base 工作区不能替换已有 release。先 checkout。                                         |
| `remoteVerified: false`                                                   | 4      | R2 只读/作者凭据缺失。补 `.env` 后重跑 dry-run。                                          |
| `active.json does not exist yet`                                          | 3      | 远端还没有任何 release。第一个 release 由空 base 工作区发布。                             |
| `CF_PAGES_DEPLOY_HOOK_URL is required to trigger a Pages build`           | 4      | 在 `.env` 补上 Deploy Hook（按密码对待，绝不提交）。                                      |
| `The plan digest is now …, but --plan supplied …`                         | 7      | 桶在你 dry-run 之后发生了变化。重跑 dry-run。                                             |
| Deploy Hook 失败                                                          | 5      | 用第 7 节的 `--deploy-only` 路径重试。                                                    |

任何一步失败时，先看 stderr 上的 `error: <message>` 与汇总行；`--json` 模式下错误在 `errors` 数组里，stdout 上只有那一个 JSON 对象。日志与输出中的 secret 一律被遮蔽为 `***`，未设置的 secret 显示为 `unset`。

## 12. 审核评论

读者提交的评论一律以 `pending` 写入，**只有在这里批准后才对外可见**。这是「先审后发」的全部机制，没有别的开关。

```bash
pnpm comments:review
```

默认 dry-run，列出待审评论的 Markdown 原文与渲染后的 HTML。看渲染结果是必要的：一个链接如果在净化时被去掉了目的地，在 Markdown 里仍然长得像一个链接。

决定一条：

```bash
pnpm comments:review --approve <id> --apply
pnpm comments:review --reject  <id> --apply
```

不带 `--apply` 时只打印将要做什么。写入前会按 id 找到并完整打印该条，所以打错 id 会在写入前失败。批准后读者刷新页面即可看到，不需要重新发布。

`--reject` 保留记录（状态 `rejected`）以便追溯垃圾提交，但永远不会显示。要彻底删除，用 `wrangler d1 execute` 直接删行。

### 12.1 何时看这个队列

浏览器书签存 `pnpm comments:review` 即可。评论不会阻塞任何其他操作，所以没有必须处理的时限——但待审队列越久没人看，读者越会以为自己的评论没提交成功。

### 12.2 凭据

需要 `.env` 里的 `R2_ACCOUNT_ID`、`CF_D1_DATABASE_ID`、`CF_D1_API_TOKEN`（仅该数据库的 D1 edit 权限）。三者的值都不会被打印。

没有 token 时，`wrangler d1 execute` 是等价路径：

```bash
npx wrangler d1 execute nano-blog-comments --remote   --command "UPDATE comments SET status='approved' WHERE id='<id>'"
```
