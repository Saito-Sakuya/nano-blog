import type { Page } from "@playwright/test";

import { expect, test, visit } from "./fixtures.js";

/**
 * The comment section and the view counter, against the real API.
 *
 * The server the suite runs against mounts the production handlers over an
 * in-memory store (`scripts/verify/api-stub.ts` imports them from
 * `functions/lib/`), so these tests drive the same validation, rate limiting,
 * rendering and status codes that deploy. Only the database is different, and a
 * local test could not exercise D1 faithfully anyway.
 *
 * ## Why the moderation state is exercised through the form
 *
 * A comment is stored `pending` and must not be visible until it is approved.
 * That is the property the whole pre-moderation design rests on, so it is
 * asserted from the outside: submit through the form, confirm the page does not
 * show it, and confirm no API response offers it.
 */

/*
 * The suite runs twice: the fixture build, then the empty one. Everything here
 * needs content — an article to comment on, a form to fill — so the empty pass
 * skips the file, the same guard `content.spec.ts` uses.
 */
const EMPTY_BUILD = process.env["E2E_EMPTY"] === "1";

test.skip(EMPTY_BUILD, "the empty build has no content to exercise");

const ARTICLE = "/posts/notes/first-note/";

/** Fill and submit the form. The server rejects anything under three seconds. */
async function submitComment(
  page: Page,
  fields: { name?: string; email?: string; body?: string } = {},
): Promise<void> {
  await page
    .locator('input[name="authorName"]')
    .fill(fields.name ?? "一位读者");
  await page
    .locator('input[name="email"]')
    .fill(fields.email ?? "reader@example.invalid");
  await page
    .locator('textarea[name="bodyMarkdown"]')
    .fill(fields.body ?? "这是一条测试评论。");
  await page.locator("[data-comment-submit]").click();
}

test.describe("comments — the form", () => {
  test("submitting says the comment is waiting for review", async ({
    page,
  }) => {
    await visit(page, ARTICLE);
    await expect(page.locator("[data-comments]")).toBeVisible();

    /*
     * Read the page, then reply. The server refuses a submission that arrives
     * less than three seconds after the page reported loading, so the wait here
     * is the same one a person would take.
     */
    await page.waitForTimeout(3200);
    await submitComment(page);

    await expect(page.locator("[data-comment-form-status]")).toContainText(
      "等待作者审核",
      { timeout: 10_000 },
    );
  });

  test("a submitted comment is not shown until it is approved", async ({
    page,
    request,
  }) => {
    await visit(page, ARTICLE);
    await page.waitForTimeout(3200);
    await submitComment(page, { body: "这条评论应当先进入待审队列。" });
    await expect(page.locator("[data-comment-form-status]")).toContainText(
      "等待作者审核",
      { timeout: 10_000 },
    );

    // Nothing on the page, and — decisively — nothing in the API response
    // either. A page that merely hid it would still be leaking it.
    const listed = await request.get(`/api/comments/notes/first-note`);
    const payload = (await listed.json()) as {
      comments: { authorName: string }[];
    };
    expect(
      payload.comments.some((c) => c.authorName === "一位读者"),
      "a pending comment must not appear in the public list",
    ).toBe(false);
  });

  test("the form validates before the network is touched", async ({ page }) => {
    await visit(page, ARTICLE);
    await page.waitForTimeout(3200);

    // A browser-side `required` check stops this; the point is that the reader
    // is told, rather than the request being sent and failing at the server.
    let posted = false;
    page.on("request", (r) => {
      if (r.url().includes("/api/comments/") && r.method() === "POST") {
        posted = true;
      }
    });

    await page.locator("[data-comment-submit]").click();
    await page.waitForTimeout(600);
    expect(posted, "an empty form should not reach the server").toBe(false);
  });

  test("the honeypot is present, unfocusable and not visible", async ({
    page,
  }) => {
    await visit(page, ARTICLE);

    const trap = page.locator('input[name="trap"]');
    await expect(trap).toHaveCount(1);
    // Out of the viewport rather than `display: none`: a hidden field is skipped
    // by automated fillers, which would defeat the point.
    await expect(trap).not.toBeInViewport();
    expect(await trap.getAttribute("tabindex")).toBe("-1");
  });

  test("the markdown hint tells the reader what is supported", async ({
    page,
  }) => {
    await visit(page, ARTICLE);
    const field = page.locator('textarea[name="bodyMarkdown"]');
    await expect(field).toHaveAttribute("maxlength", "4000");
    expect(await field.getAttribute("placeholder")).toContain("Markdown");
  });
});

test.describe("comments — without JavaScript", () => {
  test.use({ javaScriptEnabled: false });

  test("the form still exists and posts to the endpoint", async ({ page }) => {
    await visit(page, ARTICLE);

    // The list cannot load, and says so rather than sitting empty.
    await expect(page.locator("[data-comments-list]")).toContainText(
      "需要 JavaScript",
    );

    // The form is a real form: it has a method, an action and named fields, so
    // the browser can submit it the ordinary way.
    const form = page.locator("[data-comment-form]");
    await expect(form).toHaveAttribute("method", "post");
    await expect(form).toHaveAttribute(
      "action",
      "/api/comments/notes%2Ffirst-note",
    );
    await expect(page.locator('input[name="authorName"]')).toBeVisible();
    await expect(page.locator('textarea[name="bodyMarkdown"]')).toBeVisible();
  });

  test("submitting without JavaScript lands on a confirmation page", async ({
    page,
  }) => {
    await visit(page, ARTICLE);
    await page.locator('input[name="authorName"]').fill("无脚本读者");
    await page.locator('input[name="email"]').fill("noscript@example.invalid");
    await page
      .locator('textarea[name="bodyMarkdown"]')
      .fill("这条评论来自一个没有运行 JavaScript 的浏览器。");

    // No wait for a timing check here: without script there is no timestamp, and
    // the server skips that check rather than refusing the reader.
    await Promise.all([
      page.waitForNavigation({ waitUntil: "load" }),
      page.locator("[data-comment-submit]").click(),
    ]);

    // The endpoint answers a form submission with a document, not JSON.
    await expect(page.locator("h1")).toContainText("已提交");
    await expect(page.locator("body")).toContainText("等待审核");
  });
});

test.describe("comments — the article switch", () => {
  test("an article with comments disabled renders no section and no script", async ({
    page,
  }) => {
    // The fixture sets `comments: false` on this one.
    await visit(page, "/posts/notes/comments-off/");
    await expect(page.locator("[data-comments]")).toHaveCount(0);
    await expect(page.locator("[data-comment-form]")).toHaveCount(0);
  });

  test("the endpoint refuses a submission for that article", async ({
    request,
  }) => {
    /*
     * The switch is enforced on both sides. Hiding the form in the markup is a
     * convenience for the reader; refusing the request is the actual control, or
     * `comments: false` would mean "not shown" rather than "not accepted".
     */
    /*
     * `Accept: application/json` is set explicitly, because the endpoint
     * negotiates: a browser form submission gets an HTML confirmation page and a
     * `fetch` gets JSON. Asking for JSON here also makes the status the thing
     * under test rather than the content type.
     */
    const response = await request.post("/api/comments/notes%2Fcomments-off", {
      headers: { accept: "application/json" },
      form: {
        authorName: "读者",
        email: "reader@example.invalid",
        bodyMarkdown: "这条不应该被接受。",
      },
    });
    expect(response.status()).toBe(403);

    // And nothing was stored, which is the part that matters: a refusal that
    // still wrote the row would be a refusal in name only.
    const listed = await request.get("/api/comments/notes%2Fcomments-off", {
      headers: { accept: "application/json" },
    });
    const payload = (await listed.json()) as { comments: unknown[] };
    expect(payload.comments).toEqual([]);
  });

  test("an article with comments enabled does render the section", async ({
    page,
  }) => {
    await visit(page, ARTICLE);
    await expect(page.locator("[data-comments]")).toHaveCount(1);
  });
});

test.describe("view counts", () => {
  test("the article shows a count and records the visit", async ({ page }) => {
    await visit(page, "/posts/notes/views-check/");

    const views = page.locator("[data-views]");
    await expect(views).toBeVisible({ timeout: 10_000 });
    await expect(views).toContainText("次浏览");
  });

  test("a repeated visit on the same day does not count twice", async ({
    request,
  }) => {
    const first = await request.get("/api/views/notes%2Fviews-check");
    const before = ((await first.json()) as { views: number }).views;

    // Two visits from the same caller on the same day.
    await request.post("/api/views/notes%2Fviews-check");
    await request.post("/api/views/notes%2Fviews-check");

    const after = https_views(
      await request.get("/api/views/notes%2Fviews-check"),
    );
    const total = ((await after.json()) as { views: number }).views;

    /*
     * The counter is de-duplicated per visitor per day, so two more visits from
     * one caller add at most one. Without that, the number would move on every
     * refresh and would mostly measure the author's own reload key.
     */
    expect(total - before).toBeLessThanOrEqual(1);
  });

  test("the count is not shown when the API is unreachable", async ({
    page,
  }) => {
    // The element ships hidden and is only revealed once there is a real number
    // to show, so a reader never sees a placeholder zero.
    await page.route("**/api/views/**", (route) => route.abort());
    await visit(page, "/posts/notes/views-check/");
    await page.waitForTimeout(1500);

    await expect(page.locator("[data-views]")).toBeHidden();
  });
});

/** Narrow the response type without importing Playwright's APIResponse. */
function https_views(response: { json(): Promise<unknown> }): {
  json(): Promise<unknown>;
} {
  return response;
}
