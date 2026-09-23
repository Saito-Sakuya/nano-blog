---
title: TEST FIXTURE 关闭评论示例
description: TEST FIXTURE 用于验证 comments 取值为 false 的文章不渲染评论区，且其提交端点拒绝评论。
publishedAt: 2026-05-22T09:00:00+08:00
tags:
  - id: fixture
    label: 测试夹具
cover:
  src: /media/1e7b56dcbc1b9b39e3a3ce577f6ed549b6a5a6d7325c5acc333dad4e0cf93334/1600.webp
  alt: TEST FIXTURE 用于验证评论开关的测试封面图案
  width: 1600
  height: 900
comments: false
---

## TEST FIXTURE 这一篇不接受评论

frontmatter 里写了 `comments: false`，因此这一页不渲染评论区、不加载评论脚本，其提交端点也拒绝写入。这是「部分允许评论，也允许不评论」中的后者。

正文本身是普通的，只有评论开关不同，这样测试里两页的差异可以归因到那一个字段。
