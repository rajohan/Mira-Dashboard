import { describe, expect, test } from "bun:test";

import { maximumProcessMemory, startProcessMemorySampler } from "./processMemory.ts";

describe("process memory samples", () => {
    test("keeps independent high-water values", () => {
        expect(
            maximumProcessMemory(
                { rssBytes: 100, unsafeFootprintBytes: 80 },
                { rssBytes: 90, unsafeFootprintBytes: 95 }
            )
        ).toEqual({ rssBytes: 100, unsafeFootprintBytes: 95 });
    });

    test("preserves an unavailable Bun footprint", () => {
        expect(
            maximumProcessMemory(
                { rssBytes: 100, unsafeFootprintBytes: null },
                { rssBytes: 110, unsafeFootprintBytes: 95 }
            )
        ).toEqual({ rssBytes: 110, unsafeFootprintBytes: null });
    });

    test("samples checkpoints and stops idempotently", () => {
        const samples = [
            { rssBytes: 110, unsafeFootprintBytes: 70 },
            { rssBytes: 105, unsafeFootprintBytes: 95 },
            { rssBytes: 120, unsafeFootprintBytes: 90 },
        ];
        const sampler = startProcessMemorySampler(
            { rssBytes: 100, unsafeFootprintBytes: 80 },
            1000,
            () => samples.shift() ?? { rssBytes: 1, unsafeFootprintBytes: 1 }
        );

        expect(sampler.sample()).toEqual({
            rssBytes: 110,
            unsafeFootprintBytes: 80,
        });
        expect(sampler.sample()).toEqual({
            rssBytes: 110,
            unsafeFootprintBytes: 95,
        });
        expect(sampler.stop()).toEqual({
            rssBytes: 120,
            unsafeFootprintBytes: 95,
        });
        expect(sampler.stop()).toEqual({
            rssBytes: 120,
            unsafeFootprintBytes: 95,
        });
        expect(() => sampler.sample()).toThrow("already stopped");
    });

    test("rejects invalid sample intervals", () => {
        expect(() =>
            startProcessMemorySampler({ rssBytes: 1, unsafeFootprintBytes: 1 }, 0)
        ).toThrow("positive integer");
    });
});
