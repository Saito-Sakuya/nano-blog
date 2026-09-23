/**
 * Theme control.
 *
 * Three states, not two: an explicit light, an explicit dark, and "follow the
 * system". A two-state toggle cannot express the third, which is why this is a
 * small menu of radio items rather than a button with `aria-pressed`.
 *
 * The menu is positioned with `position: fixed` from the trigger's bounding
 * box. The navigation list scrolls horizontally on narrow screens, and an
 * absolutely positioned child of a scrolling container would be clipped.
 */

const STORAGE_KEY = "nano-blog-theme";

export type ThemeChoice = "light" | "dark" | "system";

const LABELS: Readonly<Record<ThemeChoice, string>> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

function isChoice(value: string | null): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

function readStored(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isChoice(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

function apply(choice: ThemeChoice): void {
  const root = document.documentElement;

  if (choice === "system") {
    root.removeAttribute("data-theme");
    root.style.removeProperty("color-scheme");
  } else {
    root.setAttribute("data-theme", choice);
    root.style.colorScheme = choice;
  }

  try {
    if (choice === "system") {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, choice);
    }
  } catch {
    /* Storage can be blocked; the choice still applies for this page. */
  }
}

export function initThemeToggle(): void {
  const container = document.querySelector<HTMLElement>("[data-theme-toggle]");
  if (container === null) return;

  const button = container.querySelector<HTMLButtonElement>(
    "[data-theme-button]",
  );
  const menu = container.querySelector<HTMLElement>("[data-theme-menu]");
  const label = container.querySelector<HTMLElement>("[data-theme-label]");
  if (button === null || menu === null) return;

  const items = [
    ...menu.querySelectorAll<HTMLButtonElement>("[data-theme-value]"),
  ];

  // The control only exists once this script has run. Without JavaScript the
  // stylesheet's `prefers-color-scheme` rules decide the theme, and a button
  // that did nothing would be worse than no button at all.
  container.hidden = false;

  let choice = readStored();

  const reflect = (): void => {
    for (const item of items) {
      const value = item.dataset["themeValue"];
      item.setAttribute("aria-checked", String(value === choice));
    }
    if (label !== null) {
      // The visible text carries the whole state, so the accessible name is
      // simply what the reader can see. An `aria-label` describing the state
      // differently would be a second source of truth that can disagree with
      // the button, which is exactly what axe reports as a name mismatch.
      label.textContent = `主题（${LABELS[choice]}）`;
    }
  };

  const positionMenu = (): void => {
    const rect = button.getBoundingClientRect();
    menu.style.top = `${rect.bottom + 4}px`;
    // Keep the menu inside the viewport on narrow screens.
    const menuWidth = menu.offsetWidth || 160;
    const right = Math.max(8, window.innerWidth - rect.right);
    menu.style.right = `${Math.min(right, Math.max(8, window.innerWidth - menuWidth - 8))}px`;
    menu.style.left = "auto";
  };

  /**
   * Move focus without scrolling the page.
   *
   * `focus()` on its own scrolls the focused element into view, and every
   * control here lives inside a `position: sticky` header — so the browser
   * decided the already-visible trigger was off-screen and scrolled the page by
   * roughly half a viewport each time a theme was chosen. Returning focus is
   * still required (the reader must not be dropped at the top of the document),
   * so it is done with `preventScroll`, which keeps the caret where it was
   * without moving the viewport.
   *
   * The menu items are scroll-neutral today only because the menu is
   * `position: fixed`; routing them through the same helper means a future
   * change to that positioning cannot quietly reintroduce the jump.
   */
  const focusNoScroll = (element: HTMLElement | undefined): void => {
    element?.focus({ preventScroll: true });
  };

  const close = (focusTrigger: boolean): void => {
    if (menu.hidden) return;
    menu.hidden = true;
    button.setAttribute("aria-expanded", "false");
    if (focusTrigger) focusNoScroll(button);
  };

  const open = (focusFirst: boolean): void => {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    positionMenu();
    if (focusFirst) {
      const current = items.find(
        (item) => item.getAttribute("aria-checked") === "true",
      );
      focusNoScroll(current ?? items[0]);
    }
  };

  const select = (value: ThemeChoice): void => {
    choice = value;
    apply(choice);
    reflect();
  };

  button.addEventListener("click", () => {
    if (menu.hidden) {
      open(false);
    } else {
      close(false);
    }
  });

  button.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      open(true);
    }
  });

  for (const item of items) {
    item.addEventListener("click", () => {
      const value = item.dataset["themeValue"];
      if (isChoice(value ?? null)) {
        select(value as ThemeChoice);
      }
      close(true);
    });
  }

  menu.addEventListener("keydown", (event) => {
    const index = items.indexOf(document.activeElement as HTMLButtonElement);

    switch (event.key) {
      case "Escape":
        event.preventDefault();
        close(true);
        break;
      case "ArrowDown":
        event.preventDefault();
        focusNoScroll(items[(index + 1 + items.length) % items.length]);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusNoScroll(items[(index - 1 + items.length) % items.length]);
        break;
      case "Home":
        event.preventDefault();
        focusNoScroll(items[0]);
        break;
      case "End":
        event.preventDefault();
        focusNoScroll(items[items.length - 1]);
        break;
      case "Tab":
        close(false);
        break;
      default:
        break;
    }
  });

  document.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (target instanceof Node && !container.contains(target)) {
      close(false);
    }
  });

  // A system change only takes effect while the visitor is following the
  // system; an explicit choice is never overridden.
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (choice === "system") reflect();
    });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close(false);
  });

  /*
   * Apply the stored choice, do not merely reflect it.
   *
   * The two are separate jobs and the control needs both: `reflect` paints the
   * menu (which item is checked, what the trigger says) and `apply` puts the
   * choice on the document. Reflecting without applying is the state where the
   * button claims "深色" while the page renders light — which is exactly what
   * happens when `/theme-init.js` is missing or was blocked, since that file is
   * the only other thing that ever reads the stored value. The control cannot
   * be the only part of the page that believes a choice was applied.
   *
   * `apply` is idempotent: it sets or removes the same attribute and writes the
   * same stored value, so running it here costs one redundant write on the path
   * where the head script already ran, and repairs the page on the path where
   * it did not.
   */
  apply(choice);
  reflect();
}
