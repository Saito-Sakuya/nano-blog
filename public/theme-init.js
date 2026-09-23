/*
 * Theme initialisation.
 *
 * This file is loaded synchronously from <head> *before* the stylesheet, so the
 * correct colour scheme is on the document element by the time the first paint
 * happens. Running any later would show a flash of the wrong theme.
 *
 * It is a separate same-origin file rather than an inline script so the
 * Content-Security-Policy can keep `script-src 'self'` and forbid inline
 * script entirely.
 *
 * Only an explicit stored choice is applied. With nothing stored the attribute
 * is left off and the stylesheet's `prefers-color-scheme` rules decide, which
 * is what lets the site keep following the system afterwards.
 */
(function () {
  var KEY = "nano-blog-theme";
  try {
    var stored = window.localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
      document.documentElement.style.colorScheme = stored;
    }
  } catch (error) {
    /* Storage can be blocked. Following the system preference is fine. */
  }
})();
