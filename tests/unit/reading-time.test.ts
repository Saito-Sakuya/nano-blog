import { describe, expect, it } from "vitest";

import { readingTime } from "../../src/lib/content/reading-time";

describe("readingTime", () => {
  it("never reports less than one minute", () => {
    expect(readingTime("").minutes).toBe(1);
    expect(readingTime("hi").minutes).toBe(1);
    expect(readingTime("hi").label).toBe("约 1 分钟");
  });

  it("uses the CJK rate of 500 characters per minute", () => {
    // 500 CJK characters is one minute; 501 rounds up to two.
    expect(readingTime("字".repeat(500)).minutes).toBe(1);
    expect(readingTime("字".repeat(501)).minutes).toBe(2);
  });

  it("uses the Latin rate of 220 words per minute", () => {
    const words = Array.from({ length: 220 }, () => "word").join(" ");
    expect(readingTime(words).minutes).toBe(1);
    expect(readingTime(`${words} extra`).minutes).toBe(2);
  });

  it("counts code lines at 30 per minute", () => {
    const code = [
      "```ts",
      ...Array.from({ length: 31 }, (_, i) => `const a${i} = ${i};`),
      "```",
    ].join("\n");
    expect(readingTime(code).minutes).toBe(2);
  });

  it("ignores blank lines inside a code block", () => {
    const code = ["```ts", "const a = 1;", "", "", "", "```"].join("\n");
    expect(readingTime(code).minutes).toBe(1);
  });

  it("excludes image alt text", () => {
    const withAlt = `![${"字".repeat(600)}](/media/a/1600.webp)`;
    expect(readingTime(withAlt).minutes).toBe(1);
  });

  it("excludes frontmatter, which is not part of the body", () => {
    // The caller passes a body with frontmatter already removed; a body that
    // happens to contain a thematic break must not be mistaken for one.
    expect(readingTime("---\n\n见上。").minutes).toBe(1);
  });

  it("combines all three rates in one document", () => {
    const body = [
      "字".repeat(500),
      Array.from({ length: 220 }, () => "word").join(" "),
      [
        "```ts",
        ...Array.from({ length: 30 }, (_, i) => `const a${i} = ${i};`),
        "```",
      ].join("\n"),
    ].join("\n\n");
    expect(readingTime(body).minutes).toBe(3);
  });

  it("does not throw on a body that is not valid Markdown", () => {
    expect(() => readingTime("```unclosed\nconst a = 1;")).not.toThrow();
  });
});
