import astro from "eslint-plugin-astro";
import tseslint from "typescript-eslint";

/**
 * ESLint configuration (flat config, ESLint 10).
 *
 * Three groups of files, each with the rules that actually apply to it:
 *
 * 1. **Astro components** (`src/**\/*.astro`) — `eslint-plugin-astro`'s
 *    recommended set, which parses the frontmatter as TypeScript and the
 *    template as Astro, and adds the Astro-specific correctness rules
 *    (no stray `set:html`, no invalid `client:*` directive, and so on).
 * 2. **TypeScript** (`scripts/**`, `tests/**`, `src/lib/**`, the root
 *    `*.ts` configs) — `typescript-eslint`'s recommended set.
 * 3. **The one browser file outside the build** (`public/theme-init.js`) —
 *    deliberately rule-free: it is copied verbatim into the build and runs
 *    before any module, so the bundler's assumptions do not apply to it.
 *
 * `eslint-plugin-jsx-a11y` is intentionally not installed. This project has no
 * JSX and no framework that produces it, and `eslint-plugin-astro` lists it as
 * an *optional* peer for its `jsx-a11y-*` presets, which are not used here.
 * Accessibility is enforced where it can actually be measured instead: axe-core
 * and real keyboard assertions in `scripts/verify/a11y.ts`, and the structural
 * checks in `tests/e2e/`.
 */
export default tseslint.config(
  {
    name: "nano-blog/ignores",
    ignores: [
      // Build output. Both directories are generated, git-ignored, and would
      // otherwise be linted as if they were source.
      "dist/**",
      "dist-fixtures/**",
      // Installed dependencies and Astro's generated types.
      "node_modules/**",
      ".astro/**",
      // Materialised content and local release state.
      ".ani-content/**",
      // Report output written by the verification scripts.
      "lighthouse-results/**",
      "playwright-report/**",
      "test-results/**",
      "coverage/**",
    ],
  },

  // --- TypeScript ----------------------------------------------------------
  // Before the Astro block on purpose. `typescript-eslint`'s base config sets a
  // parser for *every* file (it carries no `files` restriction), so it has to
  // be merged first; the Astro block then narrows the parser back to
  // `astro-eslint-parser` for `.astro` files, which is the only parser that can
  // read a component's frontmatter and template.
  ...tseslint.configs.recommended,

  // --- Astro components ----------------------------------------------------
  ...astro.configs["flat/recommended"],

  {
    name: "nano-blog/typescript-overrides",
    files: ["**/*.ts", "**/*.mts", "**/*.cts"],
    rules: {
      // The project imports values it only uses in type positions behind
      // `import type`, and `verbatimModuleSyntax` makes that a build error
      // rather than a style preference. This rule keeps the two in agreement.
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],
      // An unused parameter is a real defect in this codebase: the failure
      // paths are wide and a dropped argument silently changes behaviour.
      // Underscore-prefixed names are the standard "deliberately unused" mark.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          args: "all",
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      // `any` defeats the strict preset the repository is compiled with.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },

  // --- Astro overrides -----------------------------------------------------
  {
    name: "nano-blog/astro-overrides",
    files: ["**/*.astro"],
    rules: {
      // Astro components legitimately mix markup and script; the base rule
      // cannot see the frontmatter, so the Astro-aware behaviour is kept.
      "@typescript-eslint/no-unused-vars": "off",
    },
  },

  // --- Plain browser script ------------------------------------------------
  {
    name: "nano-blog/plain-javascript",
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    rules: {
      // `typescript-eslint`'s variant of this rule reports an unused `catch`
      // binding, which is the right default for TypeScript: `useUnknownInCatchVariables`
      // makes the binding worth inspecting. A plain JavaScript file has no such
      // obligation, and `public/theme-init.js` deliberately ignores the storage
      // error — blocked storage is a supported state, not a failure. ESLint's
      // own default for JavaScript (`caughtErrors: 'none'`) is applied instead.
      "@typescript-eslint/no-unused-vars": ["error", { caughtErrors: "none" }],
    },
  },
);
