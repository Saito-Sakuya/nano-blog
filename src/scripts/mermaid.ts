/**
 * Mermaid diagrams.
 *
 * The library is fetched on demand and drawn on demand, so a reader pays for
 * neither the download nor the layout work until a diagram is about to be read:
 *
 * - a page with no diagram never emits this module's script tag at all (the
 *   layout decides that at build time);
 * - a page *with* a diagram still downloads nothing until one scrolls into
 *   view, because the dynamic import lives inside the intersection callback
 *   rather than at the top of `initMermaid`. Importing it up front would pull
 *   roughly half a megabyte of JavaScript over the wire while the reader is
 *   still on the first screen, which is the opposite of the intent.
 *
 * Security is set to `strict`, which disables HTML labels, click callbacks,
 * external resource loading and arbitrary link protocols, so a diagram cannot
 * become a scripting or exfiltration vector.
 */

const THEME_VARIABLES = {
  light: {
    background: "#FCFBF7",
    primaryColor: "#D9F2F5",
    primaryTextColor: "#172125",
    primaryBorderColor: "#00A2BD",
    lineColor: "#5D686C",
    secondaryColor: "#F7F5EF",
    tertiaryColor: "#F7F5EF",
  },
  dark: {
    background: "#151E21",
    primaryColor: "#10373E",
    primaryTextColor: "#E8EFEF",
    primaryBorderColor: "#00A2BD",
    lineColor: "#9AA8AB",
    secondaryColor: "#0E1517",
    tertiaryColor: "#0E1517",
  },
} as const;

function importMermaid() {
  return import("mermaid").then((module) => module.default);
}

type MermaidApi = Awaited<ReturnType<typeof importMermaid>>;

/**
 * The single in-flight import, created on first use.
 *
 * Held at module scope so several diagrams entering view together share one
 * request, and so a theme change after the first draw reconfigures the same
 * instance rather than loading a second copy. The promise's type is derived
 * from the dynamic import, so the library's shape cannot drift from what is
 * used below without this file failing to compile.
 *
 * A *failure* is deliberately not remembered. A cached rejection is permanent:
 * the reader whose connection dropped for one second while the module was being
 * fetched would have every diagram on the page reduced to its source for the
 * rest of the visit, with no way back short of a reload. Clearing the slot on
 * failure costs a second attempt and gives the retry a chance to succeed.
 */
let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= importMermaid().catch((error: unknown) => {
    mermaidPromise = null;
    throw error;
  });
  return mermaidPromise;
}

/** True once the library has at least been requested. */
function mermaidRequested(): boolean {
  return mermaidPromise !== null;
}

/**
 * The tail of the render queue.
 *
 * `initialize` writes global configuration and `render` reads it when it
 * actually runs, so two draws in flight at once are one draw reconfiguring the
 * other: the second `configure` lands between the first draw's `initialize` and
 * its `render`, and the first diagram comes out in the palette that was current
 * when its turn ended rather than when it began. Nothing about the library is
 * safe to interleave, and the diagram is a static picture — the queue only ever
 * delays work that was already going to happen.
 *
 * Every task is appended to one chain, so a redraw requested while a draw is
 * running waits for it instead of racing it, and the theme each diagram is drawn
 * with is the theme at the moment its own turn begins.
 */
let queue: Promise<void> = Promise.resolve();

function serialise<T>(work: () => Promise<T>): Promise<T> {
  const result = queue.then(work);
  // The chain never rejects: each task handles its own failure, and a rejection
  // left in the chain would poison every draw queued behind it.
  queue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function currentTheme(): "light" | "dark" {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function configure(mermaid: MermaidApi): void {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // No HTML labels, no click handlers, no external icons.
    htmlLabels: false,
    theme: "base",
    themeVariables: THEME_VARIABLES[currentTheme()],
    fontFamily: "var(--font-sans)",
    flowchart: { useMaxWidth: true, htmlLabels: false },
    // Mermaid has no animation switch in this version. Every animation and
    // transition in the stylesheet is already disabled under
    // `prefers-reduced-motion`, which covers the rendered diagram too.
  });
}

export function initMermaid(): void {
  const holders = [...document.querySelectorAll<HTMLElement>("[data-mermaid]")];
  if (holders.length === 0) return;

  const rendered = new WeakMap<HTMLElement, string>();

  /**
   * The explanation a failed render reveals, taken out of the document until it
   * is needed.
   *
   * The paragraph is authored by the Markdown pipeline with its text already
   * inside it and `hidden` until a render fails. Revealing an element that
   * already holds its text is not a change any live region reports, so the
   * message is captured here, cleared at start-up, and written back at the
   * moment it applies — which is the mutation that gets announced. A reader
   * without script never reaches this code and keeps the authored paragraph,
   * which is the whole point of it being in the markup.
   */
  const failureMessages = new Map<HTMLElement, string>();
  for (const holder of holders) {
    const status = holder.querySelector<HTMLElement>("[data-mermaid-status]");
    if (status === null) continue;
    /*
     * A failed diagram is exactly the case a screen reader has to be told about:
     * the drawing area it was promised is empty and the source has taken its
     * place. Without a live region the swap is silent.
     */
    status.setAttribute("aria-live", "polite");
    failureMessages.set(holder, status.textContent ?? "");
    status.textContent = "";
  }

  const renderInto = async (holder: HTMLElement): Promise<void> => {
    const target = holder.querySelector<HTMLElement>("[data-mermaid-target]");
    const source = holder.querySelector<HTMLElement>("[data-mermaid-source]");
    const status = holder.querySelector<HTMLElement>("[data-mermaid-status]");
    if (target === null || source === null || status === null) return;

    const code = source.textContent ?? "";
    if (code.trim().length === 0) return;

    try {
      // The first diagram to arrive is what triggers the download.
      const mermaid = await loadMermaid();
      configure(mermaid);

      const { svg } = await mermaid.render(
        `mermaid-${Math.random().toString(36).slice(2, 10)}`,
        code,
      );
      target.innerHTML = svg;
      // Success: the source steps aside, but is still in the document for
      // anyone who wants it, and the unsupported-browser case still shows it.
      source.hidden = true;
      status.hidden = true;
      rendered.set(holder, code);
    } catch {
      // Failure leaves the source visible and adds an explanation, rather than
      // leaving a blank box. The explanation is written after the paragraph is
      // on screen, so the live region has a change to report.
      target.replaceChildren();
      source.hidden = false;
      status.hidden = false;
      status.textContent = failureMessages.get(holder) ?? "";
    }
  };

  /** One diagram at a time; see the queue above. */
  const draw = (holder: HTMLElement): Promise<void> =>
    serialise(() => renderInto(holder));

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const holder = entry.target as HTMLElement;
        observer.unobserve(holder);
        void draw(holder);
      }
    },
    { rootMargin: "200px 0px" },
  );

  for (const holder of holders) observer.observe(holder);

  // A theme change redraws with the matching palette. Existing SVG cannot be
  // recoloured reliably, so the diagram is simply rendered again. Nothing has
  // been drawn unless the library is already loaded, so this is a no-op for a
  // reader who never scrolled to a diagram.
  const redrawAll = async (): Promise<void> => {
    if (!mermaidRequested()) return;
    for (const holder of holders) {
      if (!rendered.has(holder)) continue;
      await draw(holder);
    }
  };

  const themeObserver = new MutationObserver(() => {
    void redrawAll();
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });

  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (document.documentElement.hasAttribute("data-theme")) return;
      void redrawAll();
    });
}
