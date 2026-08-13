import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { readActiveProductionCutoverRecord } from "../../src/server/platform/release/deliveryCutoverValidation.ts";
import {
    deliveryProductionProtocol,
    type DeliveryProductionOperationCapsule,
} from "../../src/shared/deliveryProductionOperation.ts";
import {
    parseReleaseManifest,
    releaseBuildCommands,
    releaseDeliveryProtocols,
    releaseProcessRoles,
} from "../../src/shared/releaseManifest.ts";
import { reconcileDeliveryProductionCutoverBeforeValidation } from "../../src/worker/delivery/productionRecovery.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import {
    commitProductionActivationState,
    loadProductionActivationState,
} from "./productionActivationState.ts";
import {
    parseProductionDeliveryExecutorArguments,
    prepareProductionDeliveryTargetUnderLease,
    runProductionDeliveryExecutorUnderLease,
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
        await rm(directory, { force: true, recursive: true });
    }
});

function operationCapsule(): DeliveryProductionOperationCapsule {
    const payload = {
        activationRevision: "1".repeat(64),
        checkoutRevision: "2".repeat(64),
        expectedMainHeadSha: targetReleaseId,
        operation: "deploy" as const,
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
            actionKey: deliveryProductionProtocol,
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

function artifact(releaseId: string, runtimeRevision: string) {
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
                deliveryProtocols: [...releaseDeliveryProtocols],
                display: {
                    builtAtMs: 1_800_000_000_000,
                    commitTitle: "Test release",
                    schemaTarget: 1,
                },
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
                processRoles: [...releaseProcessRoles],
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

async function fixture() {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "mira-delivery-executor-"));
    temporaryDirectories.push(projectRoot);
    const state = await prepareProtectedProductionStatePath(projectRoot);
    const paths = await prepareProductionDeliveryDirectories(state);
    const options = parseProductionDeliveryExecutorArguments([
        "--operation=cutover",
        `--project-root=${projectRoot}`,
        "--readiness-url=http://127.0.0.1:3100/api/health/ready",
        `--transition=${operationTransitionId}`,
    ]);
    if (options.operation !== "cutover") throw new Error("Invalid test fixture");
    return { options, paths };
}

describe("production Delivery executor", () => {
    test("rejects extra, non-loopback, and malformed arguments", () => {
        expect(() =>
            parseProductionDeliveryExecutorArguments([
                "--operation=cutover",
                "--project-root=/srv/dashboard",
                "--readiness-url=https://dashboard.example/api/health/ready",
                `--transition=${operationTransitionId}`,
            ])
        ).toThrow("Usage: bun productionDelivery.js");
        expect(() =>
            parseProductionDeliveryExecutorArguments([
                "--operation=cutover",
                "--project-root=/srv/dashboard",
                "--readiness-url=http://127.0.0.1:3100/api/health/ready",
                `--transition=${operationTransitionId}`,
                "--token=secret",
            ])
        ).toThrow("Usage: bun productionDelivery.js");
    });

    test("mirrors exact phases and stores one receipt after target readiness", async () => {
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
                        start: () => Promise.resolve(),
                        stop: () => Promise.resolve(),
                        verifyReady: () => Promise.resolve(),
                        verifySmoke: () => Promise.resolve(),
                    }),
                    loadArtifacts: (_paths, releaseId, runtimeRevision) =>
                        Promise.resolve(artifact(releaseId, runtimeRevision)),
                    nowMs: () => 10_000,
                    verifyPreviewTailscaleOperator: () => Promise.resolve(),
                    verifyQueuedRunBeforeSnapshot: () => Promise.resolve(),
                }
            );

            expect(receipt.phase).toBe("terminal");
            expect(receipt.result).toEqual({
                activation: targetActivation,
                completedAtMs: 10_000,
                outcome: "succeeded",
            });
            const replay = await runProductionDeliveryExecutorUnderLease(
                lease,
                paths,
                options
            );
            expect(replay).toEqual(receipt);
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
            const current = artifact(currentReleaseId, currentRuntimeRevision);
            const target = artifact(targetReleaseId, targetRuntimeRevision);
            const calls: string[] = [];
            const prepared = await prepareProductionDeliveryTargetUnderLease(
                lease,
                paths,
                options.projectRoot,
                record,
                current,
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
                    capacityAdmission: () => {
                        calls.push("capacity");
                        return Promise.resolve();
                    },
                    installRuntime: () => {
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
                    loadArtifacts: (_paths, releaseId, runtimeRevision) =>
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
