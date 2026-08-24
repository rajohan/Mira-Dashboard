import { afterEach, describe, expect, test } from "bun:test";
import {
    chmod,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    unlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
    DeliveryProductionOperationCapsule,
    DeliveryProductionTerminalRecord,
} from "../../src/shared/deliveryProductionOperation.ts";
import { publishedReleaseAuthority } from "../../src/testSupport/publishedReleaseAuthority.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
import {
    advanceDeliveryProductionOperation,
    clearDeliveryProductionOperation,
    completeDeliveryProductionOperation,
    createDeliveryProductionOperation,
    inspectDeliveryProductionOperation,
    inspectDeliveryProductionReceipt,
    retainDeliveryProductionReceipts,
} from "./productionDeliveryOperationFilesystem.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";

const temporaryDirectories: string[] = [];
const operationDirectoryName = "delivery-production-operations";

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await rm(directory, { force: true, recursive: true });
    }
});

async function fixture() {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "mira-delivery-operation-"));
    temporaryDirectories.push(projectRoot);
    const state = await prepareProtectedProductionStatePath(projectRoot);
    const paths = await prepareProductionDeliveryDirectories(state);
    return { paths };
}

function capsule(
    transitionId: string,
    operation: "deploy" | "rollback-release" = "deploy"
): DeliveryProductionOperationCapsule {
    const targetReleaseId = "c".repeat(40);
    const payload =
        operation === "rollback-release"
            ? {
                  activationRevision: "1".repeat(64),
                  operation,
                  sourceRevision: "f".repeat(64),
                  target: {
                      databaseSnapshotTransitionId:
                          "019fd974-54a2-74dd-a64b-d4186f8d8802",
                      releaseId: targetReleaseId,
                      runtimeRevision: "d".repeat(40),
                  },
              }
            : {
                  activationRevision: "1".repeat(64),
                  checkoutRevision: "2".repeat(64),
                  expectedMainHeadSha: targetReleaseId,
                  operation,
                  release: publishedReleaseAuthority(
                      targetReleaseId,
                      "v1.2.3",
                      "d".repeat(40)
                  ),
                  sourceRevision: "f".repeat(64),
              };
    return {
        cas: {
            current: {
                activationTransitionId: "019fd974-54a2-74dd-a64b-d4186f8d8801",
                releaseId: "a".repeat(40),
                rollbackSnapshotTransitionId: transitionId,
                runtimeRevision: "b".repeat(40),
            },
            target: {
                databaseSnapshotTransitionId:
                    operation === "rollback-release"
                        ? "019fd974-54a2-74dd-a64b-d4186f8d8802"
                        : null,
                releaseId: targetReleaseId,
                runtimeRevision: "d".repeat(40),
            },
        },
        enqueue: {
            actionKey: "delivery.production.v1",
            actor: {
                authenticatorId: "a".repeat(32),
                id: "019fd974-54a2-74dd-a64b-d4186f8d8803",
                kind: "user",
            },
            audit: {
                eventId: "019fd974-54a2-74dd-a64b-d4186f8d8804",
                requestId: "request-production-cutover",
            },
            enqueueSha256: "e".repeat(64),
            idempotencyKey: "A".repeat(32),
            payload,
            payloadSha256: new Bun.CryptoHasher("sha256")
                .update(JSON.stringify(payload))
                .digest("hex"),
            queuedAtMs: 1000,
        },
        executor: {
            releaseId: "e".repeat(40),
            runtimeRevision: "b".repeat(40),
        },
        protocol: "delivery.production.v1",
        runId: transitionId,
        transitionId,
    };
}

function successResult(transitionId: string) {
    return {
        activation: {
            current: {
                releaseId: "c".repeat(40),
                runtimeRevision: "d".repeat(40),
            },
            formatVersion: 1 as const,
            previous: {
                databaseSnapshotTransitionId: transitionId,
                releaseId: "a".repeat(40),
                runtimeRevision: "b".repeat(40),
            },
            transitionId,
        },
        completedAtMs: 10_000,
        outcome: "succeeded" as const,
    };
}

async function completeOne(
    paths: Awaited<ReturnType<typeof fixture>>["paths"],
    transitionId: string,
    operation: "deploy" | "rollback-release" = "deploy"
): Promise<DeliveryProductionTerminalRecord> {
    return withDeploymentLease(paths.stateDirectory, async (lease) => {
        const created = await createDeliveryProductionOperation(
            lease,
            paths,
            capsule(transitionId, operation),
            1000
        );
        const confirmed = await advanceDeliveryProductionOperation(
            lease,
            paths,
            created,
            "executor-confirmed",
            2000
        );
        const receipt = await completeDeliveryProductionOperation(
            lease,
            paths,
            confirmed,
            successResult(transitionId)
        );
        await clearDeliveryProductionOperation(lease, paths, receipt);
        return receipt;
    });
}

describe("production delivery operation filesystem", () => {
    test("rejects a mismatched payload digest before persistence", async () => {
        const { paths } = await fixture();
        const transitionId = Bun.randomUUIDv7();
        const invalid = capsule(transitionId);

        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const rejected = await rejectionError(
                createDeliveryProductionOperation(
                    lease,
                    paths,
                    {
                        ...invalid,
                        enqueue: {
                            ...invalid.enqueue,
                            payloadSha256: "0".repeat(64),
                        },
                    },
                    1000
                )
            );
            expect(rejected.message).toBe(
                "Production delivery operation filesystem failed"
            );
            expect(await inspectDeliveryProductionOperation(lease, paths)).toEqual({
                state: "missing",
            });
        });
    });

    test("persists exact adjacent phases, one immutable receipt, and active cleanup", async () => {
        const { paths } = await fixture();
        const transitionId = Bun.randomUUIDv7();

        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            expect(await inspectDeliveryProductionOperation(lease, paths)).toEqual({
                state: "missing",
            });
            const created = await createDeliveryProductionOperation(
                lease,
                paths,
                capsule(transitionId),
                1000
            );
            const active = await inspectDeliveryProductionOperation(lease, paths);
            expect(active.state).toBe("in-progress");

            const skipped = await rejectionError(
                advanceDeliveryProductionOperation(
                    lease,
                    paths,
                    created,
                    "services-stopped",
                    2000
                )
            );
            expect(skipped.message).toBe(
                "Production delivery operation filesystem failed"
            );
            const confirmed = await advanceDeliveryProductionOperation(
                lease,
                paths,
                created,
                "executor-confirmed",
                2000
            );
            const receipt = await completeDeliveryProductionOperation(
                lease,
                paths,
                confirmed,
                successResult(transitionId)
            );
            const terminal = await inspectDeliveryProductionOperation(lease, paths);
            expect(terminal.state).toBe("terminal");
            await clearDeliveryProductionOperation(lease, paths, receipt);
            expect(await inspectDeliveryProductionOperation(lease, paths)).toEqual({
                state: "missing",
            });
            const historical = await inspectDeliveryProductionReceipt(
                lease,
                paths,
                transitionId
            );
            expect(historical.state).toBe("terminal");
        });

        const operationDirectory = path.join(
            paths.stateDirectory,
            operationDirectoryName
        );
        const operationDirectoryStatus = await stat(operationDirectory);
        expect(operationDirectoryStatus.mode & 0o777).toBe(0o700);
        const receiptFile = path.join(operationDirectory, `receipt-${transitionId}.json`);
        const receiptStatus = await stat(receiptFile);
        expect(receiptStatus.mode & 0o777).toBe(0o600);
    });

    test("treats a receipt-first crash as terminal and never repeats the effect", async () => {
        const { paths } = await fixture();
        const transitionId = Bun.randomUUIDv7();

        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const created = await createDeliveryProductionOperation(
                lease,
                paths,
                capsule(transitionId),
                1000
            );
            const failure = await rejectionError(
                completeDeliveryProductionOperation(
                    lease,
                    paths,
                    created,
                    successResult(transitionId),
                    {
                        afterReceiptStored: () => {
                            throw new Error("simulated crash");
                        },
                    }
                )
            );
            expect(failure.message).toBe(
                "Production delivery operation filesystem failed"
            );
            const recovered = await inspectDeliveryProductionOperation(lease, paths);
            expect(recovered.state).toBe("terminal");
            if (recovered.state !== "terminal") throw new Error("expected receipt");
            await clearDeliveryProductionOperation(lease, paths, recovered.record);
            const historical = await inspectDeliveryProductionReceipt(
                lease,
                paths,
                transitionId
            );
            expect(historical.state).toBe("terminal");
        });
    });

    test("distinguishes a valid terminal journal with a missing receipt as conflict", async () => {
        const { paths } = await fixture();
        const transitionId = Bun.randomUUIDv7();

        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const created = await createDeliveryProductionOperation(
                lease,
                paths,
                capsule(transitionId),
                1000
            );
            await completeDeliveryProductionOperation(
                lease,
                paths,
                created,
                successResult(transitionId)
            );
            await unlink(
                path.join(
                    paths.stateDirectory,
                    operationDirectoryName,
                    `receipt-${transitionId}.json`
                )
            );
            expect(await inspectDeliveryProductionOperation(lease, paths)).toEqual({
                state: "conflict",
                transitionId,
            });
        });
    });

    test("retains a paired-rollback capsule for exact old Job-run rehydration", async () => {
        const { paths } = await fixture();
        const transitionId = Bun.randomUUIDv7();
        const receipt = await completeOne(paths, transitionId, "rollback-release");

        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const restored = await inspectDeliveryProductionReceipt(
                lease,
                paths,
                transitionId
            );
            expect(restored).toEqual({
                record: receipt,
                state: "terminal",
                transitionId,
            });
            if (restored.state !== "terminal") throw new Error("expected receipt");
            expect(restored.record.capsule.runId).toBe(transitionId);
            expect(restored.record.capsule.enqueue.actor.authenticatorId).toBe(
                "a".repeat(32)
            );
            expect(restored.record.capsule.cas.target.databaseSnapshotTransitionId).toBe(
                "019fd974-54a2-74dd-a64b-d4186f8d8802"
            );
        });
    });

    test("fails closed on mode drift and descriptor/path inode replacement", async () => {
        const { paths } = await fixture();
        const transitionId = Bun.randomUUIDv7();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            await createDeliveryProductionOperation(
                lease,
                paths,
                capsule(transitionId),
                1000
            );
        });
        const inFlight = path.join(
            paths.stateDirectory,
            operationDirectoryName,
            "in-flight.json"
        );
        await chmod(inFlight, 0o640);
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const driftFailure = await rejectionError(
                inspectDeliveryProductionOperation(lease, paths)
            );
            expect(driftFailure.message).toBe(
                "Production delivery operation filesystem failed"
            );
        });
        await chmod(inFlight, 0o600);

        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const failure = await rejectionError(
                inspectDeliveryProductionOperation(lease, paths, {
                    afterRead: async (fileName) => {
                        if (fileName !== "in-flight.json") return;
                        const displaced = `${inFlight}.displaced`;
                        const bytes = await readFile(inFlight);
                        await rename(inFlight, displaced);
                        await writeFile(inFlight, bytes, { mode: 0o600 });
                    },
                })
            );
            expect(failure.message).toBe(
                "Production delivery operation filesystem failed"
            );
        });
    });

    test("prunes only unreferenced receipts and catches a late inode swap", async () => {
        const { paths } = await fixture();
        const currentId = Bun.randomUUIDv7();
        const previousId = Bun.randomUUIDv7();
        const retiredId = Bun.randomUUIDv7();
        await completeOne(paths, currentId);
        await completeOne(paths, previousId);
        await completeOne(paths, retiredId);

        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            await retainDeliveryProductionReceipts(lease, paths, {
                currentTransitionId: currentId,
                inFlightTransitionId: null,
                previousTransitionId: previousId,
            });
            const current = await inspectDeliveryProductionReceipt(
                lease,
                paths,
                currentId
            );
            const previous = await inspectDeliveryProductionReceipt(
                lease,
                paths,
                previousId
            );
            const retired = await inspectDeliveryProductionReceipt(
                lease,
                paths,
                retiredId
            );
            expect(current.state).toBe("terminal");
            expect(previous.state).toBe("terminal");
            expect(retired.state).toBe("missing");
        });

        const nextRetiredId = Bun.randomUUIDv7();
        await completeOne(paths, nextRetiredId);
        const receiptPath = path.join(
            paths.stateDirectory,
            operationDirectoryName,
            `receipt-${nextRetiredId}.json`
        );
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const failure = await rejectionError(
                retainDeliveryProductionReceipts(
                    lease,
                    paths,
                    {
                        currentTransitionId: currentId,
                        inFlightTransitionId: null,
                        previousTransitionId: previousId,
                    },
                    {
                        beforeReceiptRemoved: async (transitionId) => {
                            if (transitionId !== nextRetiredId) return;
                            const bytes = await readFile(receiptPath);
                            await rename(receiptPath, `${receiptPath}.displaced`);
                            await writeFile(receiptPath, bytes, { mode: 0o600 });
                        },
                    }
                )
            );
            expect(failure.message).toBe(
                "Production delivery operation filesystem failed"
            );
        });
        expect(await stat(receiptPath)).toBeDefined();
        const remainingEntries = await readdir(path.dirname(receiptPath));
        expect(remainingEntries).toContain(`receipt-${nextRetiredId}.json.displaced`);
    });
});
