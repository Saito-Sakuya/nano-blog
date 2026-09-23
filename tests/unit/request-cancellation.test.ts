import { describe, expect, it } from "vitest";

import { isBrowserCancelledRequest } from "../e2e/request-cancellation";

const ORIGINS = ["http://localhost:4322", "http://127.0.0.1:4323"];

describe("browser request cancellation classification", () => {
  it.each(["NS_BINDING_ABORTED", "Load request cancelled", "net::ERR_ABORTED"])(
    "ignores %s on the site or configured media origin",
    (message) => {
      expect(
        isBrowserCancelledRequest(
          "http://localhost:4322/api/views/example",
          message,
          ORIGINS,
        ),
      ).toBe(true);
      expect(
        isBrowserCancelledRequest(
          "http://127.0.0.1:4323/media/abc/480.avif",
          message,
          ORIGINS,
        ),
      ).toBe(true);
    },
  );

  it("does not hide network failures or unrelated origins", () => {
    expect(
      isBrowserCancelledRequest(
        "http://127.0.0.1:4323/media/abc/480.avif",
        "NS_ERROR_CONNECTION_REFUSED",
        ORIGINS,
      ),
    ).toBe(false);
    expect(
      isBrowserCancelledRequest(
        "http://localhost:4322.evil.example/media/abc/480.avif",
        "NS_BINDING_ABORTED",
        ORIGINS,
      ),
    ).toBe(false);
    expect(
      isBrowserCancelledRequest("not a URL", "NS_BINDING_ABORTED", ORIGINS),
    ).toBe(false);
  });
});
