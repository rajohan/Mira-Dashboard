import { describe, expect, test } from "bun:test";

import { taskRelativeTime } from "./taskPresentation.ts";

describe("task relative-time presentation", () => {
    const nowMs = 1_800_000_000_000;

    test("preserves real task ages", () => {
        expect(taskRelativeTime(nowMs - 3 * 60 * 60_000, nowMs)).toBe("3 hours ago");
    });

    test("clamps a future task update to the presentation clock", () => {
        expect(taskRelativeTime(nowMs + 5 * 30 * 86_400_000, nowMs)).toBe(
            "0 seconds ago"
        );
    });
});
