import { describe, expect, it } from "vitest";

import { liveQueryRows } from "./liveQueryRows";

describe("live query rows", () => {
    it("normalizes live query values to arrays", () => {
        const rows = [{ id: "one" }];

        expect(liveQueryRows(rows)).toBe(rows);
        expect(liveQueryRows({ id: "nope" })).toEqual([]);
    });
});
