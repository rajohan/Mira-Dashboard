import { describe, expect, test } from "bun:test";

import {
    parseProductionReleaseDescriptor,
    serializeProductionReleaseDescriptor,
} from "./productionReleaseDescriptor.ts";

const releaseId = "a".repeat(40);
const runtimeRevision = "b".repeat(40);
const runtimeSha256 = "c".repeat(64);
const executorSha256 = "d".repeat(64);

function descriptor() {
    return {
        artifacts: [
            { bytes: 12, path: "release-manifest.json", sha256: "e".repeat(64) },
            {
                bytes: 20,
                path: "runtime/bun",
                sha256: runtimeSha256,
            },
            {
                bytes: 30,
                path: "server/productionDelivery.js",
                sha256: executorSha256,
            },
        ],
        deliveryExecutor: {
            bytes: 30,
            path: "server/productionDelivery.js",
            sha256: executorSha256,
        },
        formatVersion: 1,
        releaseId,
        runtime: {
            executable: {
                bytes: 20,
                path: "runtime/bun",
                sha256: runtimeSha256,
            },
            revision: runtimeRevision,
            version: "1.2.3",
        },
    };
}

describe("production release descriptor", () => {
    test("accepts and freezes the stable v1 transport contract", () => {
        const parsed = parseProductionReleaseDescriptor(descriptor());

        expect(parsed.releaseId).toBe(releaseId);
        expect(Object.isFrozen(parsed)).toBe(true);
        expect(Object.isFrozen(parsed.artifacts)).toBe(true);
        expect(serializeProductionReleaseDescriptor(parsed)).toEndWith("\n");
    });

    test("rejects unsorted, extra, or mismatched executable records", () => {
        const valid = descriptor();
        expect(() =>
            parseProductionReleaseDescriptor({
                ...valid,
                artifacts: valid.artifacts.toReversed(),
            })
        ).toThrow("Production release descriptor is invalid");
        expect(() =>
            parseProductionReleaseDescriptor({ ...valid, future: true })
        ).toThrow("Production release descriptor is invalid");
        expect(() =>
            parseProductionReleaseDescriptor({
                ...valid,
                deliveryExecutor: { ...valid.deliveryExecutor, bytes: 31 },
            })
        ).toThrow("Production release descriptor is invalid");
    });
});
