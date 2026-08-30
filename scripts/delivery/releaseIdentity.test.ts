import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { constants } from "node:fs";
import { cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

setDefaultTimeout(15_000);

import { databaseSchemaTarget } from "../../src/shared/databaseMigrationManifest.ts";
import {
    parseProductionReleaseDescriptor,
    serializeProductionReleaseDescriptor,
} from "../../src/shared/productionReleaseDescriptor.ts";
import { serializeReleaseManifest } from "../../src/shared/releaseManifest.ts";
import { compareStrings } from "../../src/shared/validation.ts";
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
    commitTitle: "Test release",
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
        mode: constants.COPYFILE_FICLONE,
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
        mkdir(path.join(releaseRoot, "runtime"), { recursive: true }),
        mkdir(path.join(releaseRoot, "scripts/delivery/provisioning"), {
            recursive: true,
        }),
        mkdir(path.join(releaseRoot, "server"), { recursive: true }),
        mkdir(path.join(releaseRoot, "src/shared"), { recursive: true }),
    ]);

    const packageJson = `${JSON.stringify(
        {
            dependencies: { react: "^19.2.8" },
            devDependencies: { "bun-types": "*", typescript: "^7.0.2" },
            name: "mira-dashboard",
            private: true,
            version: "0.0.0",
        },
        null,
        2
    )}\n`;
    const lockfile = `{
        "packages": {
            "bun-types": ["bun-types@1.4.0", "", {}],
            "react": ["react@19.2.8", "", {}],
            "typescript": ["typescript@7.0.2", "", {}],
        },
    }\n`;
    await Promise.all([
        writeFile(path.join(repositoryRoot, ".bun-version"), "1.4.0\n"),
        writeFile(path.join(repositoryRoot, "package.json"), packageJson),
        writeFile(path.join(repositoryRoot, "bun.lock"), lockfile),
        writeFile(path.join(releaseRoot, "metadata/.bun-version"), "1.4.0\n"),
        writeFile(path.join(releaseRoot, "metadata/package.json"), packageJson),
        writeFile(path.join(releaseRoot, "metadata/bun.lock"), lockfile),
        writeFile(path.join(releaseRoot, "runtime/bun"), "runtime"),
        writeFile(path.join(releaseRoot, "browser/index.html"), "dashboard"),
        writeFile(path.join(releaseRoot, "browser/assets/app-a1b2c3d4.js"), "app"),
        writeFile(
            path.join(releaseRoot, "server/databaseMaintenance.js"),
            "database-maintenance"
        ),
        writeFile(
            path.join(releaseRoot, "server/productionDelivery.js"),
            "production-delivery"
        ),
        writeFile(
            path.join(releaseRoot, "server/productionProvisioning.js"),
            "production-provisioning"
        ),
        writeFile(path.join(releaseRoot, "server/web.js"), "web"),
        writeFile(path.join(releaseRoot, "server/worker.js"), "worker"),
        writeFile(
            path.join(releaseRoot, "server/openClawHeartbeat.js"),
            "openclaw-heartbeat"
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
            path.join(sourceProjectRoot, "systemd"),
            path.join(releaseRoot, "systemd")
        ),
        copyDirectory(
            path.join(sourceProjectRoot, "scripts/delivery/provisioning/host-operations"),
            path.join(releaseRoot, "scripts/delivery/provisioning/host-operations")
        ),
        copyDirectory(
            path.join(sourceProjectRoot, "scripts/delivery/provisioning/log-maintenance"),
            path.join(releaseRoot, "scripts/delivery/provisioning/log-maintenance")
        ),
        copyDirectory(
            path.join(
                sourceProjectRoot,
                "scripts/delivery/provisioning/preview-tailscale"
            ),
            path.join(releaseRoot, "scripts/delivery/provisioning/preview-tailscale")
        ),
        copyDirectory(
            path.join(
                sourceProjectRoot,
                "scripts/delivery/provisioning/database-observability"
            ),
            path.join(releaseRoot, "scripts/delivery/provisioning/database-observability")
        ),
        copyFile(
            path.join(sourceProjectRoot, "src/shared/managedLogManifest.ts"),
            path.join(releaseRoot, "src/shared/managedLogManifest.ts")
        ),
    ]);
    return { releaseRoot, repositoryRoot };
}

function creationOptions(fixture: { releaseRoot: string; repositoryRoot: string }) {
    return {
        ...fixture,
        runtimeIdentity,
        sourceDisplay: { builtAtMs: 1_800_000_000_000, commitTitle: "Test release" },
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
        expect(created.display).toEqual({
            builtAtMs: 1_800_000_000_000,
            commitTitle: "Test release",
            schemaTarget: databaseSchemaTarget,
        });
        expect(created.runtime).toEqual(runtimeIdentity);
        expect(created.packages).toEqual([
            { name: "bun-types", scope: "devDependency", version: "1.4.0" },
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
        ).toEqual(
            [
                "systemd/host-operations/mira-dashboard-deferred-reboot.service",
                "systemd/host-operations/mira-dashboard-deferred-reboot.timer",
                "systemd/host-operations/mira-dashboard-deferred-stack-restart.service",
                "systemd/host-operations/mira-dashboard-deferred-stack-restart.timer",
                "systemd/host-operations/mira-dashboard-deferred-worker-restart.service",
                "systemd/host-operations/mira-dashboard-deferred-worker-restart.timer",
                "systemd/host-operations/mira-dashboard-host-system-cleanup.service",
                "systemd/host-operations/mira-dashboard-host-system-restart.service",
                "systemd/host-operations/mira-dashboard-host-system-update.service",
                "systemd/host-operations/mira-p@.service",
                "systemd/log-maintenance/mira-dashboard-log-maintenance@.service",
                "systemd/log-maintenance/mira-dashboard-managed-log-access.service",
                "systemd/mira-dashboard-web.service",
                "systemd/mira-dashboard-worker.service",
            ].toSorted()
        );
        expect(
            created.artifacts
                .filter(({ path: artifactPath }) => artifactPath.startsWith("scripts/"))
                .map(({ path: artifactPath }) => artifactPath)
        ).toEqual([
            "scripts/delivery/provisioning/database-observability/README.md",
            "scripts/delivery/provisioning/database-observability/activate-observer.sql",
            "scripts/delivery/provisioning/database-observability/apply-cluster.sql",
            "scripts/delivery/provisioning/database-observability/apply-control-database-capability.sql",
            "scripts/delivery/provisioning/database-observability/apply-control-database.sql",
            "scripts/delivery/provisioning/database-observability/apply-database-access-reconciler.sql",
            "scripts/delivery/provisioning/database-observability/apply-database-capabilities.sql",
            "scripts/delivery/provisioning/database-observability/apply-reconciliation-approval.sql",
            "scripts/delivery/provisioning/database-observability/apply-torrent-view.sql",
            "scripts/delivery/provisioning/database-observability/disable-observer.sql",
            "scripts/delivery/provisioning/database-observability/enable-approved-collection.sql",
            "scripts/delivery/provisioning/database-observability/manifest.json",
            "scripts/delivery/provisioning/database-observability/prepare-approved-collection.sql",
            "scripts/delivery/provisioning/database-observability/reconcile-database-access.sql",
            "scripts/delivery/provisioning/database-observability/reconcile-observer-parameter-policy.sql",
            "scripts/delivery/provisioning/database-observability/rollback-cluster.sql",
            "scripts/delivery/provisioning/database-observability/rollback-control-database-capability.sql",
            "scripts/delivery/provisioning/database-observability/rollback-control-database.sql",
            "scripts/delivery/provisioning/database-observability/rollback-database-access-reconciler.sql",
            "scripts/delivery/provisioning/database-observability/rollback-database-capabilities.sql",
            "scripts/delivery/provisioning/database-observability/rollback-reconciliation-approval.sql",
            "scripts/delivery/provisioning/database-observability/rollback-torrent-view.sql",
            "scripts/delivery/provisioning/database-observability/runProvisioning.ts",
            "scripts/delivery/provisioning/database-observability/verify-cluster.sql",
            "scripts/delivery/provisioning/database-observability/verify-control-database-capability.sql",
            "scripts/delivery/provisioning/database-observability/verify-control-database.sql",
            "scripts/delivery/provisioning/database-observability/verify-database-access-reconciler.sql",
            "scripts/delivery/provisioning/database-observability/verify-database-capabilities.sql",
            "scripts/delivery/provisioning/database-observability/verify-database.sql",
            "scripts/delivery/provisioning/database-observability/verify-reconciliation-approval.sql",
            "scripts/delivery/provisioning/database-observability/verify-torrent-view.sql",
            "scripts/delivery/provisioning/host-operations/60-mira-dashboard-host-operations.rules",
            "scripts/delivery/provisioning/host-operations/README.md",
            "scripts/delivery/provisioning/host-operations/hostOperationsProvisioningFilesystem.ts",
            "scripts/delivery/provisioning/host-operations/installHostOperationsProvisioning.ts",
            "scripts/delivery/provisioning/host-operations/mira-dashboard-host-operation",
            "scripts/delivery/provisioning/host-operations/mira-dashboard-production-authority.conf",
            "scripts/delivery/provisioning/host-operations/mira-dashboard-production-provisioning",
            "scripts/delivery/provisioning/host-operations/mira-dashboard-web-runtime",
            "scripts/delivery/provisioning/host-operations/policy.ts",
            "scripts/delivery/provisioning/log-maintenance/60-mira-dashboard-log-maintenance.rules",
            "scripts/delivery/provisioning/log-maintenance/README.md",
            "scripts/delivery/provisioning/log-maintenance/installLogMaintenanceProvisioning.ts",
            "scripts/delivery/provisioning/log-maintenance/logMaintenanceProvisioningFilesystem.ts",
            "scripts/delivery/provisioning/log-maintenance/migrateManagedApplicationLogs.ts",
            "scripts/delivery/provisioning/log-maintenance/mira-dashboard-log-maintenance",
            "scripts/delivery/provisioning/log-maintenance/mira-dashboard-managed-log-access",
            "scripts/delivery/provisioning/log-maintenance/policy.ts",
            "scripts/delivery/provisioning/log-maintenance/provisionManagedLogAccess.ts",
            "scripts/delivery/provisioning/preview-tailscale/README.md",
            "scripts/delivery/provisioning/preview-tailscale/operator.ts",
            "scripts/delivery/provisioning/preview-tailscale/policy.ts",
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
            ({ path: artifactPath }) =>
                artifactPath !== "release-manifest.json" &&
                artifactPath !== "release-descriptor.json"
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
                migrations: [...persisted.migrations, releaseOwnedMigration].toSorted(
                    (left, right) => compareStrings(left.id, right.id)
                ),
            })
        );
        const descriptorPath = path.join(fixture.releaseRoot, "release-descriptor.json");
        const descriptor = parseProductionReleaseDescriptor(
            JSON.parse(await readFile(descriptorPath, "utf8")) as unknown
        );
        const descriptorInventory = await inventoryReleaseArtifactTree(
            fixture.releaseRoot
        );
        const descriptorArtifacts = descriptorInventory.filter(
            ({ path: artifactPath }) => artifactPath !== "release-descriptor.json"
        );
        await writeFile(
            descriptorPath,
            serializeProductionReleaseDescriptor({
                ...descriptor,
                artifacts: descriptorArtifacts,
                deliveryExecutor: descriptorArtifacts.find(
                    ({ path: artifactPath }) =>
                        artifactPath === "server/productionDelivery.js"
                ),
                runtime: {
                    ...descriptor.runtime,
                    executable: descriptorArtifacts.find(
                        ({ path: artifactPath }) => artifactPath === "runtime/bun"
                    ),
                },
            })
        );

        const reconstructed = await verifyReleaseArtifactIdentity(fixture.releaseRoot);

        expect(reconstructed.migrations).toEqual(
            [...persisted.migrations, releaseOwnedMigration].toSorted((left, right) =>
                compareStrings(left.id, right.id)
            )
        );
    });

    test("rejects dirty source, staged metadata drift and migration mismatch", async () => {
        const dirtyFixture = await releaseFixture();
        const dirtyFailure = await rejectionError(
            createReleaseIdentity({
                ...creationOptions(dirtyFixture),
                sourceIdentity: {
                    commitSha,
                    commitTitle: "Test release",
                    state: "dirty",
                },
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
