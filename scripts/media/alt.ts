import { ValidationError } from "../lib/errors.js";
import { codePointLength, hasControlCharacters } from "../lib/unicode.js";

/**
 * Alt text validation.
 *
 * Alt text is the only description of an image that a screen reader user, or a
 * reader whose image failed to load, will ever get. It has to say what the
 * picture shows. "图片", a file name, or a placeholder is not a description,
 * and accepting one would make every downstream accessibility check meaningless
 * while looking green.
 *
 * The rules are deliberately mechanical so the same input always gets the same
 * answer: length in Unicode code points, a required letter or digit, and a
 * rejection list for the specific non-descriptions that are actually common.
 */

export const ALT_MIN_LENGTH = 4;
export const ALT_MAX_LENGTH = 160;

const PLACEHOLDER_VALUES = new Set([
  "图片",
  "封面",
  "照片",
  "图像",
  "截图",
  "插图",
  "配图",
  "未命名",
  "无",
  "暂无",
  "image",
  "images",
  "img",
  "photo",
  "picture",
  "pic",
  "screenshot",
  "cover",
  "thumbnail",
  "untitled",
  "placeholder",
  "test",
  "testing",
  "todo",
  "tbd",
  "xxx",
  "asdf",
  "alt",
  "alt text",
  "figure",
  "graphic",
  "banner",
  "hero",
  "dummy",
  "sample",
  "example",
]);

/**
 * A name that is obviously a file: an image extension, or a path-like string.
 */
const FILENAME_LIKE =
  /(^|[\s"'(])([\w.-]+\.(?:jpe?g|png|gif|webp|avif|tiff?|svg|heic|bmp))(\s|$|["')])/iu;
const PATH_LIKE = /(^|[\s"'(])[\w.-]*[/\\][\w./\\-]+/u;

const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const ONLY_DIGITS_OR_PUNCTUATION = /^[\p{P}\p{S}\p{N}\s]+$/u;

export interface AltValidation {
  readonly ok: boolean;
  readonly issue: string | null;
}

/** Check alt text without throwing. Empty string is valid only for decoration. */
export function validateAlt(value: string): AltValidation {
  if (value !== value.trim()) {
    return {
      ok: false,
      issue: "Alt text must not begin or end with whitespace.",
    };
  }

  if (hasControlCharacters(value)) {
    return {
      ok: false,
      issue: "Alt text must not contain control characters.",
    };
  }

  const normalized = value.normalize("NFC");
  const length = codePointLength(normalized);

  if (length < ALT_MIN_LENGTH || length > ALT_MAX_LENGTH) {
    return {
      ok: false,
      issue: `Alt text must be ${ALT_MIN_LENGTH}–${ALT_MAX_LENGTH} characters long, but is ${length}.`,
    };
  }

  if (PLACEHOLDER_VALUES.has(normalized.trim().toLowerCase())) {
    return {
      ok: false,
      issue: `Alt text ${JSON.stringify(normalized)} is a placeholder, not a description of the image.`,
    };
  }

  if (FILENAME_LIKE.test(normalized) || PATH_LIKE.test(normalized)) {
    return {
      ok: false,
      issue:
        "Alt text looks like a file name or path; describe what the image shows instead.",
    };
  }

  if (!HAS_LETTER_OR_DIGIT.test(normalized)) {
    return {
      ok: false,
      issue: "Alt text must contain at least one letter or digit.",
    };
  }

  if (ONLY_DIGITS_OR_PUNCTUATION.test(normalized)) {
    return {
      ok: false,
      issue: "Alt text must contain words, not only digits or punctuation.",
    };
  }

  const characters = [...normalized];
  if (new Set(characters).size === 1) {
    return {
      ok: false,
      issue: "Alt text repeats a single character and describes nothing.",
    };
  }

  return { ok: true, issue: null };
}

/**
 * Validate and normalise alt text, returning the NFC form.
 *
 * The empty string is accepted only when the caller has already decided the
 * image is decorative — a cover never is, which is why `media:add` requires alt
 * text for every upload.
 */
export function assertAlt(value: string, label = "Alt text"): string {
  const result = validateAlt(value);
  if (!result.ok) {
    throw new ValidationError(`${label}: ${result.issue ?? "is not usable."}`);
  }
  return value.normalize("NFC");
}

/** Credit lines are short plain text; they are not alt text and have no minimum. */
export function assertCredit(value: string): string {
  if (value !== value.trim()) {
    throw new ValidationError("Credit must not begin or end with whitespace.");
  }
  const length = codePointLength(value.normalize("NFC"));
  if (length < 1 || length > 200) {
    throw new ValidationError(
      `Credit must be 1–200 characters long, but is ${length}.`,
    );
  }
  if (hasControlCharacters(value)) {
    throw new ValidationError("Credit must not contain control characters.");
  }
  return value.normalize("NFC");
}

/** An optional source or licence note attached to a media record. */
export function assertOptionalNote(
  value: string,
  label: string,
  max: number,
): string {
  if (value !== value.trim()) {
    throw new ValidationError(
      `${label} must not begin or end with whitespace.`,
    );
  }
  const length = codePointLength(value.normalize("NFC"));
  if (length < 1 || length > max) {
    throw new ValidationError(
      `${label} must be 1–${max} characters long, but is ${length}.`,
    );
  }
  if (hasControlCharacters(value)) {
    throw new ValidationError(`${label} must not contain control characters.`);
  }
  return value.normalize("NFC");
}
