---
title: TEST FIXTURE 阅读量示例
description: TEST FIXTURE 用于验证阅读量统计的显示与去重行为，页面内容本身没有意义。
publishedAt: 2026-05-23T09:00:00+08:00
tags:
  - id: fixture
    label: 测试夹具
cover:
  src: /media/a3ebc0fe4141541d420d6127389d9e789420efa8d04cfcfdcb3a0774aa8b4ed4/1600.webp
  alt: TEST FIXTURE 用于验证阅读量统计的测试封面图案
  width: 1600
  height: 900
---

## TEST FIXTURE 阅读量

这一页单独存在，好让阅读量测试有一个不会被其他用例访问到的 postId。

测试会断言三件事：文章页显示「次浏览」；同一访客在同一天重复访问不会让计数增长超过一；API 不可达时计数不显示，而不是显示一个 0。
