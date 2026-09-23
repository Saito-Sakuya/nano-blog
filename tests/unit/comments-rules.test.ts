import { describe, expect, it } from "vitest";

import type { CommentInput } from "../../src/lib/comments/rules";
import {
  MAX_BODY_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_LINKS,
  MAX_NAME_LENGTH,
  countLinks,
  validateComment,
} from "../../src/lib/comments/rules";

/**
 * The acceptance rules for a submitted comment.
 *
 * Written from the point of view of someone posting directly to the endpoint,
 * because that is who the limits are for: the form's `maxlength` attributes are
 * a courtesy to honest commenters, and every rule below has to hold on its own
 * when the form is bypassed entirely.
 */

/*
 * The clock is a parameter rather than a reading of the wall clock, so these
 * tests are deterministic and none of them has to wait for real time to pass.
 */
const NOW = new Date("2026-09-17T12:00:00.000Z");

/** Unix seconds for a moment a given number of seconds before NOW. */
function secondsAgo(seconds: number): number {
  return Math.floor(NOW.getTime() / 1000) - seconds;
}

/**
 * A submission that passes, which each test then perturbs.
 *
 * The return type is loose on purpose: many tests below pass a value of the
 * wrong type — a number where a string belongs, `undefined`, `null` — because
 * that is what a request body arriving from the network can actually contain.
 * Naming the type precisely here would make those cases impossible to write.
 */
function submission(overrides: Record<string, unknown> = {}) {
  return {
    postId: "notes/first-note",
    authorName: "一位读者",
    email: "reader@example.invalid",
    bodyMarkdown: "这是一条**正常**的评论。",
    trap: "",
    // Twelve seconds of reading before replying, which is what a person does.
    renderedAt: secondsAgo(12),
    ...overrides,
  };
}

/** The failure code of a rejected submission, or a marker when it was accepted. */
function codeFor(overrides: Record<string, unknown>): string {
  // One cast, at the boundary: `validateComment` takes `unknown` fields by
  // design, so the test can hand it values a type system would forbid.
  const result = validateComment(submission(overrides) as CommentInput, NOW);
  return result.ok ? "(accepted)" : result.failure.code;
}

describe("validateComment — accepting an ordinary comment", () => {
  it("accepts a well-formed submission", () => {
    const result = validateComment(submission() as CommentInput, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.postId).toBe("notes/first-note");
    expect(result.value.authorName).toBe("一位读者");
    expect(result.value.bodyMarkdown).toContain("正常");
  });

  it("accepts a nested content path", () => {
    expect(codeFor({ postId: "dev/web/deep/nested" })).toBe("(accepted)");
  });

  it("normalises line endings and trims surrounding whitespace", () => {
    const result = validateComment(
      submission({ bodyMarkdown: "\r\n  hello there  \r\n" }) as CommentInput,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.bodyMarkdown).toBe("hello there");
  });

  it("collapses newlines in a display name onto one line", () => {
    // A name is placed in markup; a newline in it is either a mistake or an
    // attempt to disturb the layout around it.
    const result = validateComment(
      submission({ authorName: "A\nB\tC" }) as CommentInput,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.authorName).toBe("A B C");
  });

  it("returns the email trimmed, which is what gets hashed", () => {
    // Nothing stores this; the caller hashes it. The rule's job is to check it.
    const result = validateComment(
      submission({ email: " A@B.example " }) as CommentInput,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.email).toBe("A@B.example");
  });
});

describe("validateComment — honeypot", () => {
  it("rejects a submission that filled the hidden field", () => {
    expect(codeFor({ trap: "http://spam.example" })).toBe("trap");
  });

  it("rejects a single character in the hidden field", () => {
    expect(codeFor({ trap: "x" })).toBe("trap");
  });

  it("accepts an empty or absent honeypot", () => {
    expect(codeFor({ trap: "" })).toBe("(accepted)");
    expect(codeFor({ trap: "   " })).toBe("(accepted)");
    expect(codeFor({ trap: undefined })).toBe("(accepted)");
  });
});

describe("validateComment — timing", () => {
  it("rejects a submission that arrived faster than a person could type", () => {
    expect(codeFor({ renderedAt: secondsAgo(0) })).toBe("timing");
    expect(codeFor({ renderedAt: secondsAgo(2) })).toBe("timing");
  });

  it("accepts a submission at the threshold", () => {
    expect(codeFor({ renderedAt: secondsAgo(3) })).toBe("(accepted)");
  });

  it("accepts a submission from a reader who took their time", () => {
    expect(codeFor({ renderedAt: secondsAgo(600) })).toBe("(accepted)");
  });

  it("rejects a form older than the window", () => {
    expect(codeFor({ renderedAt: secondsAgo(60 * 60 * 13) })).toBe("timing");
  });

  it("accepts a form at the edge of the window", () => {
    expect(codeFor({ renderedAt: secondsAgo(60 * 60 * 12) })).toBe(
      "(accepted)",
    );
  });

  it("rejects a timestamp from the future, which no page can report", () => {
    // A negative elapsed time is not a very fast reader; it is a forged value.
    expect(codeFor({ renderedAt: secondsAgo(-60) })).toBe("timing");
  });

  it("accepts a numeric string, which is how a form field arrives", () => {
    expect(codeFor({ renderedAt: String(secondsAgo(30)) })).toBe("(accepted)");
  });

  /*
   * The no-JavaScript path, and the reason the check is optional.
   *
   * A static page cannot know when it was viewed, so the timestamp exists only
   * when the page script ran. A submission without one comes from a reader whose
   * browser did not run it, and refusing them would trade a real capability for
   * a filter that a bot skips by sending nothing either. The honeypot needs no
   * script, and human review is the gate that actually holds.
   */
  it("accepts a submission with no timestamp at all", () => {
    expect(codeFor({ renderedAt: undefined })).toBe("(accepted)");
    expect(codeFor({ renderedAt: null })).toBe("(accepted)");
  });

  it("treats an empty timestamp field as no timestamp", () => {
    /*
     * This is how the no-JavaScript submission actually arrives: a form field
     * with no value is submitted as an empty string rather than omitted. Reading
     * it as zero made every such submission look like a timestamp from 1970 and
     * be rejected as stale — the exact opposite of letting the reader comment.
     */
    expect(codeFor({ renderedAt: "" })).toBe("(accepted)");
    expect(codeFor({ renderedAt: "   " })).toBe("(accepted)");
  });

  it("rejects a timestamp that is not a number", () => {
    expect(codeFor({ renderedAt: "later" })).toBe("timing");
    expect(codeFor({ renderedAt: {} })).toBe("timing");
    expect(codeFor({ renderedAt: Number.NaN })).toBe("timing");
  });
});

describe("validateComment — the page identifier", () => {
  it("rejects the shapes a path traversal would need", () => {
    for (const postId of [
      "../../etc/passwd",
      "notes/../../secret",
      "/notes/first-note",
      "notes/first-note/",
      "notes//first-note",
      "notes/First-Note",
      "notes/first_note",
      "notes/first note",
      "notes/first-note\u0000",
      "notes\\first-note",
    ]) {
      expect(codeFor({ postId }), postId).not.toBe("(accepted)");
    }
  });

  it("rejects an empty or non-string page identifier", () => {
    expect(codeFor({ postId: "" })).toBe("post-id");
    expect(codeFor({ postId: 42 })).toBe("post-id");
    expect(codeFor({ postId: undefined })).toBe("post-id");
  });

  it("rejects an over-long identifier", () => {
    expect(codeFor({ postId: "a".repeat(600) })).toBe("post-id-shape");
  });
});

describe("validateComment — name", () => {
  it("requires a name", () => {
    expect(codeFor({ authorName: "" })).toBe("name");
    expect(codeFor({ authorName: "   " })).toBe("name");
    expect(codeFor({ authorName: undefined })).toBe("name");
    expect(codeFor({ authorName: "  \n  " })).toBe("name");
  });

  it("counts the limit in code points, not UTF-16 units", () => {
    // Astral characters are two UTF-16 units each, so a naive `.length` check
    // would reject half as many as it should.
    const astral = "𝄞".repeat(MAX_NAME_LENGTH);
    expect(codeFor({ authorName: astral })).toBe("(accepted)");
    expect(codeFor({ authorName: "𝄞".repeat(MAX_NAME_LENGTH + 1) })).toBe(
      "name",
    );
  });

  it("rejects a name containing a control character", () => {
    expect(codeFor({ authorName: "a\u0000b" })).toBe("name");
    expect(codeFor({ authorName: "a\u001bb" })).toBe("name");
  });

  it("accepts a name with punctuation and emoji", () => {
    expect(codeFor({ authorName: "A. Nonymous 🌱" })).toBe("(accepted)");
  });
});

describe("validateComment — email", () => {
  it("requires an address", () => {
    expect(codeFor({ email: "" })).toBe("email");
    expect(codeFor({ email: "   " })).toBe("email");
    expect(codeFor({ email: undefined })).toBe("email");
  });

  it("rejects shapes that are not addresses", () => {
    for (const email of [
      "plain",
      "@example.invalid",
      "reader@",
      "reader@nodot",
      "a@b@c.example",
      "reader @example.invalid",
      "reader@exam ple.com",
    ]) {
      expect(codeFor({ email }), email).toBe("email");
    }
  });

  it("accepts the shapes a real address can take", () => {
    for (const email of [
      "reader@example.invalid",
      "first.last@example.co.uk",
      "reader+tag@example.invalid",
      "reader_name@sub.example.org",
      "r@e.io",
    ]) {
      expect(codeFor({ email }), email).toBe("(accepted)");
    }
  });

  it("rejects an address longer than an address can be", () => {
    const local = "a".repeat(MAX_EMAIL_LENGTH);
    expect(codeFor({ email: `${local}@example.invalid` })).toBe("email");
  });
});

describe("validateComment — body", () => {
  it("requires a body", () => {
    expect(codeFor({ bodyMarkdown: "" })).toBe("body");
    expect(codeFor({ bodyMarkdown: "   \n  " })).toBe("body");
    expect(codeFor({ bodyMarkdown: undefined })).toBe("body");
  });

  it("rejects a single character, which is not a reply", () => {
    expect(codeFor({ bodyMarkdown: "x" })).toBe("body");
    expect(codeFor({ bodyMarkdown: "好" })).toBe("body");
    expect(codeFor({ bodyMarkdown: "ok" })).toBe("(accepted)");
  });

  it("counts the limit in code points", () => {
    expect(codeFor({ bodyMarkdown: "字".repeat(MAX_BODY_LENGTH) })).toBe(
      "(accepted)",
    );
    expect(codeFor({ bodyMarkdown: "字".repeat(MAX_BODY_LENGTH + 1) })).toBe(
      "body",
    );
    expect(codeFor({ bodyMarkdown: "𝄞".repeat(MAX_BODY_LENGTH) })).toBe(
      "(accepted)",
    );
  });

  it("rejects a body containing a null or other control character", () => {
    expect(codeFor({ bodyMarkdown: "hello\u0000world" })).toBe("body");
  });

  it("allows tab and newline, which are ordinary in a comment", () => {
    expect(codeFor({ bodyMarkdown: "line one\n\nline two\tindented" })).toBe(
      "(accepted)",
    );
  });

  it("accepts markdown formatting", () => {
    expect(
      codeFor({
        bodyMarkdown:
          "> quoted\n\n- list\n\n`code` and **bold** and [a link](https://example.invalid)",
      }),
    ).toBe("(accepted)");
  });
});

describe("countLinks", () => {
  it("counts markdown links", () => {
    expect(countLinks("see [one](https://a.example)")).toBe(1);
    expect(countLinks("[a](https://a.example) [b](https://b.example)")).toBe(2);
  });

  it("counts bare URLs and autolinks", () => {
    expect(countLinks("go to https://example.invalid/x now")).toBe(1);
    expect(countLinks("<https://example.invalid/x>")).toBe(1);
    expect(countLinks("see https://a.example and https://b.example")).toBe(2);
  });

  it("does not charge for a URL inside code", () => {
    // Someone explaining what a URL looks like should not be limited for it.
    expect(countLinks("write `https://example.invalid` to visit")).toBe(0);
    expect(countLinks("```\nhttps://example.invalid\n```")).toBe(0);
    expect(
      countLinks(
        "```\n[a](https://a.example)\n[b](https://b.example)\n[c](https://c.example)\n[d](https://d.example)\n```",
      ),
    ).toBe(0);
  });

  it("counts nothing in a comment that has no links", () => {
    expect(countLinks("text only")).toBe(0);
  });
});

describe("validateComment — link budget", () => {
  it("accepts a comment at the link limit and rejects one past it", () => {
    const at = Array.from(
      { length: MAX_LINKS },
      (_, index) => `[${String(index)}](https://e${String(index)}.example)`,
    ).join(" ");
    expect(codeFor({ bodyMarkdown: at })).toBe("(accepted)");

    const past = Array.from(
      { length: MAX_LINKS + 1 },
      (_, index) => `[${String(index)}](https://e${String(index)}.example)`,
    ).join(" ");
    expect(codeFor({ bodyMarkdown: past })).toBe("links");
  });

  it("reports how many links were found", () => {
    const result = validateComment(
      submission({
        bodyMarkdown:
          "[a](https://a.example) [b](https://b.example) [c](https://c.example) [d](https://d.example)",
      }) as CommentInput,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.message).toContain("4");
  });
});

describe("validateComment — the first failure is the one reported", () => {
  it("reports the honeypot before anything else", () => {
    // A bot that fills the trap also tends to get everything else wrong; the
    // trap is the cheapest signal and should decide the outcome.
    expect(
      codeFor({ trap: "x", authorName: "", email: "", bodyMarkdown: "" }),
    ).toBe("trap");
  });

  it("reports timing before field contents", () => {
    expect(
      codeFor({
        renderedAt: secondsAgo(0),
        authorName: "",
        email: "",
        bodyMarkdown: "",
      }),
    ).toBe("timing");
  });
});
