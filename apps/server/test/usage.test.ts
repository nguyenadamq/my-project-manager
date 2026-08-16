import { describe, expect, it } from "vitest";
import { weeklyWindow } from "../src/services/usage.js";

describe("weekly usage window", () => {
  it("anchors to the configured reset weekday", () => {
    const { start, end } = weeklyWindow(new Date("2026-08-15T12:00:00"), 1);
    expect(start.getDay()).toBe(1); expect(end.getDay()).toBe(1);
    expect(end.getTime() - start.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
  it("starts today when today is reset day", () => {
    const now = new Date("2026-08-17T16:00:00"); const { start } = weeklyWindow(now, 1);
    expect(start.getDate()).toBe(17); expect(start.getHours()).toBe(0);
  });
});
