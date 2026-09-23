import { commentsApiPath } from "../lib/routing/urls.js";
import { SITE_LANG } from "../lib/site.js";

/**
 * The comment section, when JavaScript is available.
 *
 * Two jobs: load the approved comments, and submit the form without leaving the
 * page. Everything here is an enhancement over behaviour that already works —
 * the form posts natively without this file, and the list says so when the
 * script cannot run.
 *
 * ## The one rule this file follows
 *
 * **Nothing from the API is ever inserted as markup.** Comment bodies arrive
 * already rendered and sanitised by the server, and they still go in through
 * `innerHTML` — but only because that value was produced by the server's own
 * sanitiser, never by the reader. Everything else — names, dates, error
 * messages, the count — is built with `textContent`, so a name is a string
 * rather than a fragment of HTML even if the server's escaping were ever wrong.
 * That division is deliberate: exactly one value is trusted to be markup, it is
 * the one the server renders, and it is named `bodyHtml` so the trust is visible
 * at every use.
 */

interface PublicComment {
  readonly id: string;
  readonly authorName: string;
  readonly avatarHash: string;
  readonly bodyHtml: string;
  readonly createdAt: string;
}

/**
 * Format an ISO timestamp in the site's own locale.
 *
 * Not the reader's: the site writes Chinese dates everywhere else — in the
 * article header, in the archive, in the feed — and a comment list that
 * reformatted them per reader would disagree with the article it is attached
 * to. The timestamp itself is an ISO value on the `<time>` element, so the
 * reader's tools still get a machine-readable date.
 */
function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(SITE_LANG, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** Build one comment element. */
function renderComment(comment: PublicComment): HTMLElement {
  const article = document.createElement("article");
  article.className = "comment";
  article.id = `comment-${comment.id}`;

  const header = document.createElement("header");
  header.className = "comment__header";

  const avatar = document.createElement("img");
  avatar.className = "comment__avatar";
  avatar.src = `/avatar/${encodeURIComponent(comment.avatarHash)}`;
  avatar.alt = "";
  avatar.width = 40;
  avatar.height = 40;
  // Decorative: the name is right beside it, and announcing it twice is noise.
  avatar.setAttribute("aria-hidden", "true");
  avatar.loading = "lazy";
  avatar.decoding = "async";

  const name = document.createElement("span");
  name.className = "comment__name";
  // textContent, not innerHTML: a display name is data.
  name.textContent = comment.authorName;

  const time = document.createElement("time");
  time.className = "comment__date";
  time.dateTime = comment.createdAt;
  time.textContent = formatDate(comment.createdAt);

  header.append(avatar, name, time);

  const body = document.createElement("div");
  body.className = "prose comment__body";
  /*
   * The single trusted insertion. `bodyHtml` is produced by
   * `renderCommentMarkdown` on the server, from a schema that strips scripts,
   * event handlers, images and dangerous protocols; the client never renders
   * anything a reader typed.
   */
  body.innerHTML = comment.bodyHtml;

  article.append(header, body);
  return article;
}

export function initComments(): void {
  const section = document.querySelector<HTMLElement>("[data-comments]");
  if (section === null) return;

  const postId = section.dataset["postId"] ?? "";
  if (postId.length === 0) return;

  const list = section.querySelector<HTMLElement>("[data-comments-list]");
  const listStatus = section.querySelector<HTMLElement>(
    "[data-comments-status]",
  );
  const form = section.querySelector<HTMLFormElement>("[data-comment-form]");
  const formStatus = section.querySelector<HTMLElement>(
    "[data-comment-form-status]",
  );
  const submit = section.querySelector<HTMLButtonElement>(
    "[data-comment-submit]",
  );

  /*
   * Stamp the moment the page became interactive.
   *
   * This is the only honest source for "when did the reader open this": the
   * markup cannot carry it, because on a static site the markup is written at
   * build time. The server subtracts this from its own clock; it never trusts a
   * duration sent by the client.
   */
  const renderedAt = form?.querySelector<HTMLInputElement>(
    "[data-comment-rendered-at]",
  );
  if (renderedAt !== null && renderedAt !== undefined) {
    renderedAt.value = String(Math.floor(Date.now() / 1000));
  }

  // --- the list ------------------------------------------------------------

  const showComments = (comments: readonly PublicComment[]): void => {
    if (list === null) return;
    list.replaceChildren();

    if (comments.length === 0) {
      const empty = document.createElement("p");
      empty.className = "comments__status";
      empty.textContent = "还没有评论。";
      list.append(empty);
      return;
    }

    for (const comment of comments) list.append(renderComment(comment));
  };

  const loadComments = async (): Promise<void> => {
    try {
      const response = await fetch(commentsApiPath(postId), {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const data = (await response.json()) as { comments?: PublicComment[] };
      showComments(data.comments ?? []);
    } catch {
      /*
       * A failed fetch leaves the original status text in place, which says the
       * list needs JavaScript. That is not quite what went wrong, so it is
       * replaced with something accurate — and the form below still works, which
       * is the part that matters.
       */
      if (listStatus !== null) {
        listStatus.textContent = "评论暂时无法加载。你仍然可以提交评论。";
      }
    }
  };

  void loadComments();

  // --- the form ------------------------------------------------------------

  if (form === null) return;

  const setFormStatus = (message: string): void => {
    if (formStatus !== null) formStatus.textContent = message;
  };

  form.addEventListener("submit", (event) => {
    // Take over from the browser, which would otherwise navigate away.
    event.preventDefault();

    if (submit !== null) submit.disabled = true;
    setFormStatus("正在提交…");

    const data = new FormData(form);

    void (async (): Promise<void> => {
      try {
        const response = await fetch(form.action, {
          method: "POST",
          headers: { accept: "application/json" },
          body: new URLSearchParams(
            [...data.entries()].map(([key, value]) => [
              key,
              typeof value === "string" ? value : "",
            ]),
          ),
        });

        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          status?: string;
        };

        if (response.ok || response.status === 202) {
          /*
           * Accepted, not published. Saying "submitted" rather than "posted" is
           * the difference between a commenter understanding the silence and
           * assuming the form is broken.
           */
          form.reset();
          setFormStatus("已提交，等待作者审核。");
          return;
        }

        setFormStatus(payload.error ?? "提交失败，请稍后再试。");
      } catch {
        /*
         * The network failed. The form still holds what was typed, so the reader
         * can try again without losing it — which is why this does not reset.
         */
        setFormStatus("提交失败，请稍后再试。");
      } finally {
        if (submit !== null) submit.disabled = false;
      }
    })();
  });
}
