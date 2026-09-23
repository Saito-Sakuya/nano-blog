---
title: TEST FIXTURE 泄漏哨兵
description: TEST FIXTURE 这篇文章的唯一作用是携带一个唯一字符串，供构建后的泄漏守卫确认隔离是否有效。
publishedAt: 2026-04-01T00:00:00+08:00
tags:
  - id: fixture
    label: 测试夹具
cover:
  src: /media/a3ebc0fe4141541d420d6127389d9e789420efa8d04cfcfdcb3a0774aa8b4ed4/1600.webp
  alt: TEST FIXTURE 泄漏哨兵文章使用的测试封面图案
  width: 1600
  height: 900
---

## TEST FIXTURE 泄漏哨兵

这段正文里嵌入了唯一字符串 ANI_NANO_FIXTURE_SENTINEL_7f3a9c1e。

它只能出现在 fixture 构建产物中。如果正常 `dist` 的任何文件里出现它，说明内容源隔离失效，
postbuild 的泄漏守卫会因此让构建失败。
