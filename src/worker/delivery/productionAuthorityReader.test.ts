import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createBunRuntimePolicy } from "../../shared/bunRuntimePolicy.ts";
import { serializeProductionActivationRecord } from "../../shared/productionActivationRecord.ts";
import {
    releaseBuildCommands,
    releaseDeliveryProtocols,
    releaseProcessRoles,
    serializeReleaseManifest,
} from "../../shared/releaseManifest.ts";
import {
    createDeliveryProductionAuthorityReader,
    DeliveryProductionAuthorityReaderError,
} from "./productionAuthorityReader.ts";

const bunRuntimePolicy = createBunRuntimePolicy("1.4.0");
const currentReleaseId = "a".repeat(40);
const currentRuntime = "b".repeat(40);
const previousReleaseId = "c".repeat(40);
const previousRuntime = "d".repeat(40);
const transitionId = "01917d36-2e64-7c89-9abc-1234567890ab";
const roots: string[] = [];

afterEach(async () => {
    for (const root of roots.splice(0)) {
        await Promise.all(
            [currentReleaseId, previousReleaseId].map((releaseId) =>
                chmod(path.join(root, "production/releases", releaseId), 0o700).catch(
                    () => {}
                )
            )
        );
        await rm(root, { force: true, recursive: true });
    }
});

function manifest(releaseId: string, runtimeRevision: string, title: string) {
    return {
        artifacts: [{ bytes: 1, path: "server/web.js", sha256: "1".repeat(64) }],
        buildCommands: releaseBuildCommands,
        deliveryProtocols: releaseDeliveryProtocols,
        documentationSha256: "2".repeat(64),
        formatVersion: 1 as const,
        lockfileSha256: "3".repeat(64),
        migrations: [
            {
                id: "20260804022252_dashboard-foundation",
                migrationSha256: "4".repeat(64),
                snapshotSha256: "5".repeat(64),
            },
        ],
        packages: [{ name: "effect", scope: "dependency" as const, version: "1" }],
        processRoles: releaseProcessRoles,
        runtime: { revision: runtimeRevision, version: bunRuntimePolicy.version },
        display: {
            builtAtMs: 1_800_000_000_000,
            commitTitle: title,
            schemaTarget: 1,
        },
        source: {
            commitSha: releaseId,
            treeState: "clean" as const,
        },
    };
}

function manifestWithoutDeliveryProtocol(releaseId: string, runtimeRevision: string) {
    const current = manifest(releaseId, runtimeRevision, "Ignored");
    return {
        artifacts: current.artifacts,
        buildCommands: current.buildCommands,
        documentationSha256: current.documentationSha256,
        formatVersion: current.formatVersion,
        lockfileSha256: current.lockfileSha256,
        migrations: current.migrations,
        packages: current.packages,
        processRoles: ["web", "worker"] as const,
        runtime: current.runtime,
        source: current.source,
    };
}

async function replaceManifest(
    paths: Awaited<ReturnType<typeof fixture>>,
    releaseId: string,
    value: unknown
): Promise<void> {
    const releaseRoot = path.join(paths.releasesDirectory, releaseId);
    const manifestPath = path.join(releaseRoot, "release-manifest.json");
    await chmod(releaseRoot, 0o700);
    await chmod(manifestPath, 0o600);
    await writeFile(manifestPath, `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
    });
    await chmod(manifestPath, 0o400);
    await chmod(releaseRoot, 0o500);
}

async function fixture() {
    const root = await mkdtemp(path.join(os.tmpdir(), "delivery-authority-"));
    roots.push(root);
    const production = path.join(root, "production");
    const stateDirectory = path.join(production, "state");
    const releasesDirectory = path.join(production, "releases");
    await mkdir(stateDirectory, { mode: 0o700, recursive: true });
    await mkdir(releasesDirectory, { mode: 0o700 });
    for (const [releaseId, runtimeRevision, title] of [
        [currentReleaseId, currentRuntime, "Current"],
        [previousReleaseId, previousRuntime, "Previous"],
    ] as const) {
        const releaseRoot = path.join(releasesDirectory, releaseId);
        await mkdir(releaseRoot, { mode: 0o700 });
        const manifestPath = path.join(releaseRoot, "release-manifest.json");
        await writeFile(
            manifestPath,
            serializeReleaseManifest(manifest(releaseId, runtimeRevision, title)),
            { mode: 0o600 }
        );
        await chmod(manifestPath, 0o400);
        await chmod(releaseRoot, 0o500);
    }
    await writeFile(
        path.join(stateDirectory, "activation.json"),
        serializeProductionActivationRecord({
            current: {
                releaseId: currentReleaseId,
                runtimeRevision: currentRuntime,
            },
            formatVersion: 1,
            previous: {
                databaseSnapshotTransitionId: transitionId,
                releaseId: previousReleaseId,
                runtimeRevision: previousRuntime,
            },
            transitionId,
        }),
        { mode: 0o600 }
    );
    return { releasesDirectory, stateDirectory };
}

describe("Delivery production authority reader", () => {
    test("projects exact immutable current, previous, and paired rollback authority", async () => {
        const paths = await fixture();
        const reader = createDeliveryProductionAuthorityReader({
            readActionActive: () => Promise.resolve(false),
            ...paths,
        });

        const exact = await reader.readExact();
        const result = exact.snapshot;
        expect(exact.activation).toMatchObject({
            current: { releaseId: currentReleaseId, runtimeRevision: currentRuntime },
            transitionId,
        });
        expect(result.actionActive).toBeFalse();
        expect(result.releases).toMatchObject({
            current: {
                commitTitle: "Current",
                releaseId: currentReleaseId,
                runtimeRevision: currentRuntime,
            },
            previous: {
                commitTitle: "Previous",
                releaseId: previousReleaseId,
                runtimeRevision: previousRuntime,
            },
            rollback: {
                actor: "mira",
                available: true,
                target: {
                    databaseSnapshotTransitionId: transitionId,
                    releaseId: previousReleaseId,
                    runtimeRevision: previousRuntime,
                },
            },
        });
        expect(result.releases.activationRevision).toMatch(/^[a-f\d]{64}$/u);
    });

    test("blocks rollback while a Delivery action is active", async () => {
        const paths = await fixture();
        const result = await createDeliveryProductionAuthorityReader({
            readActionActive: () => Promise.resolve(true),
            ...paths,
        }).read();
        expect(result).toMatchObject({
            actionActive: true,
            releases: {
                rollback: {
                    actor: "mira",
                    available: false,
                    reason: "action-active",
                },
            },
        });
    });

    test("fails closed when the current release lacks the production protocol", async () => {
        const paths = await fixture();
        await replaceManifest(
            paths,
            currentReleaseId,
            manifestWithoutDeliveryProtocol(currentReleaseId, currentRuntime)
        );

        expect(
            createDeliveryProductionAuthorityReader({
                readActionActive: () => Promise.resolve(false),
                ...paths,
            }).read()
        ).rejects.toBeInstanceOf(DeliveryProductionAuthorityReaderError);
    });

    test("excludes only the exact executing run from operation authority", async () => {
        const paths = await fixture();
        const calls: Array<string | undefined> = [];
        const runId = "01917d36-2e64-7c89-9abc-1234567890ac";
        const reader = createDeliveryProductionAuthorityReader({
            readActionActive: ({ excludeRunId }) => {
                calls.push(excludeRunId);
                return Promise.resolve(excludeRunId === undefined);
            },
            ...paths,
        });

        const scheduled = await reader.read();
        expect(scheduled.actionActive).toBe(true);
        const operation = await reader.readForOperation(runId);
        expect(operation.actionActive).toBe(false);
        expect(operation.releases.rollback).toMatchObject({ available: true });
        expect(calls).toEqual([undefined, undefined, runId, runId]);
        expect(reader.readForOperation("not-a-run-id")).rejects.toBeDefined();
    });

    test("fails closed for a manifest that is not the immutable exact file", async () => {
        const paths = await fixture();
        const manifestPath = path.join(
            paths.releasesDirectory,
            currentReleaseId,
            "release-manifest.json"
        );
        const moved = path.join(path.dirname(manifestPath), "manifest-target.json");
        await chmod(path.dirname(manifestPath), 0o700);
        await rename(manifestPath, moved);
        await symlink("manifest-target.json", manifestPath);
        await chmod(path.dirname(manifestPath), 0o500);

        expect(
            createDeliveryProductionAuthorityReader({
                readActionActive: () => Promise.resolve(false),
                ...paths,
            }).read()
        ).rejects.toBeInstanceOf(DeliveryProductionAuthorityReaderError);
    });
});
