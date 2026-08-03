import { describe, expect, it, jest } from "bun:test";

import gateway from "../../src/services/gateway/runtime.ts";
import {
    getOpenClawCronListSnapshot,
    normalizeOpenClawCronJobs,
} from "../../src/services/openClawCronSnapshot.ts";

describe("OpenClaw cron snapshot", () => {
    it("normalizes the current Gateway jobs response and accepts an empty list", () => {
        expect(
            normalizeOpenClawCronJobs<{ id: string }>({
                jobs: [{ id: "job" }],
            })
        ).toEqual([{ id: "job" }]);
        expect(normalizeOpenClawCronJobs({ jobs: [] })).toEqual([]);
    });

    it("rejects malformed payloads and cron entries", () => {
        for (const payload of [
            undefined,
            [],
            {},
            { jobs: [undefined] },
            { items: [{ id: "obsolete" }] },
            { jobs: ["invalid"] },
        ]) {
            expect(() => normalizeOpenClawCronJobs(payload)).toThrow(
                "Invalid OpenClaw cron list response"
            );
        }
    });

    it("records malformed Gateway responses as snapshot load failures", () => {
        jest.spyOn(gateway, "request").mockResolvedValue({});

        expect(getOpenClawCronListSnapshot()).rejects.toThrow(
            "Invalid OpenClaw cron list response"
        );
    });
});
