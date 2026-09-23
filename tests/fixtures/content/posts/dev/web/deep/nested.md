---
title: TEST FIXTURE 三级目录文章
description: TEST FIXTURE 位于三层目录深处的文章，用于验证路径映射、面包屑与自动目录页。
publishedAt: 2026-05-20T08:00:00+08:00
tags:
  - id: fixture
    label: 测试夹具
cover:
  src: /media/1e7b56dcbc1b9b39e3a3ce577f6ed549b6a5a6d7325c5acc333dad4e0cf93334/1600.webp
  alt: TEST FIXTURE 深层目录文章使用的测试封面图案
  width: 1600
  height: 900
---

## TEST FIXTURE 深层文章

这篇文章位于 `posts/dev/web/deep/nested.md`，公开 URL 应当是 `/posts/dev/web/deep/nested/`。

它的每一级祖先目录都应当自动生成索引页与面包屑，即使中间层没有 `_index.md`。
