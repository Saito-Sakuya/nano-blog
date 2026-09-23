/**
 * What a comment must look like to be accepted.
 *
 * Pure functions, no storage and no request objects, so the rules can be tested
 * exhaustively and reused by the local moderation tool without either one
 * needing a database or a running server.
 *
 * The limits are not UI hints. Every one of them is enforced at the point of
 * writing, because a `maxlength` attribute is a convenience for honest people
 * and nothing at all to anyone posting directly to the endpoint.
 */

/** Longest accepted comment body, in Unicode code points. */
export const MAX_BODY_LENGTH = 4000;

/** Shortest accepted comment body. One character is not a contribution. */
export const MIN_BODY_LENGTH = 2;

/** Longest accepted display name, in Unicode code points. */
export const MAX_NAME_LENGTH = 40;

/** Longest accepted email address. 254 is the RFC 5321 limit. */
export const MAX_EMAIL_LENGTH = 254;

/** Longest accepted page identifier (a content path). */
export const MAX_POST_ID_LENGTH = 512;

/**
 * Most links a comment may contain.
 *
 * A comment is a reply, not a place to publish a link list. Three leaves room
 * for citations while denying a spam payload its whole purpose.
 */
export const MAX_LINKS = 3;

/**
 * How quickly a form may be submitted after it was rendered.
 *
 * A person cannot read a post, decide to reply, type a sentence and submit it in
 * under three seconds; a script posting to the endpoint directly can. This is
 * the cheapest possible filter and it costs an honest commenter nothing, since
 * the timestamp travels with the form they were already given.
 */
export const MIN_FILL_SECONDS = 3;

/**
 * The longest a rendered form is considered valid, in seconds.
 *
 * A stale form is either a robot holding a token or a reader who left a tab open
 * for a week; both should be asked to try again rather than have their comment
 * silently attributed to a week-old session.
 */
export const MAX_FORM_AGE_SECONDS = 60 * 60 * 12;

/**
 * Why the timing check is optional, and what it is actually worth.
 *
 * The timestamp cannot come from the build. This site is static: the component
 * that renders the form runs once, when the site is built, so a value produced
 * there would say when the *build* happened rather than when a reader opened the
 * page — and every submission more than twelve hours after a deploy would be
 * rejected as stale. It has to be supplied by the page at load time, which means
 * it exists only when JavaScript runs.
 *
 * So it is applied when present and skipped when absent. That is not a gap being
 * papered over: a request posted directly to the endpoint could omit the field
 * regardless, so requiring it would reject the no-script reader while stopping
 * no bot at all. It filters the naive case — a filler that posts immediately
 * without executing page script — and that is the whole of its value. The
 * honeypot is plain markup and applies always; human review is the real gate.
 */

/** Comment lifecycle. A comment is only ever shown in the `approved` state. */
export type CommentStatus = "pending" | "approved" | "rejected";

export interface CommentInput {
  readonly postId: unknown;
  readonly authorName: unknown;
  readonly email: unknown;
  readonly bodyMarkdown: unknown;
  /** The honeypot field: must be absent or empty. */
  readonly trap: unknown;
  /**
   * When the page was loaded, as Unix seconds, filled in by script.
   *
   * Absent when JavaScript did not run, in which case the timing check is
   * skipped rather than the submission refused.
   */
  readonly renderedAt: unknown;
}

export interface ValidatedComment {
  readonly postId: string;
  readonly authorName: string;
  readonly email: string;
  readonly bodyMarkdown: string;
}

export type ValidationFailure =
  | { readonly code: "post-id" | "post-id-shape"; readonly message: string }
  | { readonly code: "name"; readonly message: string }
  | { readonly code: "email"; readonly message: string }
  | { readonly code: "body"; readonly message: string }
  | { readonly code: "links"; readonly message: string }
  | { readonly code: "trap"; readonly message: string }
  | { readonly code: "timing"; readonly message: string };

export type ValidationResult =
  | { readonly ok: true; readonly value: ValidatedComment }
  | { readonly ok: false; readonly failure: ValidationFailure };

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

/** A content path as the site's own routing defines it. */
const POST_ID_SHAPE = /^[a-z0-9]+(?:[-/][a-z0-9]+)*$/u;

function codePointLength(value: string): number {
  return [...value].length;
}

/**
 * Collapse a text field to the single line it claims to be.
 *
 * A display name with a newline in it is either a mistake or an attempt to
 * break out of the markup it is placed in, so newlines collapse to spaces
 * rather than being rejected outright — the reader still gets their comment
 * posted, with a name that cannot disturb the layout around it.
 */
function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/**
 * Normalise and check a submitted comment.
 *
 * @param now The server's clock, passed in rather than read here so the timing
 *   rule can be tested without waiting and cannot be influenced by the caller.
 *
 * Returns the first failure rather than a list, because the form shows one
 * message at a time and a wall of simultaneous complaints helps nobody.
 */
export function validateComment(
  input: CommentInput,
  now: Date,
): ValidationResult {
  // --- honeypot ------------------------------------------------------------

  // A field no person can see, let alone fill. Anything in it means a script
  // walked the form's inputs; the response is indistinguishable from success so
  // a bot gets no signal about why it failed.
  if (typeof input.trap === "string" && input.trap.trim().length > 0) {
    return {
      ok: false,
      failure: {
        code: "trap",
        message: "Submission rejected.",
      },
    };
  }

  // --- timing (only when the page was able to report it) -------------------

  /*
   * A missing timestamp is not a failure. It means the page script did not run,
   * and a reader without JavaScript must still be able to comment — refusing
   * them would trade a real capability for a filter that a bot can skip by
   * sending no timestamp either.
   */
  /*
   * An empty string is treated as absent, and that is the whole reason this
   * check exists in this shape.
   *
   * A form field with no value is submitted as an empty string, not omitted — so
   * the no-JavaScript path, which renders the field empty, arrives as `""`
   * rather than as nothing. Reading that as the number zero made every such
   * submission look like a timestamp from 1970 and be rejected as stale, which
   * is the opposite of the intent: without script there is no timing
   * information, and the check is skipped.
   */
  const supplied = input.renderedAt;
  if (
    supplied !== undefined &&
    supplied !== null &&
    !(typeof supplied === "string" && supplied.trim().length === 0)
  ) {
    const raw = typeof supplied === "string" ? Number(supplied) : supplied;

    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return {
        ok: false,
        failure: {
          code: "timing",
          message:
            "The form carried an unreadable timestamp; please try again.",
        },
      };
    }

    /*
     * The server does the subtraction. The page reports when it was loaded, not
     * how long the reader took, so a client cannot describe an interval that
     * never elapsed and the arithmetic is not the client's to get wrong.
     */
    const elapsed = Math.floor(now.getTime() / 1000) - raw;

    if (elapsed < MIN_FILL_SECONDS) {
      return {
        ok: false,
        failure: {
          code: "timing",
          message: "That was submitted faster than a person could type it.",
        },
      };
    }
    if (elapsed > MAX_FORM_AGE_SECONDS) {
      return {
        ok: false,
        failure: {
          code: "timing",
          message:
            "This form is too old; please reload the page and try again.",
        },
      };
    }
  }

  // --- page ----------------------------------------------------------------

  if (typeof input.postId !== "string" || input.postId.length === 0) {
    return {
      ok: false,
      failure: { code: "post-id", message: "No page was named." },
    };
  }

  const postId = input.postId.trim();
  if (
    postId.length > MAX_POST_ID_LENGTH ||
    !POST_ID_SHAPE.test(postId) ||
    postId.includes("//") ||
    postId.startsWith("/") ||
    postId.endsWith("/")
  ) {
    return {
      ok: false,
      failure: {
        code: "post-id-shape",
        message: "That page identifier is not a content path.",
      },
    };
  }

  // --- name ----------------------------------------------------------------

  if (typeof input.authorName !== "string") {
    return {
      ok: false,
      failure: { code: "name", message: "A name is required." },
    };
  }

  const authorName = singleLine(input.authorName.normalize("NFC"));
  if (authorName.length === 0) {
    return {
      ok: false,
      failure: { code: "name", message: "A name is required." },
    };
  }
  if (CONTROL_CHARACTERS.test(authorName)) {
    return {
      ok: false,
      failure: {
        code: "name",
        message: "The name contains characters that are not allowed.",
      },
    };
  }
  if (codePointLength(authorName) > MAX_NAME_LENGTH) {
    return {
      ok: false,
      failure: {
        code: "name",
        message: `The name may be at most ${String(MAX_NAME_LENGTH)} characters.`,
      },
    };
  }

  // --- email ---------------------------------------------------------------

  if (typeof input.email !== "string") {
    return {
      ok: false,
      failure: { code: "email", message: "An email address is required." },
    };
  }

  const email = input.email.trim().normalize("NFC");
  if (email.length === 0) {
    return {
      ok: false,
      failure: { code: "email", message: "An email address is required." },
    };
  }
  if (email.length > MAX_EMAIL_LENGTH) {
    return {
      ok: false,
      failure: {
        code: "email",
        message: "That email address is longer than an address can be.",
      },
    };
  }
  /*
   * Deliberately not an exhaustive RFC 5322 grammar. That grammar accepts
   * quoted strings, comments and bare IP literals, and every site that has tried
   * to implement it has rejected addresses that were valid. The check that
   * matters is that there is something before an `@` and a dotted name after it,
   * with no whitespace anywhere — anything beyond that is a mail server's
   * business, and this address is only ever used to look up an avatar.
   */
  if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(email)) {
    return {
      ok: false,
      failure: {
        code: "email",
        message: "That does not look like an email address.",
      },
    };
  }

  // --- body ----------------------------------------------------------------

  if (typeof input.bodyMarkdown !== "string") {
    return {
      ok: false,
      failure: { code: "body", message: "The comment is empty." },
    };
  }

  const bodyMarkdown = input.bodyMarkdown.replace(/\r\n?/gu, "\n").trim();
  if (bodyMarkdown.length === 0) {
    return {
      ok: false,
      failure: { code: "body", message: "The comment is empty." },
    };
  }
  if (CONTROL_CHARACTERS.test(bodyMarkdown)) {
    return {
      ok: false,
      failure: {
        code: "body",
        message: "The comment contains characters that are not allowed.",
      },
    };
  }

  const bodyLength = codePointLength(bodyMarkdown);
  if (bodyLength < MIN_BODY_LENGTH) {
    return {
      ok: false,
      failure: {
        code: "body",
        message: "The comment is too short to be a reply.",
      },
    };
  }
  if (bodyLength > MAX_BODY_LENGTH) {
    return {
      ok: false,
      failure: {
        code: "body",
        message: `The comment may be at most ${String(MAX_BODY_LENGTH)} characters; this one is ${String(bodyLength)}.`,
      },
    };
  }

  const linkCount = countLinks(bodyMarkdown);
  if (linkCount > MAX_LINKS) {
    return {
      ok: false,
      failure: {
        code: "links",
        message: `A comment may contain at most ${String(MAX_LINKS)} links; this one has ${String(linkCount)}.`,
      },
    };
  }

  return {
    ok: true,
    value: { postId, authorName, email, bodyMarkdown },
  };
}

/**
 * Count the links a comment contains, in both markdown forms.
 *
 * Counts the inline `[text](url)` and bare `<https://…>` autolink spellings,
 * plus reference definitions and bare URLs on their own. The point is only to
 * bound how much linking a single comment can do, so an undercount would be a
 * nuisance while an overcount would reject honest comments — the patterns err
 * towards counting, and the limit is three.
 */
export function countLinks(markdown: string): number {
  const withoutCode = stripCode(markdown);

  const inline = withoutCode.match(/!?\[[^\]]*\]\([^)\s]+/gu)?.length ?? 0;
  const autolinks = withoutCode.match(/<https?:\/\/[^>\s]+>/gu)?.length ?? 0;
  const bare =
    withoutCode.match(/(?:^|[\s(])(?:https?:\/\/|www\.)[^\s<>)]+/gu)?.length ??
    0;

  return Math.max(inline + autolinks, bare);
}

/**
 * Remove fenced and inline code so a link inside a code span is not counted.
 *
 * Someone explaining what a URL looks like should not be charged for it.
 */
function stripCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/gu, " ")
    .replace(/~~~[\s\S]*?~~~/gu, " ")
    .replace(/`[^`\n]*`/gu, " ");
}
