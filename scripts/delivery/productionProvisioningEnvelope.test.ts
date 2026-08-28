import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionError } from "../testSupport/rejection.ts";
import { verifyProductionProvisioningEnvelope } from "./productionProvisioningEnvelope.ts";
import { inventoryReleaseArtifactTree } from "./releaseArtifactInventory.ts";

const temporaryDirectories: string[] = [];
const releaseId = "b".repeat(40);
const runtimeRevision = "a".repeat(40);

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function releaseFixture(): Promise<string> {
    const releaseRoot = await mkdtemp(path.join(tmpdir(), "mira-provision-envelope-"));
    temporaryDirectories.push(releaseRoot);
    const files = Object.freeze({
        "metadata/future.json": "future metadata",
        "migrations/20990101000000_future.sql": "select 1;",
        "runtime/bun": "runtime",
        "scripts/delivery/provisioning/future-domain/install.ts": "installer",
        "server/productionProvisioning.js": "provisioner",
        "src/shared/futurePolicy.ts": "policy",
        "systemd/future-domain/future.service": "unit",
    });
    await Promise.all(
        Object.entries(files).map(async ([relativePath, contents]) => {
            const target = path.join(releaseRoot, relativePath);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, contents);
        })
    );
    const artifacts = await inventoryReleaseArtifactTree(releaseRoot);
    await writeFile(
        path.join(releaseRoot, "release-manifest.json"),
        `${JSON.stringify(
            {
                artifacts,
                futureTopLevelField: { acceptedWithoutPriorGenerationKnowledge: true },
                runtime: {
                    futureRuntimeField: "allowed",
                    revision: runtimeRevision,
                    version: "1.4.0",
                },
                source: {
                    commitSha: releaseId,
                    futureSourceField: "allowed",
                    treeState: "clean",
                },
            },
            null,
            2
        )}\n`
    );
    return releaseRoot;
}

describe("production provisioning envelope", () => {
    test("admits future artifact categories and manifest fields", async () => {
        const releaseRoot = await releaseFixture();

        const envelope = await verifyProductionProvisioningEnvelope(releaseRoot);

        expect(envelope.source.commitSha).toBe(releaseId);
        expect(
            envelope.artifacts.map(({ path: artifactPath }) => artifactPath)
        ).toContain("systemd/future-domain/future.service");
        expect(
            envelope.artifacts.map(({ path: artifactPath }) => artifactPath)
        ).toContain("scripts/delivery/provisioning/future-domain/install.ts");
    });

    test("rejects an artifact not bound by the manifest", async () => {
        const releaseRoot = await releaseFixture();
        await writeFile(path.join(releaseRoot, "unexpected"), "unexpected");

        expect(
            await rejectionError(verifyProductionProvisioningEnvelope(releaseRoot))
        ).toEqual(new Error("Production provisioning envelope is invalid"));
    });

    test("rejects tampered candidate provisioning bytes", async () => {
        const releaseRoot = await releaseFixture();
        await writeFile(
            path.join(releaseRoot, "server/productionProvisioning.js"),
            "tampered"
        );

        expect(
            await rejectionError(verifyProductionProvisioningEnvelope(releaseRoot))
        ).toEqual(new Error("Production provisioning envelope is invalid"));
    });

    test("requires the stable candidate runtime and provisioner paths", async () => {
        const releaseRoot = await releaseFixture();
        await rm(path.join(releaseRoot, "runtime/bun"));

        expect(
            await rejectionError(verifyProductionProvisioningEnvelope(releaseRoot))
        ).toEqual(new Error("Production provisioning envelope is invalid"));
    });
});
