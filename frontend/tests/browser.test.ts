import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBrowser, pythonInVenv } from "../e2e/browser";

describe("e2e browser lookup", () => {
  it("prefers $CHROMIUM, then PATH", () => {
    expect(findBrowser({ CHROMIUM: "/x/chrome" }, () => false)).toBe("/x/chrome");
    const onPath = join("/opt/bin", "google-chrome");
    expect(findBrowser({ PATH: ["/usr/bin", "/opt/bin"].join(delimiter) }, p => p === onPath)).toBe(onPath);
    expect(findBrowser({ PATH: "/nothing" }, () => false)).toBeUndefined();
  });
  it("venv python path", () => {
    expect(pythonInVenv("b")).toBe("b/.venv/bin/python");
  });
});
