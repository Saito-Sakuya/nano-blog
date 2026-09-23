/**
 * Article page interactions.
 *
 * Everything here is enhancement: with JavaScript switched off the article is
 * still readable, the table of contents is still a working list of anchors, the
 * code is still visible and the share control simply falls back to a link.
 *
 * All of it lives in one module so an article page loads one small script
 * rather than several.
 */

/* -------------------------------------------------------------------------- */
/* Live region                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A single polite live region for the whole page. Several features need to
 * announce something (a copy, a share, a player being connected) and sharing one
 * region avoids the screen reader having to watch several.
 *
 * Exported because the other page scripts own features that need to announce
 * too. A private copy in each of them is how the "clear first" trick below gets
 * lost: writing the same message twice in a row is then a no-op the screen
 * reader never reports, while this one re-announces it.
 */
export function announce(message: string): void {
  const region = document.querySelector<HTMLElement>("[data-live-region]");
  if (region === null) return;
  // Clearing first makes a repeated identical message announce again.
  region.textContent = "";
  window.setTimeout(() => {
    region.textContent = message;
  }, 30);
}

/* -------------------------------------------------------------------------- */
/* Copy to clipboard                                                           */
/* -------------------------------------------------------------------------- */

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard access can be denied or unavailable; fall back to a selection.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

function initCodeCopy(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "[data-copy-code]",
  )) {
    button.addEventListener("click", async () => {
      const wrapper = button.closest<HTMLElement>("[data-code-block]");
      const code = wrapper?.querySelector("code");
      const status = wrapper?.querySelector<HTMLElement>("[data-copy-status]");
      if (code === null || code === undefined) return;

      const ok = await copyText(code.textContent ?? "");

      if (ok) {
        button.textContent = "已复制";
        if (status !== null && status !== undefined) status.textContent = "";
        announce("代码已复制");
        window.setTimeout(() => {
          button.textContent = "复制";
        }, 2000);
        return;
      }

      // Failure must still leave the reader able to copy by hand, so the code
      // is selected for them rather than only reported as broken.
      const selection = window.getSelection();
      if (selection !== null) {
        const range = document.createRange();
        range.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (status !== null && status !== undefined) {
        status.textContent = "复制失败，请手动复制";
      }
      announce("复制失败，请手动复制");
    });
  }
}

/**
 * The address a copied link should use.
 *
 * The canonical URL, not `window.location`. A preview deployment, a local
 * preview server or a URL with tracking parameters would otherwise be what the
 * reader shares, and an anchor is meant to copy the
 * canonical URL plus the fragment.
 */
function canonicalBase(): string {
  const article = document.querySelector<HTMLElement>("[data-canonical-url]");
  const canonical = article?.dataset["canonicalUrl"];
  return canonical !== undefined && canonical.length > 0
    ? canonical
    : window.location.href;
}

/* -------------------------------------------------------------------------- */
/* Heading anchors                                                             */
/* -------------------------------------------------------------------------- */

function initHeadingAnchors(): void {
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>(
    "[data-heading-anchor]",
  )) {
    anchor.addEventListener("click", (event) => {
      // The link still works without this: it is a real fragment link.
      event.preventDefault();

      const id = anchor.dataset["headingAnchor"];
      if (id === undefined) return;

      // The address bar keeps the URL actually being viewed, so following the
      // link stays within this deployment; the clipboard gets the canonical
      // address, which is the one worth sharing.
      const viewed = new URL(window.location.href);
      viewed.hash = id;
      history.replaceState(null, "", viewed.toString());

      const canonical = new URL(canonicalBase());
      canonical.hash = id;

      void copyText(canonical.toString()).then((ok) => {
        announce(ok ? "本节链接已复制" : "复制失败，请手动复制地址栏链接");
      });
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Table of contents                                                           */
/* -------------------------------------------------------------------------- */

function initToc(): void {
  const toc = document.querySelector<HTMLElement>("[data-toc]");
  if (toc === null) return;

  const links = [...toc.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')];
  if (links.length === 0) return;

  const targets = links
    .map((link) => {
      const id = decodeURIComponent((link.getAttribute("href") ?? "").slice(1));
      const element = document.getElementById(id);
      return element === null ? null : { link, element };
    })
    .filter(
      (entry): entry is { link: HTMLAnchorElement; element: HTMLElement } =>
        entry !== null,
    );

  if (targets.length === 0) return;

  const setCurrent = (active: HTMLElement | null): void => {
    for (const { link, element } of targets) {
      if (element === active) {
        link.setAttribute("aria-current", "true");
      } else {
        link.removeAttribute("aria-current");
      }
    }
  };

  /*
   * The band is a thin strip a fifth of the way down the viewport. A heading
   * becomes the current section when it crosses that strip, and it *stays*
   * current until another heading does the same.
   *
   * Clearing the mark on exit — the obvious reading of "is it intersecting?" —
   * means nothing is ever marked once a heading has scrolled past, because the
   * reader is then below every heading rather than inside one.
   */
  const observer = new IntersectionObserver(
    (entries) => {
      // Entries arrive in document order; within one callback the last heading
      // to enter the band is the one the reader has reached.
      let next: HTMLElement | null = null;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        next = entry.target as HTMLElement;
      }
      if (next !== null) setCurrent(next);
    },
    // A band a tenth of the viewport tall, starting a fifth of the way
    // down. A zero-height band fires too unpredictably to rely on.
    { rootMargin: "-20% 0px -70% 0px", threshold: 0 },
  );

  for (const { element } of targets) observer.observe(element);

  /**
   * Seed the mark from the current scroll position.
   *
   * The observer only fires when a heading *crosses* the band, so a reader who
   * loads a page, follows a fragment link or reloads mid-article would
   * otherwise see nothing marked until they scrolled.
   */
  const seedFromScroll = (): void => {
    const line = window.innerHeight * 0.2;
    let active: HTMLElement | null = null;
    for (const { element } of targets) {
      if (element.getBoundingClientRect().top <= line) active = element;
      else break;
    }
    setCurrent(active);
  };

  seedFromScroll();
}

/* -------------------------------------------------------------------------- */
/* Share                                                                       */
/* -------------------------------------------------------------------------- */

function initShare(): void {
  const container = document.querySelector<HTMLElement>("[data-share]");
  if (container === null) return;

  const copyButton =
    container.querySelector<HTMLButtonElement>("[data-share-copy]");
  const nativeButton = container.querySelector<HTMLButtonElement>(
    "[data-share-native]",
  );

  copyButton?.addEventListener("click", () => {
    void copyText(canonicalBase()).then((ok) => {
      announce(ok ? "链接已复制" : "复制失败，请手动复制地址栏链接");
      if (copyButton !== null) {
        const original = copyButton.textContent;
        copyButton.textContent = ok ? "已复制" : "复制失败";
        window.setTimeout(() => {
          copyButton.textContent = original;
        }, 2000);
      }
    });
  });

  // The native share control only exists when the platform provides it. On a
  // browser without it the copy action above remains the whole feature.
  if (nativeButton === null) return;
  if (typeof navigator.share !== "function") {
    nativeButton.remove();
    return;
  }

  nativeButton.addEventListener("click", () => {
    void navigator
      .share({ title: document.title, url: canonicalBase() })
      .catch((error: unknown) => {
        // A cancelled share is a normal outcome, not an error worth reporting.
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        announce("分享失败，可改用复制链接");
      });
  });
}

/* -------------------------------------------------------------------------- */
/* Back to top                                                                 */
/* -------------------------------------------------------------------------- */

function initBackToTop(): void {
  const button =
    document.querySelector<HTMLButtonElement>("[data-back-to-top]");
  if (button === null) return;

  const threshold = window.innerHeight * 1.5;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const update = (): void => {
    button.hidden = window.scrollY <= threshold;
  };

  button.addEventListener("click", () => {
    window.scrollTo({
      top: 0,
      behavior: reduceMotion.matches ? "auto" : "smooth",
    });
    /*
     * Returning focus to the top of the document is what makes this usable from
     * the keyboard — but it must not move the viewport itself.
     *
     * `#main` wraps the whole page, so it is much taller than the viewport.
     * Focusing it without `preventScroll` asks the browser to scroll it into
     * view, and for an element taller than the scrollport that means aligning
     * its *end* edge: measured from the bottom of an article page, the click
     * landed with the comments section at the top of the screen (scrollY 4714 →
     * 4625, comments at y=96) instead of the document top. The reader saw a jump
     * to the comments, not to the top.
     *
     * The `scrollTo` above already decides where the viewport goes; this only has
     * to decide where focus goes, so it opts out of scrolling entirely.
     */
    document
      .querySelector<HTMLElement>("#main")
      ?.focus({ preventScroll: true });
  });

  window.addEventListener("scroll", update, { passive: true });
  update();
}

/* -------------------------------------------------------------------------- */
/* Sidenotes on narrow screens                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Number every sidenote in document order.
 *
 * Both the Markdown directive and the MDX component emit an unnumbered
 * `<aside class="sidenote">`; this is the single place the number is decided,
 * so the two spellings cannot end up numbered by different rules. The number
 * is what the narrow-screen disclosure and the print stylesheet read.
 */
function initSidenoteNumbering(): void {
  const notes = document.querySelectorAll<HTMLElement>("aside.sidenote");
  notes.forEach((note, index) => {
    const number = String(index + 1);
    note.dataset["sidenote"] = number;
    if (!note.id) note.id = `sidenote-${number}`;

    const marker = note.querySelector<HTMLElement>(".sidenote__marker");
    if (marker !== null && marker.textContent?.trim() === "") {
      marker.textContent = number;
    }
  });
}

/* -------------------------------------------------------------------------- */
/* Floating rails                                                              */
/* -------------------------------------------------------------------------- */

/** The breakpoint at which the three-column layout takes over. */
const WIDE = "(min-width: 75rem)";

/**
 * Where each note was before it was moved into the drawer, and the two controls
 * that now point at it.
 *
 * A reader can rotate a tablet or resize a window across the breakpoint, and the
 * layout has to survive that in both directions: the notes must return to the
 * exact place in the prose they came from, not to the end of the article.
 */
interface SidenoteHome {
  readonly note: HTMLElement;
  readonly parent: Node;
  /** The reference left behind, which the note is inserted before on the way back. */
  readonly next: Node;
  /** The same reference, kept so it can be removed. */
  readonly ref: HTMLElement;
  /** The marker in the right margin, which is the visible way in. */
  readonly chip: HTMLElement;
}

const sidenoteHomes: SidenoteHome[] = [];

/** The attribute and the number a note is addressed by, from either control. */
function sidenoteTarget(element: HTMLElement): string | null {
  const declared = element.dataset["sidenoteTarget"];
  if (declared !== undefined && declared !== "") return declared;
  const href = element.getAttribute("href") ?? "";
  return href.startsWith("#") ? decodeURIComponent(href.slice(1)) : null;
}

/**
 * Leave a numbered reference where a note used to be.
 *
 * It is a real `<a href="#sidenote-N">`, not a button with a click handler, so
 * the target still exists when the panel is shut, when script has not run and in
 * print. Opening the panel first is an enhancement the listener adds; the link
 * works without it.
 */
function createSidenoteRef(note: HTMLElement, number: string): HTMLElement {
  const ref = document.createElement("a");
  ref.className = "sidenote-ref";
  ref.href = `#${note.id}`;
  ref.textContent = number;
  ref.setAttribute("aria-label", `查看边注 ${number}`);
  return ref;
}

/**
 * The marker in the right margin: the visible way into a note.
 *
 * The reference in the prose is a real link and always was, but a `[1]` inside a
 * sentence does not read as "there is something over here" — the maintainer
 * reported the note as invisible while the reference worked. This is the
 * affordance that was missing, sitting where the note itself would be on a wide
 * screen, and it is what the reader is meant to notice.
 *
 * A `<button>`, because it opens something rather than navigating: the `<a>` in
 * the prose already carries the link for anyone who wants one. `aria-controls`
 * and `aria-expanded` are kept honest by the script, and since the chip is
 * hidden while its drawer is open, `aria-expanded="false"` is always accurate
 * whenever it is on screen.
 *
 * `drawerId` is read off the drawer element rather than written here. An
 * `aria-controls` is an IDREF: it resolves to nothing unless the element it
 * names exists with exactly that id, and a dangling IDREF is worse than no
 * attribute — it promises a relationship assistive technology then cannot
 * follow. Taking the id from the element that is actually on the page is the
 * only version of this that cannot drift.
 */
function createSidenoteChip(
  note: HTMLElement,
  number: string,
  drawerId: string | null,
): HTMLElement {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "sidenote-chip";
  chip.textContent = `边注 ${number}`;
  chip.dataset["sidenoteTarget"] = note.id;
  chip.setAttribute("aria-label", `查看边注 ${number}`);
  chip.setAttribute("aria-expanded", "false");
  if (drawerId !== null) chip.setAttribute("aria-controls", drawerId);
  return chip;
}

/**
 * Line each chip up with the reference it belongs to.
 *
 * Same article-relative arithmetic as the drawer, so the chips track their
 * references while the page scrolls without a scroll listener: they are measured
 * from the article, and scrolling moves the article.
 *
 * The chip is centred on its reference rather than hung below it, because a
 * marker level with the line it annotates reads as belonging to that line. That
 * means both centres, not the reference's top edge and the chip's middle: the
 * reference is a small box of its own, and aligning the two tops leaves the chip
 * half a reference high. Measured at 11px — half of the reference's 22px — which
 * is exactly the amount that reads as "slightly off" without being nameable.
 */
function positionSidenoteChips(): void {
  const layout = document.querySelector<HTMLElement>(".article-layout");
  if (layout === null) return;
  const layoutTop = layout.getBoundingClientRect().top;

  for (const home of sidenoteHomes) {
    const refRect = home.ref.getBoundingClientRect();
    const refCentre = refRect.top + refRect.height / 2;
    const top = refCentre - layoutTop - home.chip.offsetHeight / 2;
    home.chip.style.setProperty(
      "--sidenote-chip-top",
      `${Math.round(Math.max(0, top))}px`,
    );
  }
}

/** Keeps a lifted drawer clear of the bottom edge of the screen. */
const DRAWER_EDGE_GAP = 8;

/**
 * Anchor the note drawer to the reference that opened it.
 *
 * The offset is measured against the *article*, not the viewport, because the
 * drawer is `position: absolute` inside the article: scroll and it travels with
 * the paragraph it belongs to, which is what a note is. That is also the whole
 * answer to crowding — a page with a dozen notes shows the one that was opened
 * and nothing else, because the others are shut and this one leaves the screen
 * along with its own paragraph.
 *
 * The two rectangles are read in the same frame and subtracted, so the scroll
 * position cancels out: this works identically at the top of the article and
 * two thousand pixels down it, and a reader who scrolls and then opens a note
 * gets the same result as one who opens it without scrolling.
 *
 * The summary sits above the reference rather than over it, so the mark the
 * reader just clicked is never covered by the drawer's own header.
 *
 * A note whose reference is near the bottom of the screen cannot have the drawer
 * level with it *and* show the drawer, so the placement gives ground: it is
 * lifted just enough to fit. Measured, a note at 90% of the viewport left about
 * 130px of a 192px drawer off screen, which reads as having opened nothing. The
 * drawer is bounded by the stylesheet to less than a viewport, so this lift
 * always suffices; where the lift would pass the top of the article it is
 * clamped, and the drawer simply sits as close as it can.
 */
function placeSidenoteRail(
  rail: HTMLDetailsElement,
  anchor: HTMLElement | null,
): void {
  if (anchor === null) {
    rail.style.removeProperty("--sidenote-rail-top");
    return;
  }

  const layout = rail.closest<HTMLElement>(".article-layout");
  if (layout === null) return;

  const summary = rail.querySelector<HTMLElement>("summary");
  const summaryHeight = summary === null ? 0 : summary.offsetHeight;

  const layoutTop = layout.getBoundingClientRect().top;
  let top = anchor.getBoundingClientRect().top - layoutTop - summaryHeight;

  // Where that offset puts the drawer on screen, and whether it fits there.
  const overflow =
    layoutTop +
    top +
    rail.offsetHeight -
    (window.innerHeight - DRAWER_EDGE_GAP);
  if (overflow > 0) top -= overflow;

  rail.style.setProperty(
    "--sidenote-rail-top",
    `${Math.round(Math.max(0, top))}px`,
  );
}

/**
 * Bring a note to the top of the panel.
 *
 * `scrollIntoView` was what this did before the panel could be parked, and it is
 * the wrong tool now: it scrolls the nearest scrollable ancestor *and* can move
 * the document, which would undo the placement. Scrolling the panel's own
 * `scrollTop` moves the note and nothing else. The padding is subtracted because
 * the panel is scrolled from the inside of its own padding box, and leaving it
 * in would tuck the note's first line under the panel's edge.
 */
function scrollPanelToNote(panel: HTMLElement, note: HTMLElement): void {
  const offset =
    note.getBoundingClientRect().top -
    panel.getBoundingClientRect().top -
    Number.parseFloat(getComputedStyle(panel).paddingBlockStart || "0");
  if (offset !== 0) panel.scrollTop += offset;
}

/**
 * Put the notes in the right-hand drawer, or back where they were.
 *
 * Below the wide breakpoint there is no margin for a note to sit in, so instead
 * of shrinking every note into an inline disclosure — which pushed the prose
 * around and buried the note in the paragraph — the notes move into a drawer
 * anchored to the right edge and leave a numbered reference behind. The drawer
 * is the same idea as the contents rail on the left: the margin the wide layout
 * uses, folded into a drawer. The difference is that it is opened from the note's
 * own reference and anchored to it, rather than hanging in the corner.
 *
 * Above the breakpoint the notes return to the prose and float in the margin as
 * before, and the references go away. Both directions matter: a layout that only
 * works on the way in leaves a rotated tablet with its notes in a drawer.
 */
function layoutSidenotes(floating: boolean): void {
  const rail = document.querySelector<HTMLDetailsElement>(
    "[data-sidenote-rail]",
  );
  const panel = document.querySelector<HTMLElement>("[data-sidenote-panel]");
  if (rail === null || panel === null) return;

  if (floating) {
    const notes = document.querySelectorAll<HTMLElement>("aside.sidenote");

    notes.forEach((note, index) => {
      // Already moved: this runs again on every breakpoint change, and a note
      // that has been moved must not be moved a second time.
      if (note.parentElement === panel) return;

      const label = note.dataset["sidenote"] ?? String(index + 1);
      const parent = note.parentNode;
      if (parent === null) return;

      const ref = createSidenoteRef(note, label);
      parent.insertBefore(ref, note);

      /*
       * The chip goes directly after the reference, not at the end of the layout.
       *
       * It is `position: absolute`, so its containing block is the layout either
       * way and the placement is unaffected — but DOM order is tab order, and a
       * chip parked after the whole article would be reachable only by tabbing
       * through every link in the prose. Measured: forty tabs did not reach it.
       * Beside its reference it is where a reader working through the article in
       * order would expect it, which is also where the reference already is.
       */
      const chip = createSidenoteChip(
        note,
        label,
        rail.id === "" ? null : rail.id,
      );
      parent.insertBefore(chip, note);

      sidenoteHomes.push({ note, parent, next: ref, ref, chip });
      panel.append(note);
    });

    // Measured after the chips are in the document, since the offset depends on
    // their own height.
    positionSidenoteChips();

    const count = document.querySelector<HTMLElement>("[data-sidenote-count]");
    if (count !== null) count.textContent = String(notes.length);
    /*
     * Always hidden, even on a page that has notes. The drawer is opened from a
     * reference or a chip and closed again; a closed one is not a collapsed tab
     * anywhere, so it must not be painted at all.
     */
    rail.hidden = true;
    return;
  }

  /*
   * Back to the prose.
   *
   * Notes are inserted before the reference that replaced each of them, so the
   * original order returns without needing to record it separately. Reversed,
   * because each note and its reference were pushed in document order and the
   * last moved has to be the first put back.
   */
  for (const home of [...sidenoteHomes].reverse()) {
    if (home.parent.isConnected) {
      home.parent.insertBefore(home.note, home.next);
    }
    home.ref.remove();
    home.chip.remove();
  }
  sidenoteHomes.length = 0;

  rail.hidden = true;
  rail.open = false;
  // The measured anchor offset is cleared by `apply`, which is the only caller:
  // one place owns that state rather than two that agree.
}

/**
 * Keep the contents tab, the note drawer and the breakpoint in step.
 *
 * Every rule for both is scoped to `[data-floating-rails]` on the layout, so
 * clearing the attribute restores the plain in-flow layout — which is what a
 * reader without script sees, and what print gets. The attribute is only set
 * when the drawers are actually positioned, so there is no state in which one is
 * placed on the screen without script having put it there.
 */
function initRails(): void {
  const layout = document.querySelector<HTMLElement>(".article-layout");
  if (layout === null) return;

  const wide = window.matchMedia(WIDE);
  const toc = document.querySelector<HTMLDetailsElement>("[data-toc]");
  const sidenoteRail = document.querySelector<HTMLDetailsElement>(
    "[data-sidenote-rail]",
  );
  const panel = document.querySelector<HTMLElement>("[data-sidenote-panel]");

  /** What each panel was before a print, so printing changes nothing durable. */
  const previousOpenState = new Map<
    HTMLDetailsElement,
    { readonly open: boolean; readonly hidden: boolean }
  >();

  /** The reference the drawer is currently anchored to, if any. */
  let anchor: HTMLElement | null = null;

  /** The control that opened the drawer, so focus can be given back on close. */
  let lastTrigger: HTMLElement | null = null;

  /**
   * Keep each chip in step with whether its own drawer is open.
   *
   * A chip is the way in, so it has no business being on screen while the thing
   * it opens is; equally it has to come back the moment the drawer closes, or
   * the note becomes unreachable from the margin.
   */
  const syncChips = (): void => {
    const openTarget =
      sidenoteRail !== null && sidenoteRail.open && anchor !== null
        ? sidenoteTarget(anchor)
        : null;
    for (const home of sidenoteHomes) {
      const isOpen = openTarget !== null && home.note.id === openTarget;
      home.chip.hidden = isOpen;
      home.chip.setAttribute("aria-expanded", isOpen ? "true" : "false");
    }
  };

  /**
   * Open one drawer and close the other: at 360px they overlap otherwise.
   *
   * Called when the *reader* opens one, and deliberately not from the `toggle`
   * event, which fires for every programmatic open as well. The distinction is
   * not academic: printing opens both (see `beforeprint` below), and driving
   * exclusivity from `toggle` meant the second one opened shut the first again.
   * Measured, a narrow page printed with the notes missing and a wide one
   * printed without its contents list. Exclusivity is about what the reader has
   * on screen; print is not.
   */
  const openExclusively = (target: HTMLDetailsElement): void => {
    for (const rail of [toc, sidenoteRail]) {
      if (rail !== null && rail !== target) rail.open = false;
    }
  };

  /*
   * The contents tab is a click on its summary, which is also what a keyboard
   * activation produces: a focused summary opened with Enter or Space dispatches
   * a click. The default action toggles the details after this listener runs, so
   * the panel being opened does not read as open yet — which is why this is a
   * click listener and not a check for `open`.
   */
  toc?.querySelector("summary")?.addEventListener("click", () => {
    openExclusively(toc);
  });

  /**
   * Show the drawer at a control, with the named note scrolled into view.
   *
   * `hidden` comes off before `open` goes on, and both are needed: the drawer is
   * `hidden` whenever it is closed — a closed one is not a collapsed tab
   * anywhere — and a `<details>` that is merely closed would still paint its
   * summary as a stray label.
   *
   * Focus is moved into the drawer, but only when the control that opened it has
   * just been taken off the screen. A chip hides while its drawer is open — the
   * drawer's own header takes its place — and hiding the focused element makes
   * the browser drop focus to the body, which would strand a keyboard reader at
   * the top of the document with no indication that anything opened. A reference
   * stays where it is, so opening from one leaves focus alone, where the reader
   * put it.
   */
  const showNote = (trigger: HTMLElement, note: HTMLElement | null): void => {
    if (sidenoteRail === null) return;
    if (toc !== null) openExclusively(sidenoteRail);

    sidenoteRail.hidden = false;
    sidenoteRail.open = true;
    anchor = trigger;
    lastTrigger = trigger;
    placeSidenoteRail(sidenoteRail, trigger);
    if (panel !== null && note !== null) scrollPanelToNote(panel, note);
    syncChips();

    // A chip has just been hidden by `syncChips`, taking the reader's focus with
    // it, so it moves into the drawer. A reference is still on screen, so focus
    // stays where the reader put it and there is nothing to restore later.
    // `hasAttribute` rather than the `hidden` property, which the DOM types widen
    // to `boolean | "until-found"`.
    drawerTookFocus = trigger.hasAttribute("hidden");
    if (drawerTookFocus) {
      sidenoteRail.querySelector<HTMLElement>("summary")?.focus({
        preventScroll: true,
      });
    }
  };

  /**
   * Whether opening the drawer took the reader's focus with it.
   *
   * Decided when the drawer opens, not when it closes, and the difference is the
   * whole reason this is a stored flag. Opening a chip hides the chip — the
   * drawer's header takes its place — so focus has to be moved into the drawer or
   * the browser drops it to the body. That is the only case where anything needs
   * handing back, and asking at close time cannot tell: a click on blank space
   * blurs to the body on `mousedown`, so by the time the click handler runs the
   * drawer has already lost the focus it needs to restore. Measured — the first
   * version did ask at close time, and did lose it.
   *
   * A reference is different: focus stays on it, since it is still on screen, so
   * there is nothing to restore and the reader's place is already theirs.
   */
  let drawerTookFocus = false;

  /** Set when a close should hand focus back, acted on by the `toggle` handler. */
  let restoreFocusOnClose = false;

  /**
   * Take the drawer off the screen, and remember to give focus back.
   *
   * A focusable element inside a closed `<details>` leaves the tab order, so a
   * keyboard reader's focus would be dropped at the top of the document. The
   * hand-back itself happens in the `toggle` handler, which is the first moment
   * the control it came from is on screen again — closing a `<details>` fires
   * `toggle` asynchronously, so at this point the chip is still `hidden` and
   * focusing it would do nothing at all.
   */
  const closeNote = (): void => {
    if (sidenoteRail === null || !sidenoteRail.open) return;
    restoreFocusOnClose = drawerTookFocus;
    sidenoteRail.open = false;
  };

  /*
   * Closing takes the drawer off the screen entirely.
   *
   * The reader's own header click lands here, as does `closeNote`; a closed
   * drawer is gone, and the chip or the reference is the way back.
   */
  sidenoteRail?.addEventListener("toggle", () => {
    if (sidenoteRail.open) return;
    anchor = null;
    placeSidenoteRail(sidenoteRail, null);
    sidenoteRail.hidden = true;
    syncChips();

    if (restoreFocusOnClose) {
      restoreFocusOnClose = false;
      drawerTookFocus = false;
      lastTrigger?.focus({ preventScroll: true });
    }
  });

  /**
   * One listener for opening, toggling and dismissing.
   *
   * This has to be a single handler. Two — one for the controls and one for
   * dismissing on an outside click — would each see the same event: the first
   * would open the drawer and the second would immediately close it again,
   * because the click that opened it *is* a click outside the drawer. They
   * cannot be ordered around each other; they have to be the same decision.
   *
   * Three cases, in order:
   *
   *   1. Inside the drawer — nothing. Its own header toggles it, and a click in
   *      the note text is a reader selecting text or following a link in the
   *      note, not a dismissal.
   *   2. On a chip or a reference — open it, or close it if it is the one already
   *      open. Clicking the same control twice is a toggle, which is what every
   *      other disclosure on this site does.
   *   3. Anywhere else — dismiss. This is the missing behaviour the maintainer
   *      reported: there was no way to put the drawer away.
   *
   * The contents tab is not special-cased. Its own listener closes the note
   * drawer through `openExclusively` before this runs, and by the time it does,
   * there is nothing left for case 3 to close.
   *
   * The link's own jump is deliberately stopped. The note is not elsewhere on the
   * page any more: the drawer is anchored to the reference that was clicked, so
   * following the fragment would scroll the article out from under it. With the
   * drawer unusable and script absent the link behaves normally.
   */
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (sidenoteRail === null || panel === null) return;

    if (sidenoteRail.contains(target)) return;

    const chip = target.closest<HTMLElement>(".sidenote-chip");
    const ref = target.closest<HTMLAnchorElement>(".sidenote-ref");
    const trigger = chip ?? ref;

    if (trigger === null) {
      closeNote();
      return;
    }

    // Only the anchor has a default worth stopping; the chip is a `<button>`
    // with no href, and tabindex/type are already set.
    if (ref !== null) event.preventDefault();

    const id = sidenoteTarget(trigger);
    if (id === null) return;

    if (sidenoteRail.open && anchor === trigger) {
      closeNote();
      return;
    }
    showNote(trigger, document.getElementById(id));
  });

  /*
   * Escape closes it too, which is the keyboard equivalent of the click on blank
   * space. Focus goes back to the control that opened it, handled by `closeNote`.
   */
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (sidenoteRail === null || !sidenoteRail.open) return;
    closeNote();
  });

  /**
   * Re-anchor the drawer and the chips, at most once per frame.
   *
   * All of them are anchored to points in the article, so anything that moves
   * those points invalidates the placement. Two things do: a resize, which
   * reflows the prose, and the page still settling — a diagram renders when it
   * scrolls into view, an embed resolves, and the text above the note grows.
   * Measured on the fixture article, its diagram goes from 134 to 379px tall
   * after it is scrolled to, which moves the note's reference 245px down the
   * document.
   *
   * The reader's own scrolling is not in that list, and does not need to be:
   * these offsets are measured against the article rather than the viewport, so
   * scrolling changes nothing about where any of them belongs.
   */
  let repositioning = false;
  const reposition = (): void => {
    if (repositioning) return;
    repositioning = true;
    requestAnimationFrame(() => {
      repositioning = false;
      if (sidenoteRail === null) return;
      positionSidenoteChips();
      if (sidenoteRail.open && anchor !== null) {
        placeSidenoteRail(sidenoteRail, anchor);
      }
    });
  };

  window.addEventListener("resize", reposition);
  /*
   * Re-measure when the article itself grows, which a resize listener cannot
   * see. The article body is what grows, so it is what is observed — and
   * observing it rather than the reference keeps the observer alive across the
   * reference being re-created, which happens every time the breakpoint is
   * crossed.
   *
   * The feature test is not defensive padding. `ResizeObserver` is absent in
   * engines that predate it, and a bare `new ResizeObserver(...)` throws a
   * `ReferenceError` — which, thrown from here, takes the rest of `initRails`
   * with it: `layoutSidenotes` and `apply` never run, so the notes are never
   * moved into the drawer, the chips are never created, and the listeners that
   * open and dismiss the drawer are never attached. Every one of those is
   * independent of whether growth can be observed, so the fallback is to keep
   * them and lose only the re-measurement. Without an observer the drawer is
   * still placed when it opens, which is the case that matters most; what is
   * lost is the correction after a diagram finishes rendering above a note.
   */
  const body = document.querySelector<HTMLElement>(".article-body");
  if (body !== null && typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(reposition);
    observer.observe(body);
  }

  const apply = (): void => {
    const floating = !wide.matches;

    if (floating) layout.dataset["floatingRails"] = "";
    else delete layout.dataset["floatingRails"];

    /*
     * The contents list is open on a wide screen, where it is a plain list with
     * no summary to click, and closed when it is a panel. Setting `open` here
     * rather than leaving it to the markup is also what fixes the case where a
     * reader collapsed the list on a phone and then widened the window: the
     * summary is hidden at that width, so a closed `<details>` was an invisible
     * list and an empty rail.
     */
    if (toc !== null) toc.open = !floating;
    /*
     * The note drawer is closed and off screen on both sides of the breakpoint:
     * it is a per-note view, and which note was open is not worth carrying
     * across a layout change that moves every note anyway. Clearing the anchor
     * is what drops the measured offset.
     */
    anchor = null;
    lastTrigger = null;
    if (sidenoteRail !== null) {
      sidenoteRail.open = false;
      placeSidenoteRail(sidenoteRail, null);
    }

    layoutSidenotes(floating);
    // Chips are created and removed by the line above, so their state is stale
    // until this runs: on the way to wide there are none, and on the way back
    // there are new ones that all have to be shown.
    syncChips();
  };

  /*
   * Open both drawers for printing, and put them back afterwards.
   *
   * A closed `<details>` hides its contents, and CSS cannot override that
   * reliably: `display: block` on the contents of a closed details works in some
   * engines and not others. So the open state is set here instead — dependable,
   * and honest, because the drawers are opened because the script knows they must
   * be rather than because a stylesheet is asking a browser to ignore its own
   * semantics.
   *
   * `hidden` is cleared too, and measured rather than assumed: `print.css` does
   * also put a hidden drawer on paper, because its `details { display: block }`
   * is an author rule and author rules beat the user agent's `[hidden] {
   * display: none }` in the cascade. That is a real second path to the same
   * result, and clearing `hidden` here is what keeps print working if that rule
   * is ever narrowed — the alternative is a page that silently prints without
   * its notes because a stylesheet elsewhere changed.
   *
   * The reader's own choice is remembered, not assumed: someone may have opened
   * one deliberately, and printing should not decide for them afterwards. Both
   * halves are restored, since a drawer left `hidden` after print would be
   * off screen for a reader who had it open.
   */
  window.addEventListener("beforeprint", () => {
    for (const rail of [toc, sidenoteRail]) {
      if (rail === null) continue;
      // `hasAttribute` rather than the `hidden` property, which the DOM types
      // widen to `boolean | "until-found"`: what has to be restored is whether
      // the drawer was off screen, which is exactly what the attribute records.
      previousOpenState.set(rail, {
        open: rail.open,
        hidden: rail.hasAttribute("hidden"),
      });
      rail.hidden = false;
      rail.open = true;
    }
  });

  window.addEventListener("afterprint", () => {
    for (const [rail, state] of previousOpenState) {
      if (!rail.isConnected) continue;
      rail.open = state.open;
      rail.hidden = state.hidden;
    }
    previousOpenState.clear();
  });

  apply();
  wide.addEventListener("change", apply);
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                 */
/* -------------------------------------------------------------------------- */

export function initArticle(): void {
  initCodeCopy();
  initHeadingAnchors();
  initToc();
  initShare();
  initBackToTop();

  /*
   * Numbering first: it is what gives every note its `id` and its number, and
   * both the reference link and the panel's count read them. The rails come
   * after, because moving a note must not happen before it has a number.
   */
  initSidenoteNumbering();
  initRails();
}
