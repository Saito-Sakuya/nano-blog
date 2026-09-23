import type { Page } from "@playwright/test";

import { expect, test, visit } from "./fixtures.js";

/**
 * Content features, exercised against the fixture build.
 *
 * Everything here is driven through the real interface — a real click, a real
 * keystroke — because the point is to prove the interaction works, not that the
 * markup exists.
 */

const EMPTY_BUILD = process.env["E2E_EMPTY"] === "1";

test.skip(EMPTY_BUILD, "the empty build has no content to exercise");

const ARTICLE = "/posts/notes/first-note/";

/**
 * Readable clipboard access is a Chromium capability in Playwright.
 *
 * `context.grantPermissions(["clipboard-read", "clipboard-write"])` throws
 * `Unknown permission` in Firefox and WebKit, so the copy tests cannot observe
 * the clipboard there at all. The site still works in those engines — it falls
 * back to `document.execCommand("copy")` when the async Clipboard API is
 * unavailable — but a fallback cannot be *read back* without the permission the
 * engine refuses to grant, so the assertion is impossible rather than failing.
 *
 * Chromium covers the behaviour in all four viewports. The other two engines
 * are skipped with this reason attached rather than left to fail, because a
 * suite that always reports red stops carrying information.
 */
const CLIPBOARD_UNSUPPORTED =
  "Playwright cannot grant clipboard permissions in Firefox or WebKit, so the clipboard cannot be read back there.";

test.describe("code blocks", () => {
  test("the copy button copies the code and reports success", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", CLIPBOARD_UNSUPPORTED);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await visit(page, ARTICLE);

    const block = page.locator("[data-code-block]").first();
    const button = block.locator("[data-copy-code]");
    await expect(button).toHaveText("复制");

    await button.click();
    await expect(button).toHaveText("已复制");

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain("Greeting");
  });

  test("the copy button resets after two seconds", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", CLIPBOARD_UNSUPPORTED);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await visit(page, ARTICLE);

    const button = page.locator("[data-copy-code]").first();
    await button.click();
    await expect(button).toHaveText("复制", { timeout: 4000 });
  });

  test("a titled block shows its title and line numbers", async ({ page }) => {
    await visit(page, ARTICLE);
    const titled = page.locator("[data-code-block][data-title]").first();
    await expect(titled).toHaveAttribute("data-title", "示例代码");
    await expect(titled).toHaveAttribute("data-line-numbers", "true");
  });

  test("the requested lines are highlighted", async ({ page }) => {
    await visit(page, ARTICLE);
    const highlighted = page.locator(".line--highlighted");
    expect(await highlighted.count()).toBeGreaterThan(0);
  });

  test("a code block scrolls inside itself rather than widening the page", async ({
    page,
  }) => {
    await visit(page, ARTICLE);
    const scrollable = await page
      .locator(".code-block__frame pre")
      .first()
      .evaluate((element) => {
        const style = window.getComputedStyle(element);
        return style.overflowX;
      });
    expect(["auto", "scroll"]).toContain(scrollable);
  });
});

test.describe("heading anchors", () => {
  test("clicking an anchor copies the canonical URL with the fragment", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", CLIPBOARD_UNSUPPORTED);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await visit(page, ARTICLE);

    const anchor = page.locator(".heading-anchor").first();
    const href = await anchor.getAttribute("href");
    await anchor.click();

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain("blog.example.invalid");
    expect(clipboard).toContain(href);
  });

  test("the copied-link feedback is announced politely", async ({
    page,
    context,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", CLIPBOARD_UNSUPPORTED);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await visit(page, ARTICLE);

    await page.locator(".heading-anchor").first().click();
    const region = page.locator("[data-live-region]");
    await expect(region).toHaveAttribute("aria-live", "polite");
  });
});

/**
 * Open the contents panel if it is one.
 *
 * Below the wide breakpoint the list lives in a collapsible rail, so a reader —
 * and a test — has to open it before its links can be clicked. On a wide screen
 * it is a plain list and this does nothing, which is why the same assertions can
 * run at every width rather than being forked per viewport.
 */
async function openToc(page: Page): Promise<void> {
  const summary = page.locator("[data-toc] > summary");
  if ((await summary.count()) === 0) return;
  const toc = page.locator("[data-toc]");
  if (await toc.evaluate((el) => (el as HTMLDetailsElement).open)) return;
  await summary.click();
}

test.describe("table of contents", () => {
  test("links jump to their heading", async ({ page }) => {
    await visit(page, ARTICLE);
    await openToc(page);

    const link = page.locator('[data-toc] a[href^="#"]').nth(1);
    const href = await link.getAttribute("href");
    await link.click();

    await expect(page).toHaveURL(new RegExp(`${href!.replace("#", "#")}$`));
  });

  test("the current section is marked while scrolling", async ({ page }) => {
    await visit(page, ARTICLE);
    await openToc(page);

    // Scroll a later heading up to the reading band and confirm that heading —
    // not merely some heading — is the one marked.
    const third = page.locator('[data-toc] a[href^="#"]').nth(2);
    const id = (await third.getAttribute("href"))!.slice(1);
    await page.locator(`#${id}`).evaluate((element) => {
      const line = window.innerHeight * 0.25;
      window.scrollTo({
        top: window.scrollY + element.getBoundingClientRect().top - line,
      });
    });

    await expect(page.locator('[data-toc] a[aria-current="true"]')).toHaveCount(
      1,
      {
        timeout: 5000,
      },
    );
    await expect(third).toHaveAttribute("aria-current", "true");
  });
});

test.describe("table of contents modes", () => {
  test("auto shows the table once there are three sections", async ({
    page,
  }) => {
    // `first-note` declares `toc: auto` and has ten H2 sections.
    await visit(page, ARTICLE);
    await expect(page.locator("[data-toc]")).toBeVisible();
  });

  test("auto hides the table below three sections", async ({ page }) => {
    // `nested` declares no `toc` at all, so the default `auto` applies and its
    // single H2 is not enough.
    await visit(page, "/posts/dev/web/deep/nested/");
    await expect(page.locator("[data-toc]")).toHaveCount(0);
  });

  test("never hides the table however many sections there are", async ({
    page,
  }) => {
    await visit(page, "/posts/notes/toc-never/");
    // The sections exist as headings; only the table is suppressed.
    expect(await page.locator(".prose h2").count()).toBeGreaterThanOrEqual(3);
    await expect(page.locator("[data-toc]")).toHaveCount(0);
  });

  test("always shows the table from a single section", async ({ page }) => {
    await visit(page, "/posts/notes/toc-always/");
    await expect(page.locator("[data-toc]")).toBeVisible();
    await expect(page.locator('[data-toc] a[href^="#"]')).toHaveCount(1);
  });

  test("a heading is still linkable when the table is hidden", async ({
    page,
  }) => {
    // `toc: never` suppresses the list, not the anchors: the permalink on the
    // heading itself must keep working.
    await visit(page, "/posts/notes/toc-never/");
    const anchor = page.locator(".heading-anchor").first();
    const href = await anchor.getAttribute("href");
    expect(href).not.toBeNull();
    await expect(page.locator(href!)).toBeVisible();
  });
});

test.describe("standalone pages", () => {
  const PAGE = "/lab/notes/";

  test("pages outside about are reachable at the site root", async ({
    page,
  }) => {
    // `pages/lab/notes.md` is `/lab/notes/`: the `pages/` segment is a storage
    // detail and never appears in a URL.
    const response = await visit(page, PAGE);
    expect(response?.status()).toBe(200);
    await expect(page.locator("h1")).toHaveCount(1);
  });

  test("a page shows no publish date, related articles or forced cover", async ({
    page,
  }) => {
    await visit(page, PAGE);
    await expect(page.locator(".article-meta")).not.toContainText("发表于");
    await expect(page.locator(".related")).toHaveCount(0);
    await expect(page.locator(".article-cover")).toHaveCount(0);
  });

  test("a page body goes through the same Markdown pipeline", async ({
    page,
  }) => {
    await visit(page, PAGE);
    // Code fences still gain their copy control, headings their anchor.
    await expect(page.locator("[data-copy-code]").first()).toBeVisible();
    expect(await page.locator(".heading-anchor").count()).toBeGreaterThan(0);
  });

  test("a page appears in the sitemap but not in the article feed", async ({
    page,
  }) => {
    const index = await visit(page, "/sitemap-index.xml");
    const sitemapPath = /<loc>([^<]*sitemap-0\.xml)<\/loc>/.exec(
      (await index?.text()) ?? "",
    )?.[1];
    expect(sitemapPath).toBeTruthy();

    const sitemap = await visit(page, new URL(sitemapPath!).pathname);
    expect((await sitemap?.text()) ?? "").toContain(PAGE);

    const rss = await visit(page, "/rss.xml");
    expect((await rss?.text()) ?? "").not.toContain(PAGE);
  });

  test("a page is searchable", async ({ page }) => {
    // Standalone pages are part of the index, so a phrase that only exists on
    // this page finds it. The query is a single short term rather than a whole
    // sentence: Pagefind segments Chinese text, and an over-long phrase is not
    // guaranteed to survive segmentation as one query.
    await visit(page, "/search/?focus=1");
    await page.locator("[data-search-input]").fill("任意深度");
    await expect(page.locator(".search-result").first()).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.locator(".search-result").first()).toContainText(
      "独立页面",
    );
  });
});

test.describe("search", () => {
  test("a real query returns real results from the index", async ({ page }) => {
    await visit(page, "/search/?focus=1");

    await page.locator("[data-search-input]").fill("填充文章");

    const results = page.locator(".search-result");
    await expect(results.first()).toBeVisible({ timeout: 10_000 });
    expect(await results.count()).toBeGreaterThan(0);
  });

  test("a query with no matches reports that clearly", async ({ page }) => {
    await visit(page, "/search/");
    await page.locator("[data-search-input]").fill("zzzzqqqqnotpresent");

    await expect(page.locator("[data-search-status]")).toContainText(
      "没有找到匹配内容",
      {
        timeout: 10_000,
      },
    );
  });

  test("the search bundle is not loaded on an article page", async ({
    page,
  }) => {
    const requested: string[] = [];
    page.on("request", (request) => requested.push(request.url()));

    await visit(page, ARTICLE);
    await page.waitForLoadState("networkidle");

    expect(requested.filter((url) => url.includes("_pagefind"))).toEqual([]);
  });

  test("the keyboard shortcut navigates to search", async ({ page }) => {
    await visit(page, "/");
    await page.keyboard.press("Control+k");
    await expect(page).toHaveURL(/\/search\//);
  });

  test("the shortcut does not fire while typing in a field", async ({
    page,
  }) => {
    await visit(page, "/search/");
    const input = page.locator("[data-search-input]");
    await input.click();
    await input.press("/");
    await expect(input).toHaveValue("/");
  });
});

test.describe("sidenotes", () => {
  test("are numbered in document order", async ({ page }) => {
    await visit(page, ARTICLE);
    const markers = page.locator(".sidenote__marker");
    expect(await markers.count()).toBeGreaterThan(0);
    await expect(markers.first()).toHaveText("1");
  });

  /*
   * On a narrow screen a note cannot sit beside its reference, so it moves into
   * the rail on the right and leaves a numbered reference behind. The reader's
   * route to the text is therefore: see the reference, click it, read the note.
   * That whole route is what this asserts — a reference that existed but led
   * nowhere would pass a weaker check.
   */
  test("move into the right-hand rail and are reachable from their reference", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await visit(page, ARTICLE);

    // The note is out of the prose and in the panel.
    await expect(page.locator(".prose aside.sidenote")).toHaveCount(0);
    const inPanel = page.locator("[data-sidenote-panel] aside.sidenote");
    await expect(inPanel).toHaveCount(1);

    // A numbered reference stands where it was.
    const ref = page.locator(".sidenote-ref").first();
    await expect(ref).toBeVisible();
    await expect(ref).toHaveText("1");

    // The rail starts closed, and the note's text is not readable until it is
    // opened — the panel is a drawer, not an always-visible block.
    const rail = page.locator("[data-sidenote-rail]");
    expect(await rail.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(
      false,
    );

    await ref.click();

    expect(await rail.evaluate((el) => (el as HTMLDetailsElement).open)).toBe(
      true,
    );
    await expect(inPanel.first()).toBeVisible();
    await expect(inPanel.first()).toContainText("这是一条边注");
  });

  test("stay in the prose on a wide screen and keep their margin position", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await visit(page, ARTICLE);

    // Above the wide breakpoint the notes float in the margin: they are in the
    // prose, the rail is hidden and there is no reference in the text.
    await expect(page.locator(".prose aside.sidenote")).toHaveCount(1);
    await expect(page.locator("[data-sidenote-rail]")).toBeHidden();
    await expect(page.locator(".sidenote-ref")).toHaveCount(0);
  });
});

test.describe("tabs", () => {
  test("are enhanced into a real tablist with one panel visible", async ({
    page,
  }) => {
    await visit(page, "/posts/notes/components/");

    const tablist = page.locator('[role="tablist"]').first();
    await expect(tablist).toBeVisible();

    const tabs = tablist.locator('[role="tab"]');
    expect(await tabs.count()).toBeGreaterThanOrEqual(2);
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  });

  test("clicking a tab switches to it", async ({ page }) => {
    await visit(page, "/posts/notes/components/");

    const tabs = page.locator('[role="tab"]');
    const panels = page.locator('[role="tabpanel"]');

    // Assert the PANEL changed, not merely the tab own state. The previous
    // version of this suite clicked a tab and then pressed ArrowRight, which
    // the arrow-key path satisfies by itself — so it passed while clicking did
    // nothing at all.
    await tabs.nth(1).click();

    await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "false");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(panels.nth(0)).toBeHidden();
    await expect(panels.nth(1)).toBeVisible();
  });

  test("arrow keys move between tabs", async ({ page }) => {
    await visit(page, "/posts/notes/components/");

    const tabs = page.locator('[role="tab"]');
    await tabs.first().click();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  });
});

test.describe("video embeds", () => {
  test("contact the provider only after a deliberate click", async ({
    page,
  }) => {
    const thirdParty: string[] = [];
    page.on("request", (request) => {
      if (
        request.url().includes("youtube") ||
        request.url().includes("bilibili")
      ) {
        thirdParty.push(request.url());
      }
    });

    /*
     * This assertion is about the initial document, not unrelated media
     * loading. The embed initialiser is a synchronous module script, so
     * `domcontentloaded` is the relevant boundary: by then an eager player
     * would already be in the DOM and its request would already have been
     * observed.
     */
    await page.goto("/posts/notes/components/", {
      waitUntil: "domcontentloaded",
    });

    const loadButton = page.locator("[data-video-load]").first();
    await expect(loadButton).toBeVisible();
    await expect(
      page.locator('iframe[src*="youtube"], iframe[src*="bilibili"]'),
    ).toHaveCount(0);
    expect(thirdParty).toEqual([]);
  });
});

test.describe("drafts and future posts", () => {
  test("a draft is reachable by nobody", async ({ page }) => {
    const response = await visit(page, "/posts/draft-post/");
    expect(response?.status()).toBe(404);
  });

  test("a future-dated post is reachable by nobody", async ({ page }) => {
    const response = await visit(page, "/posts/future-post/");
    expect(response?.status()).toBe(404);
  });

  test("neither appears in the feed", async ({ page }) => {
    const response = await visit(page, "/rss.xml");
    const body = (await response?.text()) ?? "";
    expect(body).not.toContain("草稿");
    expect(body).not.toContain("未来文章");
  });

  test("neither appears in the sitemap", async ({ page }) => {
    const index = await visit(page, "/sitemap-index.xml");
    const indexBody = (await index?.text()) ?? "";
    const sitemapPath = /<loc>([^<]*sitemap-0\.xml)<\/loc>/.exec(
      indexBody,
    )?.[1];
    expect(sitemapPath).toBeTruthy();

    const sitemap = await visit(page, new URL(sitemapPath!).pathname);
    const body = (await sitemap?.text()) ?? "";
    expect(body).not.toContain("draft-post");
    expect(body).not.toContain("future-post");
  });
});

/*
 * Back to top.
 *
 * The button had no test, and it did not do what it says: clicked from the bottom
 * of an article it landed at the top of the comments rather than the top of the
 * page. The cause was the focus call that follows the scroll — `#main` wraps the
 * whole page, so focusing it asked the browser to bring it into view, and for an
 * element taller than the viewport that aligns its *end* edge. Measured before
 * the fix at 700x800: scrollY 4714 → 4625 with the comments at y=96.
 *
 * So this asserts the destination, not merely that some scrolling happened.
 */
test.describe("back to top", () => {
  test("returns to the top of the page from the bottom, not to the comments", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 700, height: 800 });
    await visit(page, ARTICLE);
    await page.waitForTimeout(400);

    // The comments are why this regressed: they sit at the end of the page
    // inside `#main`, so they are what an end-aligned scroll lands on.
    expect(
      await page.locator("[data-comments]").count(),
      "this test needs a page whose comments sit at the end of the document",
    ).toBeGreaterThan(0);

    await page.evaluate(() =>
      window.scrollTo(0, document.documentElement.scrollHeight),
    );
    await page.waitForTimeout(300);

    const button = page.locator("[data-back-to-top]");
    await expect(
      button,
      "the button is not offered at the bottom of the page",
    ).toBeVisible();
    await button.click();
    // Smooth scrolling, plus the interrupted-focus case it used to hit.
    await page.waitForTimeout(2500);

    const landed = await page.evaluate(() => ({
      scrollY: Math.round(window.scrollY),
      commentsTop: Math.round(
        document.querySelector("[data-comments]")?.getBoundingClientRect()
          .top ?? -999,
      ),
    }));

    expect(
      landed.scrollY,
      `the click left the reader at ${landed.scrollY}px with the comments at y=${landed.commentsTop}, not at the top of the page`,
    ).toBeLessThanOrEqual(1);

    // The keyboard affordance that the focus call exists for still holds: focus
    // is at the top of the document rather than left behind on the button.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("main");
  });

  test("is not offered while the reader is near the top", async ({ page }) => {
    await visit(page, ARTICLE);
    await expect(page.locator("[data-back-to-top]")).toBeHidden();
  });
});
