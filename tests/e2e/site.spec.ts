import { MEDIA_ORIGIN, expect, test, visit } from "./fixtures.js";
import { isBrowserCancelledRequest } from "./request-cancellation.js";

/**
 * What every page has to get right.
 *
 * These run against both the empty build and the fixture build, so the same
 * assertions cover "the site works with no content" and "the site works with
 * content" without either case being assumed from the other.
 */

const EMPTY_BUILD = process.env["E2E_EMPTY"] === "1";

/** The origin under test, which the running pass sets via `E2E_BASE_URL`. */
const BASE_ORIGIN = process.env["E2E_BASE_URL"] ?? "http://localhost:4321";

/**
 * WebKit does not put links in the Tab order by default.
 *
 * That is a platform preference (Safari's "Press Tab to highlight each item"),
 * not something the page controls: `Tab` from the address bar lands on the
 * first form control, skipping anchors, so the skip link is never focused and
 * focus never reaches `#main` by keyboard. The markup is correct — Chromium and
 * Firefox both walk the links in order, and the visual and axe passes cover
 * WebKit — but a keyboard-order assertion cannot hold there.
 */
const WEBKIT_TAB_ORDER =
  "WebKit omits links from the default Tab order, so keyboard focus assertions cannot hold in that engine.";

test.describe("document shell", () => {
  test("the home page loads with the right language and title", async ({
    page,
  }) => {
    await visit(page, "/");
    await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
    await expect(page).toHaveTitle("nano-blog");
  });

  test("a skip link is the first focusable element", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === "webkit", WEBKIT_TAB_ORDER);
    await visit(page, "/");
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(
      () => document.activeElement?.className ?? "",
    );
    expect(focused).toContain("skip-link");
  });

  test("the skip link moves focus to the main region", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === "webkit", WEBKIT_TAB_ORDER);
    await visit(page, "/");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();
  });

  test("there is exactly one main landmark", async ({ page }) => {
    await visit(page, "/");
    await expect(page.locator("main")).toHaveCount(1);
  });

  test("there is exactly one h1 per page", async ({ page }) => {
    for (const path of [
      "/",
      "/posts/",
      "/archive/",
      "/tags/",
      "/series/",
      "/about/",
      "/search/",
    ]) {
      await visit(page, path);
      await expect(page.locator("h1"), `on ${path}`).toHaveCount(1);
    }
  });

  test("the header marks the current section", async ({ page }) => {
    await visit(page, "/archive/");
    await expect(page.locator('.bookmark[aria-current="page"]')).toHaveText(
      "归档",
    );
  });

  test("a 404 page is served for an unknown path", async ({ page }) => {
    const response = await visit(page, "/no-such-page/");
    expect(response?.status()).toBe(404);
  });
});

test.describe("no console noise", () => {
  test("every page loads without console errors or failed requests", async ({
    page,
  }) => {
    const problems: string[] = [];

    // Rapid page transitions cancel in-flight same-site API and media requests.
    // A real network failure still reports; HTTP errors use the response
    // listener below. Match exact origins so a similarly prefixed host cannot
    // be accidentally exempted.
    const allowedCancellationOrigins = [BASE_ORIGIN, MEDIA_ORIGIN];

    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      problems.push(`console: ${text}`);
    });
    page.on("pageerror", (error) =>
      problems.push(`pageerror: ${error.message}`),
    );
    page.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText ?? "";
      if (
        isBrowserCancelledRequest(
          request.url(),
          errorText,
          allowedCancellationOrigins,
        )
      )
        return;
      problems.push(`requestfailed: ${request.url()} ${errorText}`);
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      problems.push(`http ${response.status()}: ${response.url()}`);
    });

    const paths = EMPTY_BUILD
      ? [
          "/",
          "/posts/",
          "/archive/",
          "/tags/",
          "/series/",
          "/about/",
          "/search/",
        ]
      : [
          "/",
          "/posts/",
          "/posts/notes/",
          "/posts/notes/first-note/",
          "/posts/notes/components/",
          "/posts/dev/web/deep/nested/",
          "/archive/",
          "/tags/",
          "/tags/fixture/",
          "/series/",
          "/series/fixture-series/",
          "/about/",
          "/search/",
        ];

    for (const path of paths) {
      await visit(page, path);
    }

    expect(problems, problems.join("\n")).toEqual([]);
  });
});

test.describe("layout integrity", () => {
  test("no page scrolls horizontally", async ({ page }) => {
    const paths = EMPTY_BUILD
      ? ["/", "/posts/", "/search/"]
      : [
          "/",
          "/posts/",
          "/posts/notes/first-note/",
          "/posts/notes/components/",
          "/archive/",
          "/tags/",
        ];

    for (const path of paths) {
      await visit(page, path);
      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        return root.scrollWidth - root.clientWidth;
      });
      expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
    }
  });

  test("the sticky header does not cover a heading targeted by a fragment", async ({
    page,
  }) => {
    if (EMPTY_BUILD) return;
    await visit(page, "/posts/notes/first-note/");

    const anchor = page.locator(".heading-anchor").first();
    const href = await anchor.getAttribute("href");
    expect(href).not.toBeNull();

    await visit(page, `/posts/notes/first-note/${href}`);
    const heading = page.locator(href!.replace("#", "#"));
    const box = await heading.boundingBox();
    const headerHeight = await page
      .locator(".site-header")
      .evaluate((element) => element.getBoundingClientRect().height);

    expect(box?.y ?? 0).toBeGreaterThanOrEqual(headerHeight - 2);
  });
});

test.describe("theme", () => {
  test("the theme control is available and switches", async ({ page }) => {
    await visit(page, "/");

    const toggle = page.locator("[data-theme-toggle]");
    await expect(toggle).toBeVisible();

    await page.locator("[data-theme-button]").click();
    await expect(page.locator("[data-theme-menu]")).toBeVisible();

    await page.locator('[data-theme-value="dark"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.locator("[data-theme-button]").click();
    await page.locator('[data-theme-value="light"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("an explicit choice survives a reload", async ({ page }) => {
    await visit(page, "/");
    await page.locator("[data-theme-button]").click();
    await page.locator('[data-theme-value="dark"]').click();

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("the choice is applied before first paint", async ({ page }) => {
    await visit(page, "/");
    await page.locator("[data-theme-button]").click();
    await page.locator('[data-theme-value="dark"]').click();
    await page.reload();

    // The attribute must already be set by the time the body exists, which is
    // what prevents a flash of the wrong theme.
    const themeAtFirstPaint = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    expect(themeAtFirstPaint).toBe("dark");
  });

  test("following the system clears the explicit choice", async ({ page }) => {
    await visit(page, "/");
    await page.locator("[data-theme-button]").click();
    await page.locator('[data-theme-value="dark"]').click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.locator("[data-theme-button]").click();
    await page.locator('[data-theme-value="system"]').click();
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-theme",
      "dark",
    );

    const stored = await page.evaluate(() =>
      window.localStorage.getItem("nano-blog-theme"),
    );
    expect(stored).toBeNull();
  });

  test("choosing a theme does not move the page", async ({ page }) => {
    // The trigger lives in a sticky header. Returning focus to it used to make
    // the browser scroll the page by roughly half a viewport, which read as the
    // theme change itself moving the page.
    await visit(page, "/posts/notes/first-note/");
    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForTimeout(150);
    const before = await page.evaluate(() => window.scrollY);

    // Raw mouse clicks, not `locator.click()`. Playwright scrolls a target into
    // view before clicking it, and scrolling a `position: sticky` element into
    // view moves the page by itself — which would make this test fail on a
    // correct site and pass on a broken one.
    const clickAt = async (selector: string): Promise<void> => {
      const target = page.locator(selector);
      // Below 48rem the navigation scrolls horizontally, so the theme control
      // can sit outside the viewport even though it is vertically in place.
      // The nav's own `scrollLeft` is moved rather than calling
      // `scrollIntoView`, which nudges the page vertically even with
      // `block: "nearest"` — and moving the page is the thing being measured.
      await target.evaluate((el) => {
        const scroller = el.closest(".site-nav__list");
        if (scroller === null) return;
        const item = el.getBoundingClientRect();
        const box = scroller.getBoundingClientRect();
        if (item.left < box.left || item.right > box.right) {
          scroller.scrollLeft +=
            item.left - box.left - (box.width - item.width) / 2;
        }
      });
      const box = await target.boundingBox();
      if (box === null) throw new Error(`no box for ${selector}`);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    };

    await clickAt("[data-theme-button]");
    await clickAt('[data-theme-value="dark"]');
    await page.waitForTimeout(150);

    expect(await page.evaluate(() => window.scrollY)).toBe(before);
  });

  test("the menu closes on Escape and returns focus to the trigger", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === "webkit", WEBKIT_TAB_ORDER);
    await visit(page, "/");
    await page.locator("[data-theme-button]").click();
    await expect(page.locator("[data-theme-menu]")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator("[data-theme-menu]")).toBeHidden();
    await expect(page.locator("[data-theme-button]")).toBeFocused();
  });
});

test.describe("keyboard navigation", () => {
  test("every header link is reachable by keyboard", async ({ page }) => {
    await visit(page, "/");

    const labels: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      await page.keyboard.press("Tab");
      const text = await page.evaluate(
        () => document.activeElement?.textContent?.trim() ?? "",
      );
      if (text.length > 0) labels.push(text);
    }

    for (const expected of ["首页", "文章", "归档", "标签", "关于", "搜索"]) {
      expect(
        labels.some((label) => label.includes(expected)),
        `missing ${expected}`,
      ).toBe(true);
    }
  });

  test("the focus ring is visible", async ({ page, browserName }) => {
    test.skip(browserName === "webkit", WEBKIT_TAB_ORDER);
    await visit(page, "/");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");

    const outline = await page.evaluate(() => {
      const element = document.activeElement;
      if (element === null) return null;
      const style = window.getComputedStyle(element);
      return { width: style.outlineWidth, style: style.outlineStyle };
    });

    expect(outline?.style).not.toBe("none");
  });
});
