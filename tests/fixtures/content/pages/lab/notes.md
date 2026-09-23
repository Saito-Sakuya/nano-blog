---
title: TEST FIXTURE 独立页面示例
description: TEST FIXTURE 用于验证 pages 目录下的非 about 页面会渲染成普通阅读页，而不是文章。
updatedAt: 2026-08-20T09:00:00+08:00
---

## TEST FIXTURE 页面正文

这一页来自 `pages/lab/notes.md`，公开 URL 是 `/lab/notes/`。它验证三件事：`pages/` 这一层不出现在 URL 中、页面可以位于任意深度，以及页面沿用文章排版但不显示发布时间、相关文章与强制封面。

## TEST FIXTURE 代码与锚点

页面正文与文章正文走同一条 Markdown 管线，所以代码块同样带复制按钮、标题同样带锚点链接：

```ts title="页面里的代码块"
const page = "pages/lab/notes.md";
export { page };
```

## TEST FIXTURE 第三个小节

三个 H2 让 `toc` 的自动规则（至少三节才显示目录）在这一页生效。
