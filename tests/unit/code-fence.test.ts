import { describe, expect, it } from "vitest";

import {
  CodeFenceError,
  isPlainFence,
  parseCodeFence,
} from "../../src/lib/markdown/code-fence";

describe("parseCodeFence", () => {
  it("reads a language on its own", () => {
    expect(parseCodeFence("ts")).toMatchObject({
      lang: "ts",
      title: null,
      showLineNumbers: false,
      highlight: [],
    });
  });

  it("reads a quoted title", () => {
    expect(parseCodeFence('ts title="示例代码"').title).toBe("示例代码");
  });

  it("preserves spaces inside a quoted title", () => {
    expect(parseCodeFence('ts title="a b c"').title).toBe("a b c");
  });

  it("reads the line-number flag", () => {
    expect(parseCodeFence("ts showLineNumbers").showLineNumbers).toBe(true);
  });

  it("expands highlight ranges into zero-based indexes", () => {
    expect(parseCodeFence("ts {2,4-6}").highlight).toEqual([1, 3, 4, 5]);
  });

  it("de-duplicates and sorts overlapping highlight entries", () => {
    expect(parseCodeFence("ts {3,1-2,2}").highlight).toEqual([0, 1, 2]);
  });

  it("reads a full info string", () => {
    const meta = parseCodeFence('ts title="示例" showLineNumbers {2}', 5);
    expect(meta).toMatchObject({
      lang: "ts",
      title: "示例",
      showLineNumbers: true,
      highlight: [1],
    });
  });

  it("accepts an empty info string", () => {
    expect(parseCodeFence("")).toMatchObject({ lang: null, title: null });
  });
});

describe("parseCodeFence rejections", () => {
  it("rejects an unclosed quote", () => {
    expect(() => parseCodeFence('ts title="oops')).toThrow(CodeFenceError);
  });

  it("rejects a reversed range", () => {
    expect(() => parseCodeFence("ts {6-2}")).toThrow(/reversed/u);
  });

  it("rejects zero and negative line numbers", () => {
    expect(() => parseCodeFence("ts {0}")).toThrow(CodeFenceError);
    expect(() => parseCodeFence("ts {-1}")).toThrow(CodeFenceError);
    expect(() => parseCodeFence("ts {0-3}")).toThrow(CodeFenceError);
  });

  it("rejects a highlight line beyond the end of the block", () => {
    expect(() => parseCodeFence("ts {9}", 3)).toThrow(/beyond the end/u);
  });

  it("accepts the last line exactly", () => {
    expect(() => parseCodeFence("ts {3}", 3)).not.toThrow();
  });

  it("rejects an unknown option", () => {
    expect(() => parseCodeFence("ts nonsense")).toThrow(
      /Unknown code fence option/u,
    );
  });

  it("rejects an unquoted title", () => {
    expect(() => parseCodeFence("ts title=oops")).toThrow(/double-quoted/u);
  });

  it("rejects an empty highlight entry", () => {
    expect(() => parseCodeFence("ts {1,,2}")).toThrow(CodeFenceError);
  });
});

describe("isPlainFence", () => {
  it("is true for language-only fences", () => {
    expect(isPlainFence(parseCodeFence("ts"))).toBe(true);
  });

  it("is false when any decoration is present", () => {
    expect(isPlainFence(parseCodeFence('ts title="x"'))).toBe(false);
    expect(isPlainFence(parseCodeFence("ts showLineNumbers"))).toBe(false);
    expect(isPlainFence(parseCodeFence("ts {1}"))).toBe(false);
  });
});
