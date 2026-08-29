import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const deliveryRoot = import.meta.dir;

describe("foreign release architecture boundary", () => {
    test("keeps semantic manifest parsing out of descriptor handoff modules", async () => {
        for (const relative of [
            "productionDeliveryExecutorOwnerState.ts",
            "productionReleasePublication.ts",
            "../../src/worker/delivery/productionDeliveryLauncher.ts",
            "../../src/worker/delivery/productionRecovery.ts",
        ]) {
            const source = await readFile(path.resolve(deliveryRoot, relative), "utf8");
            const marker = source.indexOf("publishDescribedProductionRelease");
            const handoffSource =
                marker === -1
                    ? source
                    : source.slice(marker, source.indexOf("\n/**", marker));
            expect(handoffSource).not.toContain("parseReleaseManifest(");
            expect(handoffSource).not.toContain("loadPublishedProductionRelease(");
            expect(handoffSource).not.toContain("verifyReleaseArtifactIdentity(");
        }
    });

    test("loads active and rollback releases only through their stable descriptors", async () => {
        const source = await readFile(
            path.resolve(deliveryRoot, "productionReleaseActivation.ts"),
            "utf8"
        );
        const start = source.indexOf("async function loadActiveArtifacts(");
        const end = source.indexOf("async function loadExactArtifacts(", start);
        const foreignLoad = source.slice(start, end);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        expect(foreignLoad).toContain("loadDescribedPublishedProductionReleaseById(");
        expect(foreignLoad).not.toContain("loadPublishedProductionRelease(");
        expect(foreignLoad).not.toContain("parseReleaseManifest(");
    });

    test("loads the current release through its descriptor before target activation", async () => {
        const source = await readFile(
            path.resolve(deliveryRoot, "productionDeliveryExecutor.ts"),
            "utf8"
        );
        const start = source.indexOf("async function loadCurrentArtifacts(");
        const end = source.indexOf(
            "async function resolveDescriptorVerifiedExecutor(",
            start
        );
        const currentLoad = source.slice(start, end);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        expect(currentLoad).toContain("loadDescribedPublishedProductionReleaseById(");
        expect(currentLoad).not.toContain("loadPublishedProductionRelease(");
        expect(currentLoad).not.toContain("requireProtocol(");
    });
});
