import { describe, expect, it, jest } from "bun:test";

import gateway from "../src/gateway.ts";
import {
    getOpenClawCronListSnapshot,
    normalizeOpenClawCronJobs,
} from "../src/services/openClawCronSnapshot.ts";

describe("OpenClaw cron snapshot", () => {
    it("normalizes jobs before items and accepts a healthy empty list", () => {
        expect(
            normalizeOpenClawCronJobs<{ id: string }>({
                items: [{ id: "item" }],
                jobs: [{ id: "job" }],
            })
        ).toEqual([{ id: "job" }]);
        expect(
            normalizeOpenClawCronJobs<{ id: string }>({
                items: [{ id: "item" }],
                jobs: "unavailable",
            })
        ).toEqual([{ id: "item" }]);
        expect(normalizeOpenClawCronJobs({ jobs: [] })).toEqual([]);
    });

    it("rejects malformed payloads and cron entries", () => {
        for (const payload of [
            undefined,
            [],
            {},
            { jobs: [undefined] },
            { items: [[]] },
            { jobs: ["invalid"] },
        ]) {
            expect(() => normalizeOpenClawCronJobs(payload)).toThrow(
                "Invalid OpenClaw cron list response"
            );
        }
    });

    it("records malformed Gateway responses as snapshot load failures", async () => {
        jest.spyOn(gateway, "request").mockResolvedValue({});

        await expect(getOpenClawCronListSnapshot()).rejects.toThrow(
            "Invalid OpenClaw cron list response"
        );
    });
});
