# nano-blog

一个用 Astro 构建的 Markdown / MDX 个人博客。页面在构建时生成；搜索由 Pagefind 提供，评论与阅读量由 Cloudflare Pages Functions 和 D1 处理。项目不依赖客户端 UI 框架，也不从公共 CDN 加载脚本或字体。

仓库不附带正式文章。首次运行时，首页和各内容索引会显示完整的空状态；标有 `TEST FIXTURE` 的示例内容只用于测试，不会进入普通构建产物。

## 快速开始

需要 Node.js 24（仓库中的 `.node-version` 为 `24.16.0`）和 pnpm `12.4.1`。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 优先使用 `.ani-content/workspace/content` 中的作者工作区；如果工作区不存在，就启动空内容站点。想查看包含文章和媒体的测试站点，可运行 `pnpm dev:fixtures`。这两种本地模式都不需要 Cloudflare 凭据。

构建与预览同样可以在本地完成：

```bash
pnpm build
pnpm preview
```

`pnpm build` 输出到 `dist/`；`pnpm build:fixtures` 将测试内容输出到独立的 `dist-fixtures/`。这两个目录及本地内容工作区均不会提交到 Git。

## 内容与部署

项目支持四种彼此隔离的内容来源：

| 来源        | 用途                                                                 |
| ----------- | -------------------------------------------------------------------- |
| `empty`     | 没有作者工作区时的本地默认状态                                       |
| `workspace` | 本地写作、预览和普通构建                                             |
| `fixtures`  | 自动测试与视觉验收，不进入普通构建产物                               |
| `r2`        | Cloudflare Pages 构建；拉取并校验当前 release 及引用媒体后再生成页面 |

部署采用 Cloudflare Pages、两个 R2 桶和可选的 D1 数据库：内容桶保持私有，媒体桶通过自定义域公开。Pages 构建命令是 `pnpm build:pages`，必须配置明确的 `SITE_ENV`、`SITE_URL`、`PUBLIC_MEDIA_ORIGIN` 和两个桶的只读凭据。评论与阅读量需要 Pages Functions 的 D1 绑定；不启用它们也不影响静态页面的构建与阅读。

环境变量模板见 [`.env.example`](.env.example)。真实凭据只应放在本地 `.env` 或 Cloudflare 的环境配置中，不应提交到仓库。媒体对象一经上传即可通过公开 URL 访问，即使尚未被文章引用；上传前务必确认素材可以公开。

从创建资源到发布第一篇文章，请按[部署指南](docs/DEPLOYMENT_GUIDE.md)操作。Cloudflare 控制台配置见[配置手册](docs/CLOUDFLARE_SETUP.md)，日常发布、回滚与清理见[发布运行手册](docs/RELEASE_RUNBOOK.md)。

## 常用命令

| 命令                    | 作用                                                   |
| ----------------------- | ------------------------------------------------------ |
| `pnpm dev`              | 启动本地站点，使用作者工作区或空内容                   |
| `pnpm dev:fixtures`     | 启动隔离的测试内容站点                                 |
| `pnpm build`            | 构建本地站点并检查产物                                 |
| `pnpm build:fixtures`   | 构建隔离的测试内容站点                                 |
| `pnpm build:pages`      | 从 R2 拉取并校验当前 release，供 Cloudflare Pages 构建 |
| `pnpm verify`           | 依次运行格式、静态检查、构建、测试和浏览器验证         |
| `pnpm content:pull`     | 拉取当前 release，可选择检出到作者工作区               |
| `pnpm content:new`      | 新建草稿                                               |
| `pnpm content:validate` | 校验内容                                               |
| `pnpm media:add`        | 处理媒体并预览上传计划                                 |
| `pnpm content:publish`  | 校验并规划发布                                         |
| `pnpm content:rollback` | 校验并规划回滚                                         |
| `pnpm content:cleanup`  | 规划清理不再保留的 release 和媒体                      |
| `pnpm comments:review`  | 审核评论                                               |

发布、回滚、清理和媒体上传默认不会写入云端，执行前需显式传入 `--apply`。这些命令的参数、权限和退出码见[内容管线文档](docs/CONTENT_PIPELINE.md)；单个命令也可使用 `--help` 查看说明。默认 dry-run 仍可能读取远端数据，不能等同于离线运行。

## 验证

```bash
pnpm verify
```

这条命令会先构建空内容和测试内容，再运行单元测试、集成测试、链接检查、浏览器测试、无障碍检查和性能预算检查。浏览器测试默认使用本机 Chrome；Firefox 和 WebKit 项目需要安装相应的 Playwright 浏览器。`test:nav` 需要有界面的浏览器，无法启动时会报告 `SKIP`，不会伪装成通过。

只需检查改动时，也可以分别运行 `pnpm format:check`、`pnpm lint`、`pnpm check`、`pnpm check:types` 和 `pnpm test`。GitHub Actions 会在 push 和 pull request 时运行完整的 `pnpm verify`。

## 项目结构

| 路径              | 内容                                         |
| ----------------- | -------------------------------------------- |
| `src/`            | 页面、组件、样式和内容处理逻辑               |
| `scripts/`        | 构建、内容发布、媒体处理与验证命令           |
| `functions/`      | 评论、阅读量和头像代理等 Pages Functions     |
| `tests/fixtures/` | 仅供测试的文章与媒体                         |
| `tests/`          | 单元、集成和浏览器测试                       |
| `docs/`           | 写作、部署、内容管线、隐私安全和发布操作文档 |

## 进一步阅读

- [写作指南](docs/WRITING.md)：frontmatter、路径规则、Markdown / MDX 语法与组件。
- [内容管线](docs/CONTENT_PIPELINE.md)：R2 布局、release、媒体和命令行为。
- [部署指南](docs/DEPLOYMENT_GUIDE.md)：从本地准备到首次上线的完整流程。
- [Cloudflare 配置](docs/CLOUDFLARE_SETUP.md)：Pages、R2 和 D1 的控制台设置。
- [隐私与安全](docs/PRIVACY_AND_SECURITY.md)：数据处理、安全响应头和缓存策略。
- [发布运行手册](docs/RELEASE_RUNBOOK.md)：日常发布、回滚、清理及恢复。

## 许可

项目代码采用 [MIT 许可](LICENSE)。站点文章、页面和原创媒体采用 [CC BY 4.0](CONTENT_LICENSE.md)；第三方素材仍遵循各自的许可。两类许可的适用范围见[内容许可说明](CONTENT_LICENSE.md)。
