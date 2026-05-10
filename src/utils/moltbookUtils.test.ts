import { describe, expect, it } from "vitest";

import { formatTime, getMoltbookUrl, truncate } from "./moltbookUtils";

describe("moltbook utils", () => {
    it("truncates long text only when needed", () => {
        expect(truncate("short", 10)).toBe("short");
        expect(truncate("long text", 4)).toBe("long...");
    });

    it("builds absolute Moltbook URLs", () => {
        expect(getMoltbookUrl("/posts/123")).toBe("https://www.moltbook.com/posts/123");
    });

    it("formats relative time", () => {
        expect(formatTime(new Date().toISOString())).toEqual(expect.any(String));
    });
});
