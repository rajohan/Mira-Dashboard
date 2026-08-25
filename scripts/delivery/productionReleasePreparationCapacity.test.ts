import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    maximumProductionReleaseArchiveBytes,
    maximumProductionReleaseArtifactTreeBytes,
    maximumProductionReleaseReceiptBytes,
} from "../../src/shared/productionReleaseArtifactReceipt.ts";
import {
    admitProductionReleasePreparation,
    productionReleasePreparationCapacityPolicy,
} from "./productionReleasePreparationCapacity.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function capacityFixture() {
    const root = await mkdtemp(path.join(tmpdir(), "mira-capacity-"));
    temporaryDirectories.push(root);
    const checkoutRoot = path.join(root, "checkout");
    await mkdir(checkoutRoot);
    const measured: string[] = [];
    return {
        checkoutRoot,
        dependencies: {
            lstat: (target: string) => lstat(target, { bigint: true }),
            statfs: async (target: string) => {
                measured.push(target);
                const capacity = await statfs(target, { bigint: true });
                return {
                    ...capacity,
                    bavail: 1_000_000_000n,
                    ffree: 1_000_000_000n,
                };
            },
        },
        measured,
        root,
    };
}

describe("production release preparation capacity", () => {
    test("admits receipt, archive, extraction, and root staging ceilings", () => {
        expect(productionReleasePreparationCapacityPolicy.temporaryPreparationBytes).toBe(
            BigInt(maximumProductionReleaseArchiveBytes) +
                BigInt(maximumProductionReleaseReceiptBytes)
        );
        expect(productionReleasePreparationCapacityPolicy.hostPreparationBytes).toBe(
            BigInt(maximumProductionReleaseArchiveBytes) +
                BigInt(maximumProductionReleaseArtifactTreeBytes)
        );
    });

    test("measures an existing provisioning root instead of its parent", async () => {
        const fixture = await capacityFixture();
        const provisioningRoot = path.join(fixture.root, "provisioning");
        await mkdir(provisioningRoot);

        await admitProductionReleasePreparation(
            fixture.checkoutRoot,
            provisioningRoot,
            fixture.dependencies
        );

        expect(fixture.measured).toContain(provisioningRoot);
        expect(fixture.measured).not.toContain(fixture.root);
    });

    test("measures the existing parent before a provisioning root is created", async () => {
        const fixture = await capacityFixture();
        const provisioningRoot = path.join(fixture.root, "provisioning");

        await admitProductionReleasePreparation(
            fixture.checkoutRoot,
            provisioningRoot,
            fixture.dependencies
        );

        expect(fixture.measured).toContain(fixture.root);
        expect(fixture.measured).not.toContain(provisioningRoot);
    });
});
