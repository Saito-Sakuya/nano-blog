/**
 * The featured carousel's controls.
 *
 * The track is a scroll-snapping list and works without this script: swipe,
 * trackpad and keyboard scrolling all move it. What the script adds is a way
 * to step for a mouse user — the arrow buttons and square markers, hidden in
 * the markup until this runs — and the state they show: which card is in view,
 * and that there is nothing before the first or after the last.
 *
 * Nothing here advances on a timer, and nothing should: a carousel that moves
 * while it is being read takes the text away mid-sentence (WCAG 2.2.2).
 */

export function initCarousels(): void {
  for (const root of document.querySelectorAll<HTMLElement>(
    "[data-carousel]",
  )) {
    initCarousel(root);
  }
}

function initCarousel(root: HTMLElement): void {
  const track = root.querySelector<HTMLElement>("[data-carousel-track]");
  const controls = root.querySelector<HTMLElement>("[data-carousel-controls]");
  if (track === null || controls === null) return;

  const slides = [
    ...track.querySelectorAll<HTMLElement>("[data-carousel-slide]"),
  ];
  // One card has nowhere to step to; its controls would only be noise.
  if (slides.length < 2) return;

  const markers = [
    ...controls.querySelectorAll<HTMLButtonElement>("[data-carousel-marker]"),
  ];
  const previous = controls.querySelector<HTMLButtonElement>(
    '[data-carousel-step="-1"]',
  );
  const next = controls.querySelector<HTMLButtonElement>(
    '[data-carousel-step="1"]',
  );

  controls.hidden = false;
  let current = 0;

  /** Measured from the slides' own offsets, so gaps and peeks are included. */
  const go = (index: number): void => {
    const target = slides[Math.max(0, Math.min(slides.length - 1, index))];
    if (target === undefined) return;
    track.scrollTo({ left: target.offsetLeft - slides[0]!.offsetLeft });
  };

  const mark = (index: number): void => {
    current = index;
    markers.forEach((marker, position) => {
      marker.setAttribute("aria-current", String(position === index));
    });
    if (previous !== null) previous.disabled = index === 0;
    if (next !== null) next.disabled = index === slides.length - 1;
  };

  for (const marker of markers) {
    marker.addEventListener("click", () => {
      go(Number(marker.dataset["carouselMarker"]));
    });
  }
  previous?.addEventListener("click", () => {
    go(current - 1);
  });
  next?.addEventListener("click", () => {
    go(current + 1);
  });

  // The nearest slide to the track's start is the current one, however the
  // track got there: a button, a swipe or a scroll wheel.
  let frame = 0;
  track.addEventListener(
    "scroll",
    () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const origin = slides[0]!.offsetLeft;
        let nearest = 0;
        let distance = Infinity;
        slides.forEach((slide, index) => {
          const gap = Math.abs(slide.offsetLeft - origin - track.scrollLeft);
          if (gap < distance) {
            distance = gap;
            nearest = index;
          }
        });
        if (nearest !== current) mark(nearest);
      });
    },
    { passive: true },
  );

  mark(0);
}
