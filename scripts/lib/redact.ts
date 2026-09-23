/**
 * Secret redaction.
 *
 * No credential value is ever printed in full, and no long piece of one is
 * printed either. A log line that carries a run of characters from a secret is
 * quoting the secret, whether the run is the whole value, a prefix, or "the
 * last four" — so every maximal run of a secret that appears anywhere in the
 * text is replaced, not just the whole value.
 *
 * Two floors keep that from turning ordinary prose into asterisks:
 *
 * - a value shorter than `MIN_SECRET_LENGTH` is not masked at all — one
 *   character of a secret would blank out every occurrence of that character;
 * - a run shorter than `MIN_SECRET_FRAGMENT_LENGTH` (or shorter than the secret
 *   itself, whichever is smaller) is left alone — a four-character fragment of
 *   a passphrase-phrase secret is a real English word, while six consecutive
 *   characters of one are not language.
 *
 * Every credential this tooling reads is far longer than either floor.
 */

export const REDACTED = "***";

/** Values shorter than this are not masked at all. See the module comment. */
export const MIN_SECRET_LENGTH = 4;

/** Runs shorter than this are left alone. See the module comment. */
export const MIN_SECRET_FRAGMENT_LENGTH = 6;

/** Names whose values are treated as secrets everywhere in the tooling. */
export const SECRET_ENVIRONMENT_NAMES: readonly string[] = [
  "R2_BUILD_ACCESS_KEY_ID",
  "R2_BUILD_SECRET_ACCESS_KEY",
  "R2_AUTHOR_ACCESS_KEY_ID",
  "R2_AUTHOR_SECRET_ACCESS_KEY",
  "R2_CLEANUP_ACCESS_KEY_ID",
  "R2_CLEANUP_SECRET_ACCESS_KEY",
  "CF_WORKERS_AI_API_TOKEN",
  "CF_PAGES_DEPLOY_HOOK_URL",
  // D1 edit token, read only by `comments:review`.
  "CF_D1_API_TOKEN",
  // The secret the Functions layer hashes caller addresses with. It belongs in
  // this list because it is a secret; it is never read by a local command.
  "COMMENTS_IP_SECRET",
];

const SECRET_NAME_SET = new Set(SECRET_ENVIRONMENT_NAMES);

export function isSecretEnvironmentName(name: string): boolean {
  return SECRET_NAME_SET.has(name);
}

/** `set (redacted)` or `unset` — never the value. */
export function describeSecret(
  value: string | undefined,
): "set (redacted)" | "unset" {
  return value === undefined || value.length === 0 ? "unset" : "set (redacted)";
}

/** How a non-secret variable is shown: its value, or `unset`. */
export function describeVariable(
  name: string,
  value: string | undefined,
): string {
  if (isSecretEnvironmentName(name)) return describeSecret(value);
  return value === undefined || value.length === 0 ? "unset" : value;
}

/**
 * Replace every maximal run of `text` that is a substring of `secret`.
 *
 * "Maximal" matters: masking fixed-width windows of a secret — the obvious
 * implementation — leaves the tail of a longer quote behind, so a leaked
 * twenty-character middle section becomes `***` plus the ten characters no
 * window reached. Growing each run while it is still a substring of the secret
 * masks the quote, and only the quote.
 */
function redactSecretFragments(
  text: string,
  secret: string,
  minimumRun: number,
): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    let end = index + 1;
    while (end <= text.length && secret.includes(text.slice(index, end))) {
      end += 1;
    }

    const runLength = end - 1 - index;
    if (runLength >= minimumRun) {
      result += REDACTED;
      index = end - 1;
      continue;
    }

    result += text.slice(index, index + 1);
    index += 1;
  }

  return result;
}

/**
 * Replace every occurrence of a known secret — and of any long-enough run of
 * one — in `text`.
 */
export function redactSecretsIn(
  text: string,
  secrets: readonly (string | undefined)[],
): string {
  let result = text;
  for (const secret of secrets) {
    if (secret === undefined || secret.length < MIN_SECRET_LENGTH) continue;
    result = redactSecretFragments(
      result,
      secret,
      Math.min(secret.length, MIN_SECRET_FRAGMENT_LENGTH),
    );
  }
  return result;
}

/**
 * Strip everything but the origin from a URL so it can be mentioned in a log
 * without leaking a query string or a path token. Used for endpoints whose
 * query string is itself a credential.
 */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}/…(redacted)`;
  } catch {
    return "(unparseable url, redacted)";
  }
}
