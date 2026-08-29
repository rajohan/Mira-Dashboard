import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { deliveryProductionActionKey } from "../../src/contracts/deliveryWorker.ts";
import {
    productionCutoverRequiresReconciliation,
    productionCutoverRequiresValidationMode,
    readActiveProductionCutoverRecord,
} from "../../src/server/platform/release/deliveryCutoverValidation.ts";
import {
    deliveryProductionProtocol,
    type DeliveryProductionOperationCapsule,
} from "../../src/shared/deliveryProductionOperation.ts";
import {
    parseProductionReleaseDescriptor,
    serializeProductionReleaseDescriptor,
} from "../../src/shared/productionReleaseDescriptor.ts";
import {
    parseReleaseManifest,
    releaseBuildCommands,
    releaseDeliveryProtocols,
    releaseProcessRoles,
} from "../../src/shared/releaseManifest.ts";
import { publishedReleaseAuthority } from "../../src/testSupport/publishedReleaseAuthority.ts";
import { reconcileDeliveryProductionCutoverBeforeValidation } from "../../src/worker/delivery/productionRecovery.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import {
    commitProductionActivationState,
    loadProductionActivationState,
} from "./productionActivationState.ts";
import {
    clearProductionDeliveryOperationMarker,
    inspectActiveProductionDeliveryOperation,
    inspectProductionDeliveryExecutorOwner,
    inspectProductionDeliveryOperation,
    parseProductionDeliveryExecutorArguments,
    prepareProductionDeliveryOperation,
    prepareProductionDeliveryTargetUnderLease,
    releaseManifestMatchesAuthority,
    releaseSupportsCurrentDeliveryProtocol,
    runProductionDeliveryExecutor,
    runProductionDeliveryExecutorUnderLease,
    verifyProductionRunBeforeSnapshot,
} from "./productionDeliveryExecutor.ts";
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
import {
    createDeliveryProductionOperation,
    inspectDeliveryProductionOperation,
} from "./productionDeliveryOperationFilesystem.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";

const temporaryDirectories: string[] = [];
const currentReleaseId = "a".repeat(40);
const currentRuntimeRevision = "b".repeat(40);
const targetReleaseId = "c".repeat(40);
const targetRuntimeRevision = "d".repeat(40);
const currentTransitionId = "019fd974-54a2-74dd-a64b-d4186f8d8801";
const operationTransitionId = "019fd974-54a2-74dd-a64b-d4186f8d8802";
const checksum = "e".repeat(64);

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await restoreOwnerWrite(directory);
        await rm(directory, { force: true, recursive: true });
    }
});

async function restoreOwnerWrite(directory: string): Promise<void> {
    const status = await lstat(directory).catch(() => null);
    if (!status?.isDirectory()) return;
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) await restoreOwnerWrite(entryPath);
        else if (entry.isFile()) await chmod(entryPath, 0o600);
    }
}

function operationCapsule(
    release = publishedReleaseAuthority(targetReleaseId, "v1.2.3", targetRuntimeRevision)
): DeliveryProductionOperationCapsule {
    const payload = {
        activationRevision: "1".repeat(64),
        checkoutRevision: "2".repeat(64),
        expectedMainHeadSha: targetReleaseId,
        operation: "deploy" as const,
        release,
        sourceRevision: "f".repeat(64),
    };
    return {
        cas: {
            current: {
                activationTransitionId: currentTransitionId,
                releaseId: currentReleaseId,
                rollbackSnapshotTransitionId: operationTransitionId,
                runtimeRevision: currentRuntimeRevision,
            },
            target: {
                databaseSnapshotTransitionId: null,
                releaseId: targetReleaseId,
                runtimeRevision: targetRuntimeRevision,
            },
        },
        enqueue: {
            actionKey: deliveryProductionActionKey,
            actor: {
                authenticatorId: "1".repeat(32),
                id: "019fd974-54a2-74dd-a64b-d4186f8d8803",
                kind: "user",
            },
            audit: {
                eventId: "019fd974-54a2-74dd-a64b-d4186f8d8804",
                requestId: "delivery-executor-test",
            },
            enqueueSha256: "2".repeat(64),
            idempotencyKey: "A".repeat(32),
            payload,
            payloadSha256: new Bun.CryptoHasher("sha256")
                .update(JSON.stringify(payload))
                .digest("hex"),
            queuedAtMs: 1000,
        },
        executor: {
            releaseId: currentReleaseId,
            runtimeRevision: currentRuntimeRevision,
        },
        protocol: deliveryProductionProtocol,
        runId: operationTransitionId,
        transitionId: operationTransitionId,
    };
}

function rollbackCapsule(): DeliveryProductionOperationCapsule {
    const payload = {
        activationRevision: "1".repeat(64),
        operation: "rollback-release" as const,
        sourceRevision: "f".repeat(64),
        target: {
            databaseSnapshotTransitionId: "019fd974-54a2-74dd-a64b-d4186f8d8806",
            releaseId: targetReleaseId,
            runtimeRevision: targetRuntimeRevision,
        },
    };
    const deploy = operationCapsule();
    return {
        ...deploy,
        cas: {
            ...deploy.cas,
            target: {
                ...deploy.cas.target,
                databaseSnapshotTransitionId: payload.target.databaseSnapshotTransitionId,
            },
        },
        enqueue: {
            ...deploy.enqueue,
            payload,
            payloadSha256: new Bun.CryptoHasher("sha256")
                .update(JSON.stringify(payload))
                .digest("hex"),
        },
    };
}

function artifact(
    releaseId: string,
    runtimeRevision: string,
    deliveryProtocols: readonly string[] = releaseDeliveryProtocols
) {
    return Object.freeze({
        release: Object.freeze({
            manifest: parseReleaseManifest({
                artifacts: [
                    {
                        bytes: 1,
                        path: "server/productionDelivery.js",
                        sha256: checksum,
                    },
                ],
                buildCommands: [...releaseBuildCommands],
                ...(deliveryProtocols.length === 0
                    ? {}
                    : { deliveryProtocols: [...deliveryProtocols] }),
                ...(deliveryProtocols.length === 0
                    ? {}
                    : {
                          display: {
                              builtAtMs: 1_800_000_000_000,
                              commitTitle: "Test release",
                              schemaTarget: 1,
                          },
                      }),
                documentationSha256: checksum,
                formatVersion: 1,
                lockfileSha256: checksum,
                migrations: [
                    {
                        id: "20260804022252_dashboard-foundation",
                        migrationSha256: checksum,
                        snapshotSha256: checksum,
                    },
                ],
                packages: [
                    { name: "effect", scope: "dependency", version: "4.0.0-beta.106" },
                ],
                processRoles:
                    deliveryProtocols.length === 0
                        ? ["web", "worker"]
                        : [...releaseProcessRoles],
                runtime: { revision: runtimeRevision, version: "1.4.0" },
                source: { commitSha: releaseId, treeState: "clean" },
            }),
            releaseRoot: `/production/releases/${releaseId}`,
        }),
        runtime: Object.freeze({
            executable: `/production/runtimes/bun/${runtimeRevision}/bun`,
            identity: { revision: runtimeRevision, version: "1.4.0" },
        }),
    });
}

function describedArtifact(releaseId: string, runtimeRevision: string) {
    const executable = Object.freeze({
        bytes: 1,
        path: "runtime/bun",
        sha256: checksum,
    });
    const deliveryExecutor = Object.freeze({
        bytes: 1,
        path: "server/productionDelivery.js",
        sha256: checksum,
    });
    return Object.freeze({
        release: Object.freeze({
            descriptor: parseProductionReleaseDescriptor({
                artifacts: [executable, deliveryExecutor],
                deliveryExecutor,
                formatVersion: 1,
                releaseId,
                runtime: {
                    executable,
                    revision: runtimeRevision,
                    version: "1.4.0",
                },
            }),
            releaseRoot: `/production/releases/${releaseId}`,
        }),
        runtime: Object.freeze({
            executable: `/production/runtimes/bun/${runtimeRevision}/bun`,
            identity: { revision: runtimeRevision, version: "1.4.0" },
        }),
    });
}

function describedArtifactRecord(artifactPath: string, content: string) {
    return {
        bytes: Buffer.byteLength(content),
        path: artifactPath,
        sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex"),
    };
}

async function materializeDescribedRelease(
    releaseRoot: string,
    releaseId: string,
    runtimeRevision: string
): Promise<Readonly<{ descriptorSha256: string; manifestSha256: string }>> {
    const runtimeBytes = "runtime";
    const executorBytes = "executor";
    const manifestBytes = "foreign-manifest";
    const executable = describedArtifactRecord("runtime/bun", runtimeBytes);
    const deliveryExecutor = describedArtifactRecord(
        "server/productionDelivery.js",
        executorBytes
    );
    const manifest = describedArtifactRecord("release-manifest.json", manifestBytes);
    const descriptorBytes = serializeProductionReleaseDescriptor({
        artifacts: [manifest, executable, deliveryExecutor],
        deliveryExecutor,
        formatVersion: 1,
        releaseId,
        runtime: {
            executable,
            revision: runtimeRevision,
            version: "1.4.0",
        },
    });
    await mkdir(releaseRoot, { recursive: true });
    await Promise.all([
        mkdir(path.join(releaseRoot, "runtime"), { recursive: true }),
        mkdir(path.join(releaseRoot, "server"), { recursive: true }),
    ]);
    await Promise.all([
        writeFile(path.join(releaseRoot, executable.path), runtimeBytes, {
            mode: 0o500,
        }),
        writeFile(path.join(releaseRoot, deliveryExecutor.path), executorBytes, {
            mode: 0o400,
        }),
        writeFile(path.join(releaseRoot, manifest.path), manifestBytes, { mode: 0o400 }),
        writeFile(path.join(releaseRoot, "release-descriptor.json"), descriptorBytes, {
            mode: 0o400,
        }),
    ]);
    await Promise.all([
        chmod(path.join(releaseRoot, "runtime"), 0o500),
        chmod(path.join(releaseRoot, "server"), 0o500),
    ]);
    await chmod(releaseRoot, 0o500);
    return Object.freeze({
        descriptorSha256: new Bun.CryptoHasher("sha256")
            .update(descriptorBytes)
            .digest("hex"),
        manifestSha256: manifest.sha256,
    });
}

async function fixture() {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "mira-delivery-executor-"));
    temporaryDirectories.push(projectRoot);
    const state = await prepareProtectedProductionStatePath(projectRoot);
    const paths = await prepareProductionDeliveryDirectories(state);
    const options = parseProductionDeliveryExecutorArguments([
        "--artifact-source=published-release",
        "--operation=cutover",
        `--project-root=${projectRoot}`,
        "--readiness-url=http://127.0.0.1:3100/api/health/ready",
        `--transition=${operationTransitionId}`,
    ]);
    if (options.operation !== "cutover") throw new Error("Invalid test fixture");
    return { options, paths };
}

async function createClaimedProductionRunDatabase(
    paths: Awaited<ReturnType<typeof prepareProductionDeliveryDirectories>>,
    capsule: DeliveryProductionOperationCapsule
): Promise<Database> {
    const databasePath = path.join(paths.stateDirectory, "mira-dashboard.db");
    const database = new Database(databasePath, { create: true, strict: true });
    database.run(`
        CREATE TABLE job_runs (
            action_key TEXT NOT NULL,
            enqueue_sha256 TEXT NOT NULL,
            id TEXT PRIMARY KEY NOT NULL,
            idempotency_key TEXT NOT NULL,
            lease_expires_at INTEGER,
            lease_owner_id TEXT,
            lease_token TEXT,
            payload_json TEXT NOT NULL,
            queued_at INTEGER NOT NULL,
            requested_by_id TEXT NOT NULL,
            requested_by_kind TEXT NOT NULL,
            state TEXT NOT NULL
        );
        CREATE TABLE audit_events (
            action TEXT NOT NULL,
            actor_id TEXT NOT NULL,
            actor_kind TEXT NOT NULL,
            authenticator_id TEXT,
            id TEXT PRIMARY KEY NOT NULL,
            occurred_at INTEGER NOT NULL,
            outcome TEXT NOT NULL,
            request_id TEXT,
            target_id TEXT NOT NULL,
            target_type TEXT NOT NULL
        );
    `);
    database
        .query<
            never,
            [
                string,
                string,
                string,
                string,
                number,
                string,
                string,
                string,
                number,
                string,
                string,
            ]
        >(`
            INSERT INTO job_runs (
                action_key,
                enqueue_sha256,
                id,
                idempotency_key,
                lease_expires_at,
                lease_owner_id,
                lease_token,
                payload_json,
                queued_at,
                requested_by_id,
                requested_by_kind,
                state
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'running')
        `)
        .run(
            capsule.enqueue.actionKey,
            capsule.enqueue.enqueueSha256,
            capsule.runId,
            capsule.enqueue.idempotencyKey,
            20_000,
            "worker-1",
            "019fd974-54a2-74dd-a64b-d4186f8d8805",
            JSON.stringify(capsule.enqueue.payload),
            capsule.enqueue.queuedAtMs,
            capsule.enqueue.actor.id,
            capsule.enqueue.actor.kind
        );
    database
        .query<
            never,
            [
                string,
                string,
                string,
                string,
                string,
                number,
                string,
                string,
                string,
                string,
            ]
        >(`
            INSERT INTO audit_events (
                action,
                actor_id,
                actor_kind,
                authenticator_id,
                id,
                occurred_at,
                outcome,
                request_id,
                target_id,
                target_type
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        `)
        .run(
            "delivery.operation.enqueue",
            capsule.enqueue.actor.id,
            capsule.enqueue.actor.kind,
            capsule.enqueue.actor.authenticatorId,
            capsule.enqueue.audit.eventId,
            capsule.enqueue.queuedAtMs,
            "accepted",
            capsule.enqueue.audit.requestId,
            capsule.runId,
            "job-run"
        );
    await chmod(databasePath, 0o600);
    return database;
}

describe("production Delivery executor", () => {
    test("recognizes the exact current Delivery protocol", () => {
        expect(
            releaseSupportsCurrentDeliveryProtocol(
                artifact(currentReleaseId, currentRuntimeRevision).release
            )
        ).toBeTrue();
    });

    test("binds cached release manifests to the published authority digest", () => {
        const bytes = new TextEncoder().encode("manifest-bytes");
        const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

        expect(releaseManifestMatchesAuthority(bytes, digest)).toBe(true);
        expect(releaseManifestMatchesAuthority(bytes, "0".repeat(64))).toBe(false);
    });

    test("accepts the exact claimed production run before snapshot", async () => {
        const { paths } = await fixture();
        const capsule = operationCapsule();
        const database = await createClaimedProductionRunDatabase(paths, capsule);
        database.close(false);

        await verifyProductionRunBeforeSnapshot(paths, capsule);

        const changed = new Database(
            path.join(paths.stateDirectory, "mira-dashboard.db"),
            {
                strict: true,
            }
        );
        changed.run("UPDATE job_runs SET state = 'succeeded'");
        changed.close(false);
        const rejected = await rejectionError(
            verifyProductionRunBeforeSnapshot(paths, capsule)
        );
        expect(rejected.message).toBe("Production Delivery executor failed");
    });

    test("rejects extra, non-loopback, and malformed arguments", () => {
        expect(() =>
            parseProductionDeliveryExecutorArguments([
                "--artifact-source=published-release",
                "--operation=cutover",
                "--project-root=/srv/dashboard",
                "--readiness-url=https://dashboard.example/api/health/ready",
                `--transition=${operationTransitionId}`,
            ])
        ).toThrow("Usage: bun productionDelivery.js");
        expect(() =>
            parseProductionDeliveryExecutorArguments([
                "--artifact-source=published-release",
                "--operation=cutover",
                "--project-root=/srv/dashboard",
                "--readiness-url=http://127.0.0.1:3100/api/health/ready",
                `--transition=${operationTransitionId}`,
                "--token=secret",
            ])
        ).toThrow("Usage: bun productionDelivery.js");
        expect(() =>
            parseProductionDeliveryExecutorArguments([
                "--artifact-source=network-fallback",
                "--operation=cutover",
                "--project-root=/srv/dashboard",
                "--readiness-url=http://127.0.0.1:3100/api/health/ready",
                `--transition=${operationTransitionId}`,
            ])
        ).toThrow("Usage: bun productionDelivery.js");
    });

    test("stores success only after the normal runtime reaches readiness", async () => {
        const { options, paths } = await fixture();
        const targetActivation = {
            current: {
                releaseId: targetReleaseId,
                runtimeRevision: targetRuntimeRevision,
            },
            formatVersion: 1 as const,
            previous: {
                databaseSnapshotTransitionId: operationTransitionId,
                releaseId: currentReleaseId,
                runtimeRevision: currentRuntimeRevision,
            },
            transitionId: operationTransitionId,
        };
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const empty = await loadProductionActivationState(lease, paths);
            await commitProductionActivationState(lease, paths, empty, {
                current: {
                    releaseId: currentReleaseId,
                    runtimeRevision: currentRuntimeRevision,
                },
                formatVersion: 1,
                previous: null,
                transitionId: currentTransitionId,
            });
            await createDeliveryProductionOperation(
                lease,
                paths,
                operationCapsule(),
                1000
            );
            let localSettlements = 0;
            const validation = await reconcileDeliveryProductionCutoverBeforeValidation({
                ensure: () => Promise.resolve("already-running"),
                projectRoot: options.projectRoot,
                readActive: () => readActiveProductionCutoverRecord(paths.stateDirectory),
                readinessUrl: options.readinessUrl,
            });
            expect(validation).toMatchObject({
                state: "in-progress",
                transitionId: operationTransitionId,
            });

            const receipt = await runProductionDeliveryExecutorUnderLease(
                lease,
                paths,
                options,
                {
                    activate: (...arguments_) =>
                        Effect.tryPromise({
                            catch: () => new Error("activation failed") as never,
                            try: async () => {
                                const activationOptions = arguments_[5];
                                for (const phase of [
                                    "services-stopped",
                                    "current-snapshot-created",
                                    "target-database-ready",
                                    "target-services-started",
                                    "target-verified",
                                    "target-smoke-verified",
                                ] as const) {
                                    await activationOptions?.onProgress?.(phase);
                                }
                                return targetActivation;
                            },
                        }),
                    createServices: () => ({
                        prepare: () => Promise.resolve(),
                        provision: () =>
                            Promise.reject(
                                new Error("Published authority must not be reused")
                            ),
                        settle: () => {
                            localSettlements += 1;
                            return Promise.resolve();
                        },
                        start: () => Promise.resolve(),
                        stop: () => Promise.resolve(),
                        verifyReady: async () => {
                            const active = await inspectDeliveryProductionOperation(
                                lease,
                                paths
                            );
                            expect(active).toMatchObject({
                                record: { phase: "normal-runtime-starting" },
                                state: "in-progress",
                            });
                            expect(
                                await productionCutoverRequiresValidationMode(
                                    paths.stateDirectory
                                )
                            ).toBeFalse();
                            expect(
                                await productionCutoverRequiresReconciliation(
                                    paths.stateDirectory
                                )
                            ).toBeTrue();
                        },
                        verifySmoke: () => Promise.resolve(),
                    }),
                    loadCurrentArtifacts: (_paths, releaseId, runtimeRevision) =>
                        Promise.resolve(describedArtifact(releaseId, runtimeRevision)),
                    loadTargetArtifacts: (_paths, releaseId, runtimeRevision) =>
                        Promise.resolve(artifact(releaseId, runtimeRevision)),
                    nowMs: () => 10_000,
                    verifyPreviewTailscaleOperator: () => Promise.resolve(),
                    verifyRunBeforeSnapshot: () => Promise.resolve(),
                }
            );

            expect(receipt.phase).toBe("terminal");
            expect(receipt.result).toEqual({
                activation: targetActivation,
                completedAtMs: 10_000,
                outcome: "succeeded",
            });
            expect(localSettlements).toBe(1);
            const replay = await runProductionDeliveryExecutorUnderLease(
                lease,
                paths,
                options
            );
            expect(replay).toEqual(receipt);
        });
    });

    test("preserves one exact receipt through the public project-root lifecycle", async () => {
        const { options, paths } = await fixture();
        const capsule = operationCapsule();
        const targetActivation = {
            current: {
                releaseId: targetReleaseId,
                runtimeRevision: targetRuntimeRevision,
            },
            formatVersion: 1 as const,
            previous: {
                databaseSnapshotTransitionId: operationTransitionId,
                releaseId: currentReleaseId,
                runtimeRevision: currentRuntimeRevision,
            },
            transitionId: operationTransitionId,
        };
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const empty = await loadProductionActivationState(lease, paths);
            await commitProductionActivationState(lease, paths, empty, {
                current: {
                    releaseId: currentReleaseId,
                    runtimeRevision: currentRuntimeRevision,
                },
                formatVersion: 1,
                previous: null,
                transitionId: currentTransitionId,
            });
        });

        const prepared = await prepareProductionDeliveryOperation(
            options.projectRoot,
            capsule,
            () => 1000
        );
        expect(prepared).toMatchObject({
            capsule,
            phase: "intent-recorded",
            updatedAtMs: 1000,
        });
        expect(
            await prepareProductionDeliveryOperation(
                options.projectRoot,
                capsule,
                () => 2000
            )
        ).toEqual(prepared);
        expect(
            await inspectActiveProductionDeliveryOperation(options.projectRoot)
        ).toMatchObject({
            record: { phase: "intent-recorded" },
            state: "in-progress",
            transitionId: operationTransitionId,
        });
        expect(
            await inspectProductionDeliveryOperation(
                options.projectRoot,
                operationTransitionId
            )
        ).toMatchObject({
            record: { phase: "intent-recorded" },
            state: "in-progress",
            transitionId: operationTransitionId,
        });

        const receipt = await runProductionDeliveryExecutor(options, {
            activate: (...arguments_) =>
                Effect.tryPromise({
                    catch: () => new Error("activation failed") as never,
                    try: async () => {
                        for (const phase of [
                            "services-stopped",
                            "current-snapshot-created",
                            "target-database-ready",
                            "target-services-started",
                            "target-verified",
                            "target-smoke-verified",
                        ] as const) {
                            await arguments_[5]?.onProgress?.(phase);
                        }
                        return targetActivation;
                    },
                }),
            createServices: () => ({
                prepare: () => Promise.resolve(),
                provision: () => Promise.resolve(),
                start: () => Promise.resolve(),
                stop: () => Promise.resolve(),
                verifyReady: () => Promise.resolve(),
                verifySmoke: () => Promise.resolve(),
            }),
            loadCurrentArtifacts: (_paths, releaseId, runtimeRevision) =>
                Promise.resolve(describedArtifact(releaseId, runtimeRevision)),
            loadTargetArtifacts: (_paths, releaseId, runtimeRevision) =>
                Promise.resolve(artifact(releaseId, runtimeRevision)),
            nowMs: () => 10_000,
            verifyPreviewTailscaleOperator: () => Promise.resolve(),
            verifyRunBeforeSnapshot: () => Promise.resolve(),
        });
        expect(receipt).toMatchObject({
            phase: "terminal",
            result: { activation: targetActivation, outcome: "succeeded" },
        });
        expect(
            await inspectProductionDeliveryOperation(
                options.projectRoot,
                operationTransitionId
            )
        ).toMatchObject({ state: "terminal", transitionId: operationTransitionId });
        expect(
            await clearProductionDeliveryOperationMarker(
                options.projectRoot,
                operationTransitionId
            )
        ).toEqual(receipt);
        expect(
            await clearProductionDeliveryOperationMarker(
                options.projectRoot,
                operationTransitionId
            )
        ).toEqual(receipt);
        expect(
            await inspectActiveProductionDeliveryOperation(options.projectRoot)
        ).toEqual({ state: "missing" });
        expect(
            await inspectProductionDeliveryOperation(
                options.projectRoot,
                operationTransitionId
            )
        ).toMatchObject({ state: "terminal", transitionId: operationTransitionId });

        const replayFailure = await rejectionError(
            prepareProductionDeliveryOperation(options.projectRoot, capsule, () => 3000)
        );
        expect(replayFailure.message).toBe("Production Delivery executor failed");
    });

    test("backfills the capsule executor owner when journal creation outlives owner commit", async () => {
        const { options, paths } = await fixture();
        const capsule = operationCapsule();
        await withDeploymentLease(paths.stateDirectory, (lease) =>
            createDeliveryProductionOperation(lease, paths, capsule, 1000)
        );

        const replay = await prepareProductionDeliveryOperation(
            options.projectRoot,
            capsule,
            () => 2000
        );

        expect(replay.phase).toBe("intent-recorded");
        expect(await inspectProductionDeliveryExecutorOwner(options.projectRoot)).toEqual(
            {
                formatVersion: 1,
                releaseId: currentReleaseId,
                runtimeRevision: currentRuntimeRevision,
                transitionId: operationTransitionId,
            }
        );
    });

    test("keeps recovery retryable when the normal runtime restart fails", async () => {
        const { options, paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const initial = await loadProductionActivationState(lease, paths);
            await commitProductionActivationState(lease, paths, initial, {
                current: {
                    releaseId: currentReleaseId,
                    runtimeRevision: currentRuntimeRevision,
                },
                formatVersion: 1,
                previous: null,
                transitionId: currentTransitionId,
            });
            await createDeliveryProductionOperation(
                lease,
                paths,
                operationCapsule(),
                1000
            );
            let starts = 0;
            const rejected = await rejectionError(
                runProductionDeliveryExecutorUnderLease(lease, paths, options, {
                    activate: (...arguments_) =>
                        Effect.tryPromise({
                            catch: () => new Error("activation failed") as never,
                            try: async () => {
                                for (const phase of [
                                    "services-stopped",
                                    "current-snapshot-created",
                                    "target-database-ready",
                                    "target-services-started",
                                    "target-verified",
                                    "target-smoke-verified",
                                ] as const) {
                                    await arguments_[5]?.onProgress?.(phase);
                                }
                                return {
                                    current: {
                                        releaseId: targetReleaseId,
                                        runtimeRevision: targetRuntimeRevision,
                                    },
                                    formatVersion: 1 as const,
                                    previous: {
                                        databaseSnapshotTransitionId:
                                            operationTransitionId,
                                        releaseId: currentReleaseId,
                                        runtimeRevision: currentRuntimeRevision,
                                    },
                                    transitionId: operationTransitionId,
                                };
                            },
                        }),
                    createServices: () => ({
                        prepare: () => Promise.resolve(),
                        provision: () => Promise.resolve(),
                        start: () => {
                            starts += 1;
                            return Promise.reject(new Error("restart failed"));
                        },
                        stop: () => Promise.resolve(),
                        verifyReady: () => Promise.resolve(),
                        verifySmoke: () => Promise.resolve(),
                    }),
                    loadCurrentArtifacts: (_paths, releaseId, runtimeRevision) =>
                        Promise.resolve(describedArtifact(releaseId, runtimeRevision)),
                    loadTargetArtifacts: (_paths, releaseId, runtimeRevision) =>
                        Promise.resolve(artifact(releaseId, runtimeRevision)),
                    nowMs: () => 10_000,
                    verifyPreviewTailscaleOperator: () => Promise.resolve(),
                    verifyRunBeforeSnapshot: () => Promise.resolve(),
                })
            );
            expect(rejected).toBeInstanceOf(Error);
            const terminal = await inspectDeliveryProductionOperation(lease, paths);
            expect(terminal).toMatchObject({
                record: {
                    phase: "normal-runtime-starting",
                },
                state: "in-progress",
            });
            expect(starts).toBe(2);
        });
    });

    test("records success after recovering a committed target", async () => {
        const { options, paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const initial = await loadProductionActivationState(lease, paths);
            await commitProductionActivationState(lease, paths, initial, {
                current: {
                    releaseId: currentReleaseId,
                    runtimeRevision: currentRuntimeRevision,
                },
                formatVersion: 1,
                previous: null,
                transitionId: currentTransitionId,
            });
            await createDeliveryProductionOperation(
                lease,
                paths,
                operationCapsule(),
                1000
            );
            const targetActivation = {
                current: {
                    releaseId: targetReleaseId,
                    runtimeRevision: targetRuntimeRevision,
                },
                formatVersion: 1 as const,
                previous: {
                    databaseSnapshotTransitionId: operationTransitionId,
                    releaseId: currentReleaseId,
                    runtimeRevision: currentRuntimeRevision,
                },
                transitionId: operationTransitionId,
            };
            let settlements = 0;
            const receipt = await runProductionDeliveryExecutorUnderLease(
                lease,
                paths,
                options,
                {
                    activate: (...arguments_) =>
                        Effect.tryPromise({
                            catch: () => new Error("activation failed") as never,
                            try: async () => {
                                for (const phase of [
                                    "services-stopped",
                                    "current-snapshot-created",
                                    "target-database-ready",
                                    "target-services-started",
                                    "target-verified",
                                    "target-smoke-verified",
                                ] as const) {
                                    await arguments_[5]?.onProgress?.(phase);
                                }
                                const current = await loadProductionActivationState(
                                    lease,
                                    paths
                                );
                                await commitProductionActivationState(
                                    lease,
                                    paths,
                                    current,
                                    targetActivation
                                );
                                return targetActivation;
                            },
                        }),
                    createServices: () => ({
                        prepare: () => Promise.resolve(),
                        provision: () => Promise.resolve(),
                        settle: () => {
                            settlements += 1;
                            return settlements === 1
                                ? Promise.reject(
                                      new Error("transient settlement failure")
                                  )
                                : Promise.resolve();
                        },
                        start: () => Promise.resolve(),
                        stop: () => Promise.resolve(),
                        verifyReady: () => Promise.resolve(),
                        verifySmoke: () => Promise.resolve(),
                    }),
                    loadCurrentArtifacts: (_paths, releaseId, runtimeRevision) =>
                        Promise.resolve(describedArtifact(releaseId, runtimeRevision)),
                    loadTargetArtifacts: (_paths, releaseId, runtimeRevision) =>
                        Promise.resolve(artifact(releaseId, runtimeRevision)),
                    nowMs: () => 10_000,
                    verifyPreviewTailscaleOperator: () => Promise.resolve(),
                    verifyRunBeforeSnapshot: () => Promise.resolve(),
                }
            );
            expect(settlements).toBe(2);
            expect(receipt.result).toEqual({
                activation: targetActivation,
                completedAtMs: 10_000,
                outcome: "succeeded",
            });
        });
    });

    test("hands a descriptor-verified target to its own executor before activation", async () => {
        const { options, paths } = await fixture();
        const releaseRoot = path.join(paths.releasesDirectory, targetReleaseId);
        const authority = await materializeDescribedRelease(
            releaseRoot,
            targetReleaseId,
            targetRuntimeRevision
        );
        const targetRuntime = artifact(targetReleaseId, targetRuntimeRevision).runtime;

        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            await createDeliveryProductionOperation(
                lease,
                paths,
                operationCapsule({
                    ...publishedReleaseAuthority(
                        targetReleaseId,
                        "v1.2.3",
                        targetRuntimeRevision
                    ),
                    releaseDescriptorSha256: authority.descriptorSha256,
                    releaseManifestSha256: authority.manifestSha256,
                }),
                1000
            );
            const handoff = await rejectionError(
                runProductionDeliveryExecutorUnderLease(lease, paths, options, {
                    installRuntime: (_lease, _paths, identity, dependencies) => {
                        expect(identity).toEqual(targetRuntime.identity);
                        expect(dependencies?.sourceExecutable).toBe(
                            path.join(releaseRoot, "runtime/bun")
                        );
                        return Promise.resolve(targetRuntime);
                    },
                    nowMs: () => 2000,
                    verifyPreviewTailscaleOperator: () => Promise.resolve(),
                })
            );
            expect(handoff.name).toBe("TargetExecutorHandoff");
            expect(await inspectDeliveryProductionOperation(lease, paths)).toMatchObject({
                record: { phase: "target-executor-owner-transferred" },
                state: "in-progress",
            });
        });
        expect(await inspectProductionDeliveryExecutorOwner(options.projectRoot)).toEqual(
            {
                formatVersion: 1,
                releaseId: targetReleaseId,
                runtimeRevision: targetRuntimeRevision,
                transitionId: operationTransitionId,
            }
        );
    });

    test.each(["descriptor", "manifest"] as const)(
        "rejects retained deploy authority with a mismatched %s before handoff",
        async (mismatch) => {
            const { options, paths } = await fixture();
            const releaseRoot = path.join(paths.releasesDirectory, targetReleaseId);
            const authority = await materializeDescribedRelease(
                releaseRoot,
                targetReleaseId,
                targetRuntimeRevision
            );
            const published = publishedReleaseAuthority(
                targetReleaseId,
                "v1.2.3",
                targetRuntimeRevision
            );
            const capsule = operationCapsule({
                ...published,
                releaseDescriptorSha256:
                    mismatch === "descriptor"
                        ? "0".repeat(64)
                        : authority.descriptorSha256,
                releaseManifestSha256:
                    mismatch === "manifest" ? "0".repeat(64) : authority.manifestSha256,
            });
            let installed = false;

            await withDeploymentLease(paths.stateDirectory, async (lease) => {
                await createDeliveryProductionOperation(lease, paths, capsule, 1000);
                const receipt = await runProductionDeliveryExecutorUnderLease(
                    lease,
                    paths,
                    options,
                    {
                        installRuntime: () => {
                            installed = true;
                            return Promise.resolve(
                                artifact(targetReleaseId, targetRuntimeRevision).runtime
                            );
                        },
                        verifyPreviewTailscaleOperator: () => Promise.resolve(),
                    }
                );
                expect(receipt).toMatchObject({
                    phase: "terminal",
                    result: { outcome: "unknown-outcome" },
                });
                expect(
                    await inspectDeliveryProductionOperation(lease, paths)
                ).toMatchObject({ record: { phase: "terminal" }, state: "terminal" });
            });
            expect(installed).toBe(false);
            expect(
                await inspectProductionDeliveryExecutorOwner(options.projectRoot)
            ).toMatchObject({
                releaseId: currentReleaseId,
                runtimeRevision: currentRuntimeRevision,
            });
        }
    );

    test("rejects an incompatible rollback target without transferring execution", async () => {
        const { options, paths } = await fixture();
        await materializeDescribedRelease(
            path.join(paths.releasesDirectory, targetReleaseId),
            targetReleaseId,
            targetRuntimeRevision
        );
        let installed = false;
        const current = describedArtifact(currentReleaseId, currentRuntimeRevision);

        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            await createDeliveryProductionOperation(
                lease,
                paths,
                rollbackCapsule(),
                1000
            );
            const receipt = await runProductionDeliveryExecutorUnderLease(
                lease,
                paths,
                options,
                {
                    createServices: () => ({
                        prepare: () => Promise.resolve(),
                        provision: () => Promise.resolve(),
                        settle: () => Promise.resolve(),
                        start: () => Promise.resolve(),
                        stop: () => Promise.resolve(),
                        verifyReady: () => Promise.resolve(),
                        verifySmoke: () => Promise.resolve(),
                    }),
                    installRuntime: () => {
                        installed = true;
                        return Promise.resolve(current.runtime);
                    },
                    loadCurrentArtifacts: () => Promise.resolve(current),
                    nowMs: () => 2000,
                    verifyPreviewTailscaleOperator: () => Promise.resolve(),
                }
            );
            expect(receipt.result).toMatchObject({ outcome: "unknown-outcome" });
        });
        expect(installed).toBe(false);
        expect(
            await inspectProductionDeliveryExecutorOwner(options.projectRoot)
        ).toMatchObject({
            releaseId: currentReleaseId,
            runtimeRevision: currentRuntimeRevision,
        });
    });

    test("builds, capacity-admits, installs, and publishes an exact clean target", async () => {
        const { options, paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const record = await createDeliveryProductionOperation(
                lease,
                paths,
                operationCapsule(),
                1000
            );
            const current = describedArtifact(currentReleaseId, currentRuntimeRevision);
            const target = artifact(targetReleaseId, targetRuntimeRevision);
            const calls: string[] = [];
            const candidateRuntimeExecutable = `${options.projectRoot}/production/checkout/dist/releases/${targetReleaseId}/runtime/bun`;
            const prepared = await prepareProductionDeliveryTargetUnderLease(
                lease,
                paths,
                options.projectRoot,
                record,
                current,
                "published-release",
                {
                    buildRelease: (_root, buildOptions) => {
                        expect(buildOptions?.runtimeIdentity).toEqual(
                            current.runtime.identity
                        );
                        calls.push("build");
                        return Promise.resolve({
                            manifest: target.release.manifest,
                            releaseRoot: `${options.projectRoot}/production/checkout/dist/releases/${targetReleaseId}`,
                        });
                    },
                    capacityAdmission: (
                        _lease,
                        _paths,
                        _sourceReleaseRoot,
                        _sourceManifest,
                        sourceExecutable
                    ) => {
                        expect(sourceExecutable).toBe(candidateRuntimeExecutable);
                        expect(sourceExecutable).not.toBe(current.runtime.executable);
                        calls.push("capacity");
                        return Promise.resolve();
                    },
                    installRuntime: (_lease, _paths, _identity, dependencies) => {
                        expect(dependencies?.sourceExecutable).toBe(
                            candidateRuntimeExecutable
                        );
                        calls.push("runtime");
                        return Promise.resolve(target.runtime);
                    },
                    publishRelease: () => {
                        calls.push("publish");
                        return Promise.resolve(target.release);
                    },
                    resolveSourceIdentity: () =>
                        Promise.resolve({
                            commitSha: targetReleaseId,
                            commitTitle: "Target release",
                            state: "clean",
                        }),
                }
            );

            expect(prepared).toEqual(target);
            expect(calls).toEqual(["build", "capacity", "runtime", "publish"]);
        });
    });

    test("preserves mismatched cached release bytes instead of opening a rollback gap", async () => {
        const { options, paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const record = await createDeliveryProductionOperation(
                lease,
                paths,
                operationCapsule(),
                1000
            );
            const publishedRoot = path.join(paths.releasesDirectory, targetReleaseId);
            await mkdir(publishedRoot, { recursive: true });
            await writeFile(
                path.join(publishedRoot, "release-manifest.json"),
                JSON.stringify({ source: { commitSha: targetReleaseId } })
            );

            expect(
                prepareProductionDeliveryTargetUnderLease(
                    lease,
                    paths,
                    options.projectRoot,
                    record,
                    describedArtifact(currentReleaseId, currentRuntimeRevision),
                    "published-release",
                    {}
                )
            ).rejects.toThrow("Production Delivery executor failed");
            const retained = await lstat(publishedRoot);
            expect(retained.isDirectory()).toBe(true);
        });
    });

    test("rejects missing retained artifacts without resolving or downloading a release", async () => {
        const { options, paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const record = await createDeliveryProductionOperation(
                lease,
                paths,
                operationCapsule(),
                1000
            );
            let sourceResolved = false;
            let downloadStarted = false;

            const retainedFailure = await rejectionError(
                prepareProductionDeliveryTargetUnderLease(
                    lease,
                    paths,
                    options.projectRoot,
                    record,
                    describedArtifact(currentReleaseId, currentRuntimeRevision),
                    "retained",
                    {
                        preparePublishedRelease: () => {
                            downloadStarted = true;
                            throw new Error("must not be reached");
                        },
                        resolveSourceIdentity: () => {
                            sourceResolved = true;
                            throw new Error("must not be reached");
                        },
                    }
                )
            );
            expect(retainedFailure.message).toBe("Production Delivery executor failed");
            expect(sourceResolved).toBeFalse();
            expect(downloadStarted).toBeFalse();
        });
    });

    test("admits published assets and root provisioning instead of building by default", async () => {
        const { options, paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const record = await createDeliveryProductionOperation(
                lease,
                paths,
                operationCapsule(),
                1000
            );
            const current = describedArtifact(currentReleaseId, currentRuntimeRevision);
            const target = artifact(targetReleaseId, targetRuntimeRevision);
            const calls: string[] = [];
            const checkoutRoot = `${options.projectRoot}/production/checkout`;
            await prepareProductionDeliveryTargetUnderLease(
                lease,
                paths,
                options.projectRoot,
                record,
                current,
                "published-release",
                {
                    preparationCapacityAdmission: () => {
                        calls.push("preparation-capacity");
                        return Promise.resolve();
                    },
                    capacityAdmission: () => Promise.resolve(),
                    discardCandidate: (releasesRoot, releaseRoot, releaseId) => {
                        expect(releasesRoot).toBe(`${checkoutRoot}/dist/releases`);
                        expect(releaseRoot).toBe(
                            `${checkoutRoot}/dist/releases/${targetReleaseId}`
                        );
                        expect(releaseId).toBe(targetReleaseId);
                        calls.push("discard-checkout-candidate");
                        return Promise.resolve();
                    },
                    installRuntime: (_lease, _paths, identity, dependencies) => {
                        expect(identity).toEqual(target.runtime.identity);
                        if (dependencies === undefined) {
                            throw new Error("Expected published runtime dependency");
                        }
                        expect(dependencies.sourceExecutable).toBe(
                            `${options.projectRoot}/production/checkout/dist/releases/${targetReleaseId}/runtime/bun`
                        );
                        return Promise.resolve(target.runtime);
                    },
                    preparePublishedRelease: (releaseId, checkoutRoot) => {
                        expect(releaseId).toBe(targetReleaseId);
                        expect(checkoutRoot).toEndWith("/production/checkout");
                        calls.push("published-assets-and-root-provisioning");
                        return Promise.resolve({
                            authority: publishedReleaseAuthority(
                                releaseId,
                                "v1.2.3",
                                targetRuntimeRevision
                            ),
                            releaseId,
                            releaseRoot: `${checkoutRoot}/dist/releases/${releaseId}`,
                        });
                    },
                    publishRelease: () => Promise.resolve(target.release),
                    resolveSourceIdentity: () =>
                        Promise.resolve({
                            commitSha: targetReleaseId,
                            commitTitle: "Target release",
                            state: "clean",
                        }),
                    verifyLocalRelease: () => Promise.resolve(target.release.manifest),
                }
            );
            expect(calls).toEqual([
                "preparation-capacity",
                "published-assets-and-root-provisioning",
                "discard-checkout-candidate",
            ]);
        });
    });

    test("rejects insufficient staging capacity before downloading release assets", async () => {
        const { options, paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const record = await createDeliveryProductionOperation(
                lease,
                paths,
                operationCapsule(),
                1000
            );
            let preparationStarted = false;

            const capacityFailure = await rejectionError(
                prepareProductionDeliveryTargetUnderLease(
                    lease,
                    paths,
                    options.projectRoot,
                    record,
                    describedArtifact(currentReleaseId, currentRuntimeRevision),
                    "published-release",
                    {
                        preparationCapacityAdmission: () =>
                            Promise.reject(new Error("insufficient capacity")),
                        preparePublishedRelease: () => {
                            preparationStarted = true;
                            throw new Error("must not be reached");
                        },
                        resolveSourceIdentity: () =>
                            Promise.resolve({
                                commitSha: targetReleaseId,
                                commitTitle: "Target release",
                                state: "clean",
                            }),
                    }
                )
            );
            expect(capacityFailure.message).toBe("insufficient capacity");
            expect(preparationStarted).toBeFalse();
        });
    });

    test("requires the exact Tailscale operator before confirming a cutover", async () => {
        const { options, paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            await createDeliveryProductionOperation(
                lease,
                paths,
                operationCapsule(),
                1000
            );
            let servicesCreated = false;
            const operatorFailure = await rejectionError(
                runProductionDeliveryExecutorUnderLease(lease, paths, options, {
                    createServices: () => {
                        servicesCreated = true;
                        throw new Error("must not be reached");
                    },
                    verifyPreviewTailscaleOperator: () =>
                        Promise.reject(new Error("operator drift")),
                })
            );
            expect(operatorFailure.message).toBe("Production Delivery executor failed");
            expect(servicesCreated).toBeFalse();
            const inspection = await inspectDeliveryProductionOperation(lease, paths);
            expect(inspection.state).toBe("in-progress");
            if (inspection.state !== "in-progress") throw new Error("unreachable");
            expect(inspection.record.phase).toBe("intent-recorded");
        });
    });

    test("stores an unknown receipt before effects when current activation CAS changed", async () => {
        const { options, paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            await createDeliveryProductionOperation(
                lease,
                paths,
                operationCapsule(),
                1000
            );
            const receipt = await runProductionDeliveryExecutorUnderLease(
                lease,
                paths,
                options,
                {
                    loadCurrentArtifacts: (_paths, releaseId, runtimeRevision) =>
                        Promise.resolve(describedArtifact(releaseId, runtimeRevision)),
                    loadTargetArtifacts: (_paths, releaseId, runtimeRevision) =>
                        Promise.resolve(artifact(releaseId, runtimeRevision)),
                    nowMs: () => 10_000,
                    verifyPreviewTailscaleOperator: () => Promise.resolve(),
                }
            );
            expect(receipt.result).toEqual({
                activation: null,
                completedAtMs: 10_000,
                outcome: "unknown-outcome",
            });
        });
    });
});
