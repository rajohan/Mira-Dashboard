import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { DatabaseObservabilityCollectionLeaseError } from "../../shared/databaseObservabilityReconciliation.ts";
import {
    createFixedDatabaseObservabilityReconciler,
    databaseObservabilityReconcilerProcessEnvironment,
    databaseObservabilityReconciliationDeadlines,
    type DatabaseObservabilityReconcilerProcessRequest,
    type DatabaseObservabilityReconcilerProcessResult,
} from "./fixedDatabaseObservabilityReconciler.ts";

const bunExecutable = "/srv/mira-dashboard/production/runtimes/bun/revision/bun";
const releaseRoot = "/srv/mira-dashboard/production/releases/release";
const runnerPath = `${releaseRoot}/scripts/delivery/provisioning/database-observability/runProvisioning.ts`;
const encoder = new TextEncoder();
const catalogDigest = "a".repeat(64);
const collectionLeaseToken = "12345678-1234-4123-8123-123456789abc";

function result(
    value: unknown,
    overrides: Partial<DatabaseObservabilityReconcilerProcessResult> = {}
): DatabaseObservabilityReconcilerProcessResult {
    return {
        exitCode: 0,
        stderr: new Uint8Array(),
        stdout: encoder.encode(`${JSON.stringify(value)}\n`),
        ...overrides,
    };
}

function opened(status: "RECONCILED" | "UNCHANGED" = "UNCHANGED") {
    return result({
        catalogDigest,
        collectionLeaseToken,
        databaseCount: 8,
        mode: "open-approved-collection",
        status,
    });
}

function enabled() {
    return result({
        databaseCount: 8,
        mode: "enable-approved-collection",
        status: "OPENED",
    });
}

function closed() {
    return result({
        databaseCount: 0,
        mode: "close-approved-collection",
        status: "CLOSED",
    });
}

describe("fixed database observability collection lease", () => {
    test("uses exact immutable open/close runners around one collection", async () => {
        const requests: DatabaseObservabilityReconcilerProcessRequest[] = [];
        const order: string[] = [];
        const reconciler = createFixedDatabaseObservabilityReconciler({
            bunExecutable,
            process(request) {
                requests.push(request);
                const mode = request.argv[1];
                if (mode === "open-approved-collection") {
                    order.push("open");
                    return Promise.resolve(opened());
                }
                if (mode === "enable-approved-collection") {
                    order.push("enable");
                    return Promise.resolve(enabled());
                }
                order.push("close");
                return Promise.resolve(closed());
            },
            releaseRoot,
        });

        const approved = await reconciler.withApprovedCollection((status, signal) => {
            order.push("collect");
            expect(status).toBe("unchanged");
            expect(signal.aborted).toBeFalse();
            return Promise.resolve("payload");
        });

        expect(approved).toEqual({
            reconciliationStatus: "unchanged",
            value: "payload",
        });
        expect(order).toEqual(["open", "enable", "collect", "close"]);
        expect(requests).toEqual([
            {
                argv: [runnerPath, "open-approved-collection", "--approved"],
                cwd: releaseRoot,
                environment: databaseObservabilityReconcilerProcessEnvironment,
                executable: bunExecutable,
                signal: expect.any(AbortSignal),
            },
            {
                argv: [
                    runnerPath,
                    "enable-approved-collection",
                    "--approved",
                    "--collection-lease-token",
                    collectionLeaseToken,
                    "--catalog-digest",
                    catalogDigest,
                ],
                cwd: releaseRoot,
                environment: databaseObservabilityReconcilerProcessEnvironment,
                executable: bunExecutable,
                signal: expect.any(AbortSignal),
            },
            {
                argv: [runnerPath, "close-approved-collection", "--approved"],
                cwd: releaseRoot,
                environment: databaseObservabilityReconcilerProcessEnvironment,
                executable: bunExecutable,
                signal: expect.any(AbortSignal),
            },
        ]);
        expect(databaseObservabilityReconciliationDeadlines).toEqual({
            closeMs: 30_000,
            openMs: 300_000,
        });
    });

    test("maps reconciled and always closes after collection failure", async () => {
        const order: string[] = [];
        const collectionFailure = new Error("private collection failure");
        const reconciler = createFixedDatabaseObservabilityReconciler({
            bunExecutable,
            process(request) {
                const mode = request.argv[1];
                if (mode === "open-approved-collection") {
                    order.push("open");
                    return Promise.resolve(opened("RECONCILED"));
                }
                if (mode === "enable-approved-collection") {
                    order.push("enable");
                    return Promise.resolve(enabled());
                }
                order.push("close");
                return Promise.resolve(closed());
            },
            releaseRoot,
        });

        const failure = await reconciler
            .withApprovedCollection((status) => {
                order.push("collect");
                expect(status).toBe("reconciled");
                return Promise.resolve().then(() => {
                    throw collectionFailure;
                });
            })
            .catch((error: unknown) => error);

        expect(failure).toBe(collectionFailure);
        expect(order).toEqual(["open", "enable", "collect", "close"]);
    });

    test("closes after uncertain open and makes close failure authoritative", async () => {
        const openDriftOrder: string[] = [];
        let operationCalled = false;
        const openDrift = createFixedDatabaseObservabilityReconciler({
            bunExecutable,
            process(request) {
                const opens = request.argv[1] === "open-approved-collection";
                openDriftOrder.push(opens ? "open" : "close");
                return Promise.resolve(
                    opens
                        ? result({
                              databaseCount: 8,
                              mode: "open-approved-collection",
                              status: "ACTIVATED",
                          })
                        : closed()
                );
            },
            releaseRoot,
        });
        const openFailure = await openDrift
            .withApprovedCollection(() => {
                operationCalled = true;
                return Promise.resolve().then(() => "unused");
            })
            .catch((error: unknown) => error);
        expect(openFailure).toBeInstanceOf(DatabaseObservabilityCollectionLeaseError);
        expect(operationCalled).toBeFalse();
        expect(openDriftOrder).toEqual(["open", "close"]);

        const closeDriftOrder: string[] = [];
        const closeDrift = createFixedDatabaseObservabilityReconciler({
            bunExecutable,
            process(request) {
                const mode = request.argv[1];
                if (mode === "open-approved-collection") {
                    closeDriftOrder.push("open");
                    return Promise.resolve(opened());
                }
                if (mode === "enable-approved-collection") {
                    closeDriftOrder.push("enable");
                    return Promise.resolve(enabled());
                }
                closeDriftOrder.push("close");
                return Promise.resolve(
                    result({
                        databaseCount: 1,
                        mode: "close-approved-collection",
                        status: "CLOSED",
                    })
                );
            },
            releaseRoot,
        });
        const closeFailure = await closeDrift
            .withApprovedCollection(() => {
                closeDriftOrder.push("collect");
                return Promise.resolve().then(() => "must-not-escape");
            })
            .catch((error: unknown) => error);
        expect(closeFailure).toBeInstanceOf(DatabaseObservabilityCollectionLeaseError);
        expect(closeDriftOrder).toEqual(["open", "enable", "collect", "close"]);
    });

    test("uses an independent cleanup signal after caller cancellation", async () => {
        const signals: AbortSignal[] = [];
        const cancellation = new AbortController();
        const reconciler = createFixedDatabaseObservabilityReconciler({
            bunExecutable,
            process(request) {
                signals.push(request.signal);
                if (request.argv[1] === "open-approved-collection") {
                    return Promise.resolve(opened());
                }
                if (request.argv[1] === "enable-approved-collection") {
                    return Promise.resolve(enabled());
                }
                return Promise.resolve(closed());
            },
            releaseRoot,
        });

        const collectionFailure = new DOMException("cancelled", "AbortError");
        const failure = await reconciler
            .withApprovedCollection((_status, signal) => {
                expect(signal).toBe(cancellation.signal);
                cancellation.abort(collectionFailure);
                return Promise.resolve().then(() => {
                    throw collectionFailure;
                });
            }, cancellation.signal)
            .catch((error: unknown) => error);

        expect(failure).toBe(collectionFailure);
        expect(signals).toHaveLength(3);
        expect(signals[0]?.aborted).toBeTrue();
        expect(signals[1]?.aborted).toBeTrue();
        expect(signals[2]?.aborted).toBeFalse();
    });

    test("rejects non-canonical paths and redacts process/result failures", async () => {
        expect(() =>
            createFixedDatabaseObservabilityReconciler({
                bunExecutable: "bun",
                releaseRoot,
            })
        ).toThrow("Database observability reconciler paths are invalid");
        expect(() =>
            createFixedDatabaseObservabilityReconciler({
                bunExecutable,
                releaseRoot: `${releaseRoot}/../release`,
            })
        ).toThrow("Database observability reconciler paths are invalid");

        const secret = "postgresql://admin:secret@database/private";
        let call = 0;
        const reconciler = createFixedDatabaseObservabilityReconciler({
            bunExecutable,
            process: () => {
                call += 1;
                return Promise.resolve().then(() => {
                    if (call === 1) throw new Error(secret);
                    return closed();
                });
            },
            releaseRoot,
        });
        const failure = await reconciler
            .withApprovedCollection(() => Promise.resolve().then(() => "unused"))
            .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(DatabaseObservabilityCollectionLeaseError);
        expect(String(failure)).not.toContain(secret);
        expect(call).toBe(2);
    });

    test("aborting a real runner reaps a TERM-resistant descendant before close returns", async () => {
        const temporaryRoot = await mkdtemp(
            "/tmp/mira-dashboard-database-observability-supervisor-"
        );
        const temporaryRunner = path.join(
            temporaryRoot,
            "scripts/delivery/provisioning/database-observability/runProvisioning.ts"
        );
        const descendantPidPath = path.join(temporaryRoot, "descendant.pid");
        await mkdir(path.dirname(temporaryRunner), { recursive: true });
        await writeFile(
            temporaryRunner,
            `const mode = process.argv[2];
if (mode === "open-approved-collection") {
  const descendant = Bun.spawn(["/bin/sh", "-c", "trap '' TERM; while :; do /usr/bin/sleep 1; done"], { stderr: "ignore", stdin: "ignore", stdout: "ignore" });
  await Bun.write(${JSON.stringify(descendantPidPath)}, String(descendant.pid));
  await descendant.exited;
} else if (mode === "close-approved-collection") {
  process.stdout.write(${JSON.stringify(`${new TextDecoder().decode(closed().stdout)}`)});
} else {
  process.exitCode = 1;
}
`,
            { mode: 0o600 }
        );
        try {
            const cancellation = new AbortController();
            const reconciler = createFixedDatabaseObservabilityReconciler({
                bunExecutable: process.execPath,
                releaseRoot: temporaryRoot,
            });
            const collection = reconciler
                .withApprovedCollection(async () => {
                    await Bun.sleep(0);
                    return "must-not-run";
                }, cancellation.signal)
                .catch((error: unknown) => error);

            let descendantPid = 0;
            for (let attempt = 0; attempt < 100; attempt += 1) {
                try {
                    const candidatePid = Number(
                        await readFile(descendantPidPath, "utf8")
                    );
                    if (Number.isSafeInteger(candidatePid) && candidatePid > 1) {
                        descendantPid = candidatePid;
                        break;
                    }
                } catch {
                    // The descendant creates its PID file asynchronously; retry below.
                }
                await Bun.sleep(10);
            }
            expect(Number.isSafeInteger(descendantPid)).toBe(true);
            expect(descendantPid).toBeGreaterThan(1);
            cancellation.abort();
            expect(await collection).toBeInstanceOf(
                DatabaseObservabilityCollectionLeaseError
            );

            let descendantExists = true;
            for (let attempt = 0; attempt < 100; attempt += 1) {
                try {
                    process.kill(descendantPid, 0);
                    await Bun.sleep(10);
                } catch {
                    descendantExists = false;
                    break;
                }
            }
            expect(descendantExists).toBe(false);
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });
});
