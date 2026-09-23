import { ValidationError } from "../lib/errors.js";
import { hasBinaryControlCharacters } from "../lib/unicode.js";

/**
 * File type detection by signature.
 *
 * Extension is a claim; the first bytes are evidence. A `.png` that is really a
 * ZIP, or an HTML file renamed to `.jpg`, is rejected here rather than being
 * handed to the image pipeline — and the extension used in the bucket path is
 * derived from what the bytes actually are, not from what the file was called.
 *
 * Only the allowed types are recognised. Anything else is
 * refused, so "upload this random file" cannot become "publish this random file
 * to a public bucket".
 */

export type MediaKind = "image" | "audio" | "document";

export interface DetectedType {
  readonly mimeType: string;
  /** Extension used for `original.<ext>`, without the dot. */
  readonly extension: string;
  readonly kind: MediaKind;
  /** True when the image pipeline can produce responsive variants of it. */
  readonly derivable: boolean;
  readonly label: string;
}

/** Images are capped at 25 MiB; everything else at 50 MiB. */
export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const FILE_MAX_BYTES = 50 * 1024 * 1024;

export function maxBytesFor(kind: MediaKind): number {
  return kind === "image" ? IMAGE_MAX_BYTES : FILE_MAX_BYTES;
}

function startsWith(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
): boolean {
  if (bytes.length < offset + signature.length) return false;
  for (const [index, value] of signature.entries()) {
    if (bytes[offset + index] !== value) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function asciiAtAny(
  bytes: Uint8Array,
  offset: number,
  candidates: readonly string[],
): boolean {
  return candidates.some((candidate) => asciiAt(bytes, offset, candidate));
}

const ISO_BRANDS_AVIF = ["avif", "avis"];
const ISO_BRANDS_MP4 = ["M4A ", "M4B ", "mp42", "mp41", "isom", "iso2", "dash"];

/** True when the bytes look like UTF-8 text with no binary control characters. */
function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(sample);
  } catch {
    return false;
  }
  if (hasBinaryControlCharacters(decoded)) return false;
  return decoded.trim().length > 0;
}

/**
 * Identify a file from its leading bytes. Returns null when the type is not on
 * the allow-list.
 */
export function detectMimeType(bytes: Uint8Array): DetectedType | null {
  if (bytes.length < 12) return null;

  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return {
      mimeType: "image/jpeg",
      extension: "jpg",
      kind: "image",
      derivable: true,
      label: "JPEG",
    };
  }

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return {
      mimeType: "image/png",
      extension: "png",
      kind: "image",
      derivable: true,
      label: "PNG",
    };
  }

  if (asciiAtAny(bytes, 0, ["GIF87a", "GIF89a"])) {
    return {
      mimeType: "image/gif",
      extension: "gif",
      kind: "image",
      derivable: true,
      label: "GIF",
    };
  }

  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) {
    return {
      mimeType: "image/webp",
      extension: "webp",
      kind: "image",
      derivable: true,
      label: "WebP",
    };
  }

  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WAVE")) {
    return {
      mimeType: "audio/wav",
      extension: "wav",
      kind: "audio",
      derivable: false,
      label: "WAV",
    };
  }

  if (asciiAt(bytes, 4, "ftyp")) {
    if (asciiAtAny(bytes, 8, ISO_BRANDS_AVIF)) {
      return {
        mimeType: "image/avif",
        extension: "avif",
        kind: "image",
        derivable: true,
        label: "AVIF",
      };
    }
    if (asciiAtAny(bytes, 8, ISO_BRANDS_MP4)) {
      return {
        mimeType: "audio/mp4",
        extension: "m4a",
        kind: "audio",
        derivable: false,
        label: "MP4 audio",
      };
    }
    return null;
  }

  if (
    startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return {
      mimeType: "image/tiff",
      extension: "tif",
      kind: "image",
      derivable: true,
      label: "TIFF",
    };
  }

  if (asciiAt(bytes, 0, "fLaC")) {
    return {
      mimeType: "audio/flac",
      extension: "flac",
      kind: "audio",
      derivable: false,
      label: "FLAC",
    };
  }

  if (asciiAt(bytes, 0, "OggS")) {
    return {
      mimeType: "audio/ogg",
      extension: "ogg",
      kind: "audio",
      derivable: false,
      label: "Ogg",
    };
  }

  if (
    asciiAt(bytes, 0, "ID3") ||
    startsWith(bytes, [0xff, 0xfb]) ||
    startsWith(bytes, [0xff, 0xf3])
  ) {
    return {
      mimeType: "audio/mpeg",
      extension: "mp3",
      kind: "audio",
      derivable: false,
      label: "MP3",
    };
  }

  if (asciiAt(bytes, 0, "%PDF-")) {
    return {
      mimeType: "application/pdf",
      extension: "pdf",
      kind: "document",
      derivable: false,
      label: "PDF",
    };
  }

  if (
    startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])
  ) {
    const head = Buffer.from(
      bytes.subarray(0, Math.min(bytes.length, 4096)),
    ).toString("latin1");
    if (head.includes("application/epub+zip")) {
      return {
        mimeType: "application/epub+zip",
        extension: "epub",
        kind: "document",
        derivable: false,
        label: "EPUB",
      };
    }
    return {
      mimeType: "application/zip",
      extension: "zip",
      kind: "document",
      derivable: false,
      label: "ZIP",
    };
  }

  if (looksLikeText(bytes)) {
    return {
      mimeType: "text/plain; charset=utf-8",
      extension: "txt",
      kind: "document",
      derivable: false,
      label: "plain text",
    };
  }

  return null;
}

/**
 * Detect and check a file: an unknown signature or an oversize file is a clear
 * failure with both the detected type and the actual size in the message.
 */
export function assertAllowedFile(
  bytes: Uint8Array,
  label: string,
): DetectedType {
  const detected = detectMimeType(bytes);
  if (detected === null) {
    throw new ValidationError(
      `${label} is not one of the accepted file types. Images (JPEG, PNG, GIF, WebP, AVIF, TIFF), audio (MP3, M4A, OGG, WAV, FLAC), PDF, EPUB, ZIP and plain text are accepted, identified by content and not by file extension.`,
    );
  }

  const limit = maxBytesFor(detected.kind);
  if (bytes.byteLength > limit) {
    throw new ValidationError(
      `${label} is ${bytes.byteLength} bytes; ${detected.label} files are limited to ${limit} bytes.`,
    );
  }

  return detected;
}
