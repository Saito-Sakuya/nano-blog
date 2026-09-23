/**
 * Search.
 *
 * Pagefind runs entirely in the browser against a static index that the build
 * produces. No query leaves the machine and there is no search server.
 *
 * The bundle is fetched only when the reader actually searches — the module is
 * imported on first input, not on page load — and every failure path ends in
 * something the reader can act on rather than an empty box.
 */

const INDEX_PATH = "/_pagefind/pagefind.js";

interface PagefindResultData {
  readonly url: string;
  readonly excerpt: string;
  readonly meta?: Record<string, string | undefined>;
}

interface PagefindSearchResults {
  readonly results: { data: () => Promise<PagefindResultData> }[];
}

interface PagefindModule {
  options?: (options: Record<string, unknown>) => Promise<void>;
  init?: () => Promise<void>;
  search: (query: string) => Promise<PagefindSearchResults>;
}

type Status =
  "initial" | "loading" | "results" | "empty" | "error" | "no-index";

const EMPTY_MESSAGES: Record<string, string> = {
  blank: "请输入关键词。",
  none: "没有找到匹配内容。可以尝试减少关键词，或改用更常见的词。",
  "no-index": "暂无可搜索的公开内容。",
  error: "搜索暂时不可用。",
};

/**
 * Rebuild a Pagefind excerpt keeping only text and `<mark>`.
 *
 * The excerpt is generated from this site's own content, but it arrives as an
 * HTML string, so its structure is walked and everything except plain text and
 * the highlight element is copied out — attributes included. Nothing is ever
 * taken from that tree but text: the result is a fresh node built with
 * `createTextNode` and `createElement("mark")`.
 *
 * The string is parsed with `template.innerHTML`, which is safe for exactly two
 * reasons and neither is that the string is trusted. Content inside a
 * `<template>` is inert: the parser builds a document fragment without running
 * scripts or starting subresource loads, so nothing in the excerpt can execute
 * or make a request on the way in. And the parsed fragment is never attached to
 * this document — the walk copies text out of it, so an element that survived
 * the parse would still have no place in the page. What reaches the reader is
 * the text the walk produced.
 */
function safeExcerpt(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;

  const fragment = document.createDocumentFragment();

  const walk = (source: Node, target: Node): void => {
    for (const child of source.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        target.appendChild(document.createTextNode(child.textContent ?? ""));
        continue;
      }
      if (child instanceof HTMLElement && child.tagName === "MARK") {
        const mark = document.createElement("mark");
        mark.textContent = child.textContent ?? "";
        target.appendChild(mark);
        continue;
      }
      // Anything else is dropped, but its text content is kept.
      walk(child, target);
    }
  };

  walk(template.content, fragment);
  return fragment;
}

function readSiteHasContent(): boolean {
  const field = document.querySelector<HTMLElement>("[data-search-root]");
  return field?.dataset["hasContent"] === "true";
}

/**
 * How long the field must be quiet before a query is issued.
 *
 * Long enough that ordinary typing produces one search per word rather than one
 * per keystroke; short enough that the results still feel like they follow the
 * typing. Waiting also means the index is not asked for a prefix that the reader
 * is midway through changing their mind about.
 */
const INPUT_DEBOUNCE_MS = 200;

export function initSearch(): void {
  const root = document.querySelector<HTMLElement>("[data-search-root]");
  if (root === null) return;

  const form = root.querySelector<HTMLFormElement>("[data-search-form]");
  const input = root.querySelector<HTMLInputElement>("[data-search-input]");
  const status = root.querySelector<HTMLElement>("[data-search-status]");
  const resultsList = root.querySelector<HTMLElement>("[data-search-results]");
  const fallback = root.querySelector<HTMLElement>("[data-search-fallback]");

  if (
    form === null ||
    input === null ||
    status === null ||
    resultsList === null
  )
    return;

  // With the script running, the no-JavaScript advice is wrong and is removed.
  fallback?.remove();

  const hasContent = readSiteHasContent();

  let pagefind: PagefindModule | null = null;
  let loading: Promise<PagefindModule | null> | null = null;

  /**
   * The newest query, and the only one whose answer is allowed on screen.
   *
   * A query is not one await but three — the index load, the search, and one
   * `data()` per result — and the time each takes depends on the words being
   * searched, not on the order they were typed. So responses genuinely do arrive
   * out of order: type one more character while a slower query is still running
   * and the older answer lands last, replacing the newer one. The reader then
   * sees results for a keyword the field no longer contains, and the status line
   * names that stale keyword back at them.
   *
   * Every query takes a ticket before its first await and checks it after each
   * one; only the newest ticket may render, announce, or report an error.
   */
  let newestQuery = 0;

  /** Claim the newest ticket: any query already in flight becomes stale. */
  const beginQuery = (): number => {
    newestQuery += 1;
    return newestQuery;
  };

  const isCurrent = (ticket: number): boolean => ticket === newestQuery;

  const setStatus = (next: Status, message?: string): void => {
    root.dataset["status"] = next;
    status.textContent = message ?? "";
    status.hidden = message === undefined || message.length === 0;
  };

  const loadIndex = async (): Promise<PagefindModule | null> => {
    if (!hasContent) {
      setStatus("no-index", EMPTY_MESSAGES["no-index"]);
      return null;
    }
    if (pagefind !== null) return pagefind;
    if (loading !== null) return loading;

    loading = (async () => {
      try {
        const module = (await import(
          /* @vite-ignore */ INDEX_PATH
        )) as PagefindModule;
        await module.options?.({ excerptLength: 30 });
        await module.init?.();
        pagefind = module;
        return module;
      } catch (error) {
        // Logged once, without the query: a search term is the reader's own
        // text and does not belong in a console message.
        console.error("Pagefind index could not be loaded.");
        void error;
        setStatus("error", EMPTY_MESSAGES["error"]);
        return null;
      }
    })();

    return loading;
  };

  const render = (
    items: readonly PagefindResultData[],
    query: string,
  ): void => {
    resultsList.replaceChildren();

    for (const item of items) {
      const li = document.createElement("li");
      li.className = "search-result";

      const link = document.createElement("a");
      link.className = "search-result__link";
      link.href = item.url;

      const title = document.createElement("h2");
      title.className = "search-result__title";
      title.textContent = item.meta?.["title"] ?? item.url;
      link.append(title);

      const excerpt = document.createElement("p");
      excerpt.className = "search-result__excerpt";
      excerpt.append(safeExcerpt(item.excerpt));

      const meta = document.createElement("p");
      meta.className = "search-result__meta";
      const date = item.meta?.["date"];
      const tags = item.meta?.["tags"];
      meta.textContent = [date, tags]
        .filter((part) => part !== undefined)
        .join(" · ");

      li.append(link, meta);
      resultsList.append(li);
    }

    setStatus("results", `找到 ${items.length} 条结果（关键词：${query}）。`);
  };

  const run = async (rawQuery: string): Promise<void> => {
    const query = rawQuery.trim();
    // Claimed before the early return, so clearing the field also invalidates
    // whatever is still in flight: an answer about to arrive must not repaint a
    // box the reader has just emptied.
    const ticket = beginQuery();

    if (query.length === 0) {
      resultsList.replaceChildren();
      setStatus("initial", EMPTY_MESSAGES["blank"]);
      return;
    }

    setStatus("loading", "正在搜索…");
    const module = await loadIndex();
    if (module === null) return;
    // The index can take a moment on a cold cache; a newer query may have
    // started while this one waited for it.
    if (!isCurrent(ticket)) return;

    try {
      const found = await module.search(query);
      const data = await Promise.all(
        found.results.map((result) => result.data()),
      );
      if (!isCurrent(ticket)) return;

      if (data.length === 0) {
        resultsList.replaceChildren();
        setStatus("empty", EMPTY_MESSAGES["none"]);
        return;
      }
      render(data, query);
    } catch {
      // A failed query that has already been superseded must not replace a
      // newer query's results with an error message.
      if (!isCurrent(ticket)) return;
      resultsList.replaceChildren();
      setStatus("error", EMPTY_MESSAGES["error"]);
    }
  };

  /** Cancel a debounced query that has not been issued yet. */
  let pending: number | undefined;
  const cancelPending = (): void => {
    if (pending === undefined) return;
    window.clearTimeout(pending);
    pending = undefined;
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    // Submitting is an explicit "search now": the debounce is for typing, and
    // letting it fire afterwards would issue a second, identical query.
    cancelPending();
    void run(input.value);
  });

  input.addEventListener("input", () => {
    cancelPending();
    pending = window.setTimeout(() => {
      pending = undefined;
      void run(input.value);
    }, INPUT_DEBOUNCE_MS);
  });

  resultsList.addEventListener("keydown", (event) => {
    const links = [
      ...resultsList.querySelectorAll<HTMLAnchorElement>(
        ".search-result__link",
      ),
    ];
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (index === -1) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        links[(index + 1) % links.length]?.focus();
        break;
      case "ArrowUp":
        event.preventDefault();
        links[(index - 1 + links.length) % links.length]?.focus();
        break;
      case "Escape":
        // Clearing must not move the reader's focus out of the field.
        event.preventDefault();
        input.value = "";
        cancelPending();
        // The reader has emptied the box; a query still running would repaint it
        // with results for text that is no longer there.
        beginQuery();
        resultsList.replaceChildren();
        setStatus("initial", EMPTY_MESSAGES["blank"]);
        input.focus();
        break;
      default:
        break;
    }
  });

  // `?q=` is read so a shared or reloaded URL restores the search.
  const params = new URLSearchParams(window.location.search);
  const initial = params.get("q");
  if (initial !== null && initial.length > 0) {
    input.value = initial;
    void run(initial);
  } else {
    setStatus("initial", "输入关键词以搜索站内文章与页面。");
  }

  if (params.get("focus") === "1") {
    input.focus();
  }
}
