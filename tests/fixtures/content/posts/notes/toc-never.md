---
title: TEST FIXTURE 目录关闭示例
description: TEST FIXTURE 用于验证 toc 取值为 never 时，即使小节数量远超阈值也不渲染目录。
publishedAt: 2026-05-20T09:00:00+08:00
tags:
  - id: fixture
    label: 测试夹具
cover:
  src: /media/1e7b56dcbc1b9b39e3a3ce577f6ed549b6a5a6d7325c5acc333dad4e0cf93334/1600.webp
  alt: TEST FIXTURE 用于验证目录开关的测试封面图案
  width: 1600
  height: 900
toc: never
---

## TEST FIXTURE 第一节

这一篇有五个 H2 小节，按自动规则早就该显示目录，但 frontmatter 写了 `toc: never`。

## TEST FIXTURE 第二节

标题锚点仍然存在，只是不再列进目录。

## TEST FIXTURE 第三节

这是第三节。

## TEST FIXTURE 第四节

这是第四节。

## TEST FIXTURE 第五节

这是第五节。
