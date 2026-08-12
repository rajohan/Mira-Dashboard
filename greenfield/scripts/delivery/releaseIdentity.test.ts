import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { serializeReleaseManifest } from "../../src/shared/releaseManifest.ts";
import type { BuildSourceIdentity } from "../buildSourceIdentity.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import { inventoryReleaseArtifactTree } from "./releaseArtifactInventory.ts";
import type { ReleaseRuntimeIdentity } from "./releaseIdentity.ts";
import {
    createReleaseIdentity,
    verifyReleaseArtifactIdentity,
    verifyReleaseIdentity,
    writeReleaseIdentity,
} from "./releaseIdentity.ts";

const sourceProjectRoot = path.resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];
const commitSha = "b".repeat(40);
const runtimeIdentity: ReleaseRuntimeIdentity = Object.freeze({
    revision: "a".repeat(40),
    version: "1.4.0",
});
const cleanSourceIdentity: BuildSourceIdentity = Object.freeze({
    commitSha,
    state: "clean",
});

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function copyDirectory(source: string, destination: string): Promise<void> {
    await cp(source, destination, {
        errorOnExist: true,
        force: false,
        recursive: true,
    });
}

async function releaseFixture(): Promise<{
    releaseRoot: string;
    repositoryRoot: string;
}> {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "mira-release-identity-"));
    temporaryDirectories.push(repositoryRoot);
    const releaseRoot = path.join(repositoryRoot, "dist/candidate");
    await Promise.all([
        mkdir(path.join(repositoryRoot, "docs"), { recursive: true }),
        mkdir(path.join(releaseRoot, "browser/assets"), { recursive: true }),
        mkdir(path.join(releaseRoot, "docs"), { recursive: true }),
        mkdir(path.join(releaseRoot, "metadata"), { recursive: true }),
        mkdir(path.join(releaseRoot, "scripts/delivery/provisioning"), {
            recursive: true,
        }),
        mkdir(path.join(releaseRoot, "server"), { recursive: true }),
        mkdir(path.join(releaseRoot, "systemd"), { recursive: true }),
    ]);

    const packageJson = `${JSON.stringify(
        {
            dependencies: { react: "^19.2.8" },
            devDependencies: { typescript: "^7.0.2" },
            name: "mira-dashboard",
            private: true,
            version: "0.0.0",
        },
        null,
        2
    )}\n`;
    const lockfile = `{
        "packages": {
            "react": ["react@19.2.8", "", {}],
            "typescript": ["typescript@7.0.2", "", {}],
        },
    }\n`;
    await Promise.all([
        writeFile(path.join(repositoryRoot, ".bun-version"), "canary\n"),
        writeFile(path.join(repositoryRoot, "package.json"), packageJson),
        writeFile(path.join(repositoryRoot, "bun.lock"), lockfile),
        writeFile(path.join(releaseRoot, "metadata/.bun-version"), "canary\n"),
        writeFile(path.join(releaseRoot, "metadata/package.json"), packageJson),
        writeFile(path.join(releaseRoot, "metadata/bun.lock"), lockfile),
        writeFile(path.join(releaseRoot, "browser/index.html"), "dashboard"),
        writeFile(path.join(releaseRoot, "browser/assets/app-a1b2c3d4.js"), "app"),
        writeFile(
            path.join(releaseRoot, "server/databaseMaintenance.js"),
            "database-maintenance"
        ),
        writeFile(path.join(releaseRoot, "server/web.js"), "web"),
        writeFile(path.join(releaseRoot, "server/worker.js"), "worker"),
        writeFile(
            path.join(releaseRoot, "systemd/mira-dashboard-web.service"),
            "[Service]\nExecStart=/web\n"
        ),
        writeFile(
            path.join(releaseRoot, "systemd/mira-dashboard-worker.service"),
            "[Service]\nExecStart=/worker\n"
        ),
    ]);
    await Promise.all([
        copyDirectory(
            path.join(sourceProjectRoot, "docs/generated"),
            path.join(repositoryRoot, "docs/generated")
        ),
        copyDirectory(
            path.join(sourceProjectRoot, "docs/generated"),
            path.join(releaseRoot, "docs/generated")
        ),
        copyDirectory(
            path.join(sourceProjectRoot, "migrations"),
            path.join(releaseRoot, "migrations")
        ),
        copyDirectory(
            path.join(sourceProjectRoot, "scripts/delivery/provisioning/host-operations"),
            path.join(releaseRoot, "scripts/delivery/provisioning/host-operations")
        ),
        copyDirectory(
            path.join(sourceProjectRoot, "scripts/delivery/provisioning/log-maintenance"),
            path.join(releaseRoot, "scripts/delivery/provisioning/log-maintenance")
        ),
    ]);
    return { releaseRoot, repositoryRoot };
}

function creationOptions(fixture: { releaseRoot: string; repositoryRoot: string }) {
    return {
        ...fixture,
        runtimeIdentity,
        sourceIdentity: cleanSourceIdentity,
    };
}

describe("release identity", () => {
    test("derives, persists, rereads and verifies the complete staged identity", async () => {
        const fixture = await releaseFixture();

        const created = await createReleaseIdentity(creationOptions(fixture));
        const persisted = await writeReleaseIdentity(creationOptions(fixture));
        const declared = await verifyReleaseArtifactIdentity(fixture.releaseRoot);
        const verified = await verifyReleaseIdentity(
            fixture.releaseRoot,
            runtimeIdentity
        );

        expect(persisted).toEqual(created);
        expect(declared).toEqual(created);
        expect(verified).toEqual(created);
        expect(created.source).toEqual({ commitSha, treeState: "clean" });
        expect(created.runtime).toEqual(runtimeIdentity);
        expect(created.packages).toEqual([
            { name: "react", scope: "dependency", version: "19.2.8" },
            { name: "typescript", scope: "devDependency", version: "7.0.2" },
        ]);
        expect(
            created.artifacts.some(
                ({ path: artifactPath }) => artifactPath === "server/worker.js"
            )
        ).toBe(true);
        expect(
            created.artifacts
                .filter(({ path: artifactPath }) => artifactPath.startsWith("systemd/"))
                .map(({ path: artifactPath }) => artifactPath)
        ).toEqual([
            "systemd/mira-dashboard-web.service",
            "systemd/mira-dashboard-worker.service",
        ]);
        expect(
            created.artifacts
                .filter(({ path: artifactPath }) => artifactPath.startsWith("scripts/"))
                .map(({ path: artifactPath }) => artifactPath)
        ).toEqual([
            "scripts/delivery/provisioning/host-operations/60-mira-dashboard-host-operations.rules",
            "scripts/delivery/provisioning/host-operations/README.md",
            "scripts/delivery/provisioning/host-operations/hostOperationsProvisioningFilesystem.ts",
            "scripts/delivery/provisioning/host-operations/installHostOperationsProvisioning.ts",
            "scripts/delivery/provisioning/host-operations/mira-dashboard-deferred-reboot.service",
            "scripts/delivery/provisioning/host-operations/mira-dashboard-deferred-reboot.timer",
            "scripts/delivery/provisioning/host-operations/mira-dashboard-host-operation",
            "scripts/delivery/provisioning/host-operations/mira-dashboard-host-system-cleanup.service",
            "scripts/delivery/provisioning/host-operations/mira-dashboard-host-system-restart.service",
            "scripts/delivery/provisioning/host-operations/mira-dashboard-host-system-update.service",
            "scripts/delivery/provisioning/host-operations/policy.ts",
            "scripts/delivery/provisioning/log-maintenance/60-mira-dashboard-log-maintenance.rules",
            "scripts/delivery/provisioning/log-maintenance/README.md",
            "scripts/delivery/provisioning/log-maintenance/installLogMaintenanceProvisioning.ts",
            "scripts/delivery/provisioning/log-maintenance/logMaintenanceProvisioningFilesystem.ts",
            "scripts/delivery/provisioning/log-maintenance/mira-dashboard-log-maintenance",
            "scripts/delivery/provisioning/log-maintenance/mira-dashboard-log-maintenance@.service",
            "scripts/delivery/provisioning/log-maintenance/policy.ts",
        ]);
        const manifestText = await readFile(
            path.join(fixture.releaseRoot, "release-manifest.json"),
            "utf8"
        );
        const manifestValue: unknown = JSON.parse(manifestText);
        expect(manifestValue).toEqual(created);
        expect(Object.isFrozen(verified)).toBe(true);
    });

    test("separates artifact verification from executable runtime binding", async () => {
        const fixture = await releaseFixture();
        const persisted = await writeReleaseIdentity(creationOptions(fixture));

        expect(await verifyReleaseArtifactIdentity(fixture.releaseRoot)).toEqual(
            persisted
        );
        const runtimeFailure = await rejectionError(
            verifyReleaseIdentity(fixture.releaseRoot, {
                revision: "f".repeat(40),
                version: runtimeIdentity.version,
            })
        );
        expect(runtimeFailure.message).toBe("Release identity is invalid");
    });

    test("reconstructs the migration graph from the release manifest", async () => {
        const fixture = await releaseFixture();
        const persisted = await writeReleaseIdentity(creationOptions(fixture));
        const migrationId = "20260805000000_add-reviewed-node";
        const migrationSql = "CREATE TABLE reviewed_node (id TEXT PRIMARY KEY);\n";
        const snapshot = '{"version":"1"}\n';
        const migrationRoot = path.join(fixture.releaseRoot, "migrations", migrationId);
        await mkdir(migrationRoot);
        await Promise.all([
            writeFile(path.join(migrationRoot, "migration.sql"), migrationSql),
            writeFile(path.join(migrationRoot, "snapshot.json"), snapshot),
        ]);
        const completeInventory = await inventoryReleaseArtifactTree(fixture.releaseRoot);
        const artifacts = completeInventory.filter(
            ({ path: artifactPath }) => artifactPath !== "release-manifest.json"
        );
        const releaseOwnedMigration = Object.freeze({
            id: migrationId,
            migrationSha256: new Bun.CryptoHasher("sha256")
                .update(migrationSql)
                .digest("hex"),
            snapshotSha256: new Bun.CryptoHasher("sha256").update(snapshot).digest("hex"),
        });
        await writeFile(
            path.join(fixture.releaseRoot, "release-manifest.json"),
            serializeReleaseManifest({
                ...persisted,
                artifacts,
                migrations: [...persisted.migrations, releaseOwnedMigration],
            })
        );

        const reconstructed = await verifyReleaseArtifactIdentity(fixture.releaseRoot);

        expect(reconstructed.migrations).toEqual([
            ...persisted.migrations,
            releaseOwnedMigration,
        ]);
    });

    test("rejects dirty source, staged metadata drift and migration mismatch", async () => {
        const dirtyFixture = await releaseFixture();
        const dirtyFailure = await rejectionError(
            createReleaseIdentity({
                ...creationOptions(dirtyFixture),
                sourceIdentity: { commitSha, state: "dirty" },
            })
        );
        expect(dirtyFailure.message).toBe("Release identity is invalid");

        const metadataFixture = await releaseFixture();
        await writeFile(
            path.join(metadataFixture.releaseRoot, "metadata/.bun-version"),
            "stable\n"
        );
        const metadataFailure = await rejectionError(
            createReleaseIdentity(creationOptions(metadataFixture))
        );
        expect(metadataFailure.message).toBe("Release identity is invalid");

        const migrationFixture = await releaseFixture();
        const migrationPath = path.join(
            migrationFixture.releaseRoot,
            "migrations/20260804022252_dashboard-foundation/migration.sql"
        );
        await writeFile(migrationPath, `${await readFile(migrationPath, "utf8")}\n`);
        const migrationFailure = await rejectionError(
            createReleaseIdentity(creationOptions(migrationFixture))
        );
        expect(migrationFailure.message).toBe("Release identity is invalid");
    });

    test("rejects artifact tampering and never overwrites a persisted manifest", async () => {
        const fixture = await releaseFixture();
        const options = creationOptions(fixture);
        await writeReleaseIdentity(options);

        const overwriteFailure = await rejectionError(writeReleaseIdentity(options));
        expect(overwriteFailure.message).toBe("Release identity is invalid");
        await writeFile(path.join(fixture.releaseRoot, "server/web.js"), "tampered");
        const tamperFailure = await rejectionError(
            verifyReleaseIdentity(fixture.releaseRoot, runtimeIdentity)
        );
        expect(tamperFailure.message).toBe("Release identity is invalid");
    });
});
