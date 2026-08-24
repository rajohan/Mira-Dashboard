import { describe, expect, test } from "bun:test";

import {
    collectSystemHostPayload,
    type SystemHostAdapter,
} from "./systemHostProvider.ts";

function adapter(overrides: Partial<SystemHostAdapter> = {}): SystemHostAdapter {
    return {
        architecture: () => "x64",
        freeMemoryBytes: () => 400,
        hostname: () => "dashboard-host",
        platform: () => "linux",
        release: () => "6.8.0",
        rootFilesystem: () => Promise.resolve({ bavail: 5n, blocks: 10n, bsize: 100n }),
        totalMemoryBytes: () => 1000,
        uptimeSeconds: () => 12.9,
        ...overrides,
    };
}

describe("system host cache provider", () => {
    test("collects bounded host and bigint-safe filesystem data without a shell", () => {
        expect(collectSystemHostPayload(adapter())).resolves.toEqual({
            architecture: "x64",
            disk: { freeBytes: 500, path: "/", totalBytes: 1000 },
            hostname: "dashboard-host",
            memory: { freeBytes: 400, totalBytes: 1000 },
            platform: "linux",
            release: "6.8.0",
            uptimeSeconds: 12,
        });
    });

    test("rejects unsafe byte products and control-bearing host strings", () => {
        expect(
            collectSystemHostPayload(
                adapter({
                    rootFilesystem: () =>
                        Promise.resolve({
                            bavail: 1n,
                            blocks: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
                            bsize: 1n,
                        }),
                })
            )
        ).rejects.toThrow("outside the safe integer range");
        expect(
            collectSystemHostPayload(adapter({ hostname: () => "bad\nhost" }))
        ).rejects.toThrow();
    });
});
