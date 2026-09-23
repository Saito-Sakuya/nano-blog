/**
 * Progressive enhancement for embedded media and tabbed content.
 *
 * Both features are complete without JavaScript:
 * a video renders as a poster, its title, the provider's name and an ordinary
 * external link; a tab group renders as a sequence of labelled sections. This
 * script upgrades each of them, and if it never runs nothing is hidden.
 */

import { announce } from "./article.js";

/* -------------------------------------------------------------------------- */
/* Video                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Replace the poster with the provider's player, once and only once, and only
 * after the reader has asked for it. The iframe attributes are fixed here —
 * they are not read from the document — so a manipulated page cannot loosen
 * the sandbox.
 */
function initVideoEmbeds(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-video-load]",
  )) {
    button.addEventListener(
      "click",
      () => {
        const src = button.dataset["videoSrc"];
        const allow = button.dataset["videoAllow"];
        const title = button.dataset["videoTitle"];
        const provider = button.dataset["videoProvider"];
        if (src === undefined || title === undefined) return;

        const frame = button.closest(".embed__frame");
        if (frame === null) return;

        const iframe = document.createElement("iframe");
        iframe.src = src;
        iframe.title = title;
        iframe.loading = "lazy";
        iframe.referrerPolicy = "strict-origin-when-cross-origin";
        iframe.setAttribute(
          "sandbox",
          "allow-scripts allow-same-origin allow-presentation",
        );
        iframe.setAttribute("allowfullscreen", "");
        if (allow !== undefined) iframe.setAttribute("allow", allow);

        frame.replaceChildren(iframe);

        /*
         * Focus follows the player.
         *
         * The button the reader just activated is gone — `replaceChildren` took
         * it out with the poster — so without this the browser drops focus to
         * `<body>`, and a reader who pressed Enter to load the video is sent back
         * to the top of the document on their next Tab with nothing to say what
         * happened. An iframe is focusable, so it is where the next Tab belongs;
         * `preventScroll` because the frame is already where the reader is
         * looking and focusing it must not move the page.
         */
        iframe.focus({ preventScroll: true });

        /*
         * Announced through the page's one live region, which clears itself
         * before writing: two embeds in the same article announce the same
         * sentence, and writing that sentence twice without a clear in between is
         * a change no screen reader reports.
         */
        if (provider !== undefined) announce(`已连接 ${provider} 播放器`);
      },
      { once: true },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Tabs                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Turn the sequential fallback markup into a real tablist.
 *
 * The ARIA shape is the standard one: a `tablist` of `tab` buttons controlling
 * `tabpanel`s, arrow keys to move, Home/End to jump, and only the selected
 * panel rendered visible.
 */
function initTabs(): void {
  let groupIndex = 0;

  for (const group of document.querySelectorAll<HTMLElement>("[data-tabs]")) {
    const items = [...group.querySelectorAll<HTMLElement>("[data-tab-item]")];

    /*
     * Decide before touching anything.
     *
     * A tab is only a tab when both halves are there, and the completeness check
     * has to happen before the first mutation. Done the other way round — remove
     * each label as its item is processed, then ask how many tabs were built —
     * a group whose second item was missing its panel came out with the first
     * item's label deleted, no tablist put in its place and a panel nothing
     * named: strictly worse than the fallback it started from, and that fallback
     * is what a reader with script gets instead of the real thing. An incomplete
     * group is now left exactly as authored, labels and all.
     */
    const entries: {
      readonly label: HTMLElement;
      readonly panel: HTMLElement;
    }[] = [];
    for (const item of items) {
      const label = item.querySelector<HTMLElement>("[data-tab-label]");
      const panel = item.querySelector<HTMLElement>("[data-tab-panel]");
      if (label !== null && panel !== null) entries.push({ label, panel });
    }
    if (entries.length < 2) continue;

    groupIndex += 1;
    const groupLabel = group.dataset["tabsLabel"] ?? "选项卡";

    const tablist = document.createElement("div");
    tablist.className = "tabs__tablist";
    tablist.setAttribute("role", "tablist");
    tablist.setAttribute("aria-label", groupLabel);

    const tabs: HTMLButtonElement[] = [];
    const panels: HTMLElement[] = [];

    entries.forEach(({ label, panel }, index) => {
      const tabId = `tab-${groupIndex}-${index + 1}`;
      const panelId = `panel-${groupIndex}-${index + 1}`;

      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "tabs__tab";
      tab.id = tabId;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", panelId);
      tab.setAttribute("aria-selected", index === 0 ? "true" : "false");
      // Only the selected tab stays in the tab order; arrows move between them.
      tab.tabIndex = index === 0 ? 0 : -1;
      tab.textContent = label.textContent ?? "";
      tabs.push(tab);
      tablist.append(tab);

      panel.id = panelId;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tabId);
      panel.hidden = index !== 0;
      panels.push(panel);

      // The visible heading has been superseded by the tab itself.
      label.remove();
    });

    const select = (next: number): void => {
      tabs.forEach((tab, index) => {
        const selected = index === next;
        tab.setAttribute("aria-selected", String(selected));
        tab.tabIndex = selected ? 0 : -1;
      });
      panels.forEach((panel, index) => {
        panel.hidden = index !== next;
      });
      tabs[next]?.focus();
    };

    /**
     * This group's position for a node, or -1 when the node is not one of its
     * tabs. `Element` in and `number` out, so neither caller needs a cast: the
     * keyboard handler passes `document.activeElement`, the click handler passes
     * whatever `closest` found.
     */
    const indexOfTab = (node: Element | null): number =>
      node === null ? -1 : tabs.findIndex((tab) => tab === node);

    tablist.addEventListener("keydown", (event) => {
      const current = indexOfTab(document.activeElement);
      if (current === -1) return;

      switch (event.key) {
        case "ArrowRight":
          event.preventDefault();
          select((current + 1) % tabs.length);
          break;
        case "ArrowLeft":
          event.preventDefault();
          select((current - 1 + tabs.length) % tabs.length);
          break;
        case "Home":
          event.preventDefault();
          select(0);
          break;
        case "End":
          event.preventDefault();
          select(tabs.length - 1);
          break;
        default:
          break;
      }
    });

    /*
     * Pointer activation.
     *
     * The keyboard handler above covers arrow navigation, but nothing listened
     * for a click, so pressing a tab moved focus onto it and changed nothing —
     * the first panel stayed visible and the second could never be reached.
     * A click on a <button> also covers Enter and Space, since the browser
     * synthesises a click for those keys, so this single listener is the whole
     * activation path.
     *
     * `closest` rather than the event target itself, so a click on anything
     * inside a tab still resolves to that tab; the -1 guard covers a click
     * landing on the tablist own padding.
     */
    tablist.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const index = indexOfTab(target.closest('[role="tab"]'));
      if (index === -1) return;
      select(index);
    });

    group.prepend(tablist);
    group.dataset["enhanced"] = "true";
  }
}

export function initEmbeds(): void {
  initVideoEmbeds();
  initTabs();
}
