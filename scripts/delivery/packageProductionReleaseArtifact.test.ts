import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { createBunRuntimePolicy } from "../../src/shared/bunRuntimePolicy.ts";
import { maximumProductionReleaseArchiveBytes } from "../../src/shared/productionReleaseArtifactReceipt.ts";
import {
    createLocalReleaseFixture,
    removeProductionDeliveryFixtures,
} from "../testSupport/productionDeliveryFixture.ts";
import {
    packageProductionReleaseArtifact,
    productionReleaseArtifactReceiptSchema,
} from "./packageProductionReleaseArtifact.ts";

const bunRuntimePolicy = createBunRuntimePolicy("1.4.0");
const receipt = {
    archive: { bytes: 42, name: "release.tar", sha256: "a".repeat(64) },
    formatVersion: 1,
    releaseId: "b".repeat(40),
    releaseManifestSha256: "c".repeat(64),
    runtime: { revision: "d".repeat(40), version: bunRuntimePolicy.version },
};
const sourceProjectRoot = path.resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];

afterEach(() => removeProductionDeliveryFixtures(temporaryDirectories));

describe("production release artifact receipt", () => {
    test("admits the bounded digest-bound handoff format", () => {
        expect(v.parse(productionReleaseArtifactReceiptSchema, receipt)).toEqual(receipt);
    });

    test("rejects malformed archive identity and unknown fields", () => {
        expect(() =>
            v.parse(productionReleaseArtifactReceiptSchema, {
                ...receipt,
                archive: { ...receipt.archive, sha256: "short" },
            })
        ).toThrow();
        expect(() =>
            v.parse(productionReleaseArtifactReceiptSchema, {
                ...receipt,
                unexpected: true,
            })
        ).toThrow();
        expect(() =>
            v.parse(productionReleaseArtifactReceiptSchema, {
                ...receipt,
                archive: {
                    ...receipt.archive,
                    bytes: maximumProductionReleaseArchiveBytes + 1,
                },
            })
        ).toThrow();
    });

    test("packages and replaces one real immutable release handoff", async () => {
        const releaseId = "e".repeat(40);
        const runtime = { revision: "f".repeat(40), version: Bun.version };
        const releaseRoot = await createLocalReleaseFixture(
            sourceProjectRoot,
            releaseId,
            runtime,
            temporaryDirectories
        );
        const repositoryRoot = path.resolve(releaseRoot, "../../..");

        const first = await packageProductionReleaseArtifact({
            projectRoot: repositoryRoot,
            releaseId,
        });
        const second = await packageProductionReleaseArtifact({
            projectRoot: repositoryRoot,
            releaseId,
        });

        expect(second).toEqual(first);
        expect(second.runtime).toEqual(runtime);
        expect(
            v.parse(
                productionReleaseArtifactReceiptSchema,
                JSON.parse(
                    await readFile(
                        path.join(
                            repositoryRoot,
                            "dist/production-release-artifact/receipt.json"
                        ),
                        "utf8"
                    )
                ) as unknown
            )
        ).toEqual(second);
        expect(second.archive.bytes).toBeGreaterThan(0);
    });

    test("rejects an invalid explicit release identity", () => {
        expect(
            packageProductionReleaseArtifact({
                projectRoot: sourceProjectRoot,
                releaseId: "invalid",
            })
        ).rejects.toThrow("Production release artifact packaging failed");
    });
});
