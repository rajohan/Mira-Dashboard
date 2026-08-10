import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import * as v from "valibot";

import { captureFailure } from "../../server/test/support/promise.ts";
import {
    logMaintenanceAvailabilityProjectionFileName,
    logMaintenanceAvailabilityProjectionSchema,
    logMaintenanceAvailabilityRefreshIntervalMs,
} from "../../shared/logMaintenanceAvailabilityProjection.ts";
import {
    startLogMaintenanceAvailabilityPublisher,
    type LogMaintenanceAvailabilityPublisherScheduler,
} from "./logMaintenanceAvailabilityPublisher.ts";

const expectedUserId = process.getuid?.() ?? 0;
const temporaryRoots: string[] = [];

class ControlledScheduler implements LogMaintenanceAvailabilityPublisherScheduler {
    readonly delays: number[] = [];
    #pending:
        | {
              readonly reject: (error: unknown) => void;
              readonly resolve: () => void;
              readonly signal: AbortSignal;
          }
        | undefined;

    wait(delayMs: number, signal: AbortSignal): Promise<void> {
        this.delays.push(delayMs);
        return new Promise<void>((resolve, reject) => {
            const onAbort = (): void => reject(new Error("cancelled"));
            signal.addEventListener("abort", onAbort, { once: true });
            this.#pending = {
                reject,
                resolve: () => {
                    signal.removeEventListener("abort", onAbort);
                    resolve();
                },
                signal,
            };
        });
    }

    release(): void {
        const pending = this.#pending;
        if (pending === undefined) throw new Error("No scheduled refresh is pending");
        this.#pending = undefined;
        pending.resolve();
    }
}

async function temporaryRoot(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "mira-log-publisher-"));
    temporaryRoots.push(root);
    return root;
}

async function readProjection(root: string) {
    return v.parse(
        logMaintenanceAvailabilityProjectionSchema,
        JSON.parse(
            await readFile(
                path.join(root, logMaintenanceAvailabilityProjectionFileName),
                "utf8"
            )
        ) as unknown
    );
}

afterEach(async () => {
    await Promise.all(
        temporaryRoots.splice(0).map(async (root) => {
            await chmod(root, 0o700).catch(() => {});
            await rm(root, { force: true, recursive: true });
        })
    );
});

describe("worker log-maintenance availability publisher", () => {
    test("atomically publishes an allowlisted contract-ordered private projection", async () => {
        const root = await temporaryRoot();
        const scheduler = new ControlledScheduler();
        const publisher = await startLogMaintenanceAvailabilityPublisher({
            availablePolicies: () =>
                Promise.resolve([
                    "host-rsyslog",
                    "docker-managed",
                    "host-rsyslog",
                    "private-policy" as never,
                ]),
            expectedUserId,
            logMaintenanceRoot: root,
            nowMs: () => 1000,
            scheduler,
        });

        expect(await readProjection(root)).toEqual({
            observedAtMs: 1000,
            policies: ["docker-managed", "host-rsyslog"],
            version: 1,
        });
        const projectionStatus = await lstat(
            path.join(root, logMaintenanceAvailabilityProjectionFileName)
        );
        expect(projectionStatus.mode & 0o777).toBe(0o600);
        expect(await readdir(root)).toEqual([
            logMaintenanceAvailabilityProjectionFileName,
        ]);
        expect(scheduler.delays).toEqual([logMaintenanceAvailabilityRefreshIntervalMs]);

        const firstStop = publisher.stop();
        expect(publisher.stop()).toBe(firstStop);
        await firstStop;
        expect(await readProjection(root)).toEqual({
            observedAtMs: 1000,
            policies: [],
            version: 1,
        });
        await publisher.completion;
    });

    test("serially refreshes and clears availability before stopping", async () => {
        const root = await temporaryRoot();
        const scheduler = new ControlledScheduler();
        let now = 1000;
        let observations = 0;
        let resolveSecondObservation!: () => void;
        const secondObservation = new Promise<void>((resolve) => {
            resolveSecondObservation = resolve;
        });
        const publisher = await startLogMaintenanceAvailabilityPublisher({
            availablePolicies: () => {
                observations += 1;
                if (observations === 2) resolveSecondObservation();
                return Promise.resolve(
                    observations === 1 ? ["docker-managed"] : ["host-rsyslog"]
                );
            },
            expectedUserId,
            logMaintenanceRoot: root,
            nowMs: () => now,
            scheduler,
        });

        now = 2000;
        scheduler.release();
        await secondObservation;
        let refreshedProjection = await readProjection(root);
        while (refreshedProjection.observedAtMs !== 2000) {
            await Promise.resolve();
            refreshedProjection = await readProjection(root);
        }
        expect(await readProjection(root)).toEqual({
            observedAtMs: 2000,
            policies: ["host-rsyslog"],
            version: 1,
        });
        expect(observations).toBe(2);

        now = 3000;
        await publisher.stop();
        expect(await readProjection(root)).toEqual({
            observedAtMs: 3000,
            policies: [],
            version: 1,
        });
    });

    test("treats an aborted in-flight refresh as orderly shutdown", async () => {
        const root = await temporaryRoot();
        const scheduler = new ControlledScheduler();
        let observations = 0;
        let resolveRefreshStarted!: () => void;
        const refreshStarted = new Promise<void>((resolve) => {
            resolveRefreshStarted = resolve;
        });
        const publisher = await startLogMaintenanceAvailabilityPublisher({
            availablePolicies: (signal) => {
                observations += 1;
                if (observations === 1) return Promise.resolve(["docker-managed"]);
                resolveRefreshStarted();
                return new Promise((_resolve, reject) => {
                    signal?.addEventListener(
                        "abort",
                        () => reject(new Error("private cancellation reason")),
                        { once: true }
                    );
                });
            },
            expectedUserId,
            logMaintenanceRoot: root,
            nowMs: () => 2000,
            scheduler,
        });

        scheduler.release();
        await refreshStarted;
        await publisher.stop();

        expect(await readProjection(root)).toEqual({
            observedAtMs: 2000,
            policies: [],
            version: 1,
        });
        await publisher.completion;
    });

    test("rejects completion when a periodic durable publication fails", async () => {
        const root = await temporaryRoot();
        const scheduler = new ControlledScheduler();
        const publisher = await startLogMaintenanceAvailabilityPublisher({
            availablePolicies: () => Promise.resolve(["docker-managed"]),
            expectedUserId,
            logMaintenanceRoot: root,
            nowMs: () => 1000,
            scheduler,
        });

        await chmod(root, 0o750);
        scheduler.release();
        expect(await captureFailure(() => publisher.completion)).toEqual(
            new Error("Log maintenance availability publisher failed")
        );

        await chmod(root, 0o700);
        expect(await captureFailure(() => publisher.stop())).toEqual(
            new Error("Log maintenance availability publisher failed")
        );
        const stoppedProjection = await readProjection(root);
        expect(stoppedProjection.policies).toEqual([]);
    });

    test("rejects unsafe or symlinked state roots before publishing", async () => {
        const unsafeRoot = await temporaryRoot();
        await chmod(unsafeRoot, 0o750);
        expect(
            await captureFailure(() =>
                startLogMaintenanceAvailabilityPublisher({
                    availablePolicies: () => Promise.resolve([]),
                    expectedUserId,
                    logMaintenanceRoot: unsafeRoot,
                })
            )
        ).toEqual(new Error("Log maintenance availability publisher failed"));

        const realRoot = await temporaryRoot();
        const parent = await temporaryRoot();
        const linkedRoot = path.join(parent, "linked-root");
        await symlink(realRoot, linkedRoot);
        expect(
            await captureFailure(() =>
                startLogMaintenanceAvailabilityPublisher({
                    availablePolicies: () => Promise.resolve([]),
                    expectedUserId,
                    logMaintenanceRoot: linkedRoot,
                })
            )
        ).toEqual(new Error("Log maintenance availability publisher failed"));
        expect(await readdir(realRoot)).toEqual([]);
    });

    test("contains invalid clocks and private availability failures without artifacts", async () => {
        const invalidClockRoot = await temporaryRoot();
        expect(
            await captureFailure(() =>
                startLogMaintenanceAvailabilityPublisher({
                    availablePolicies: () => Promise.resolve([]),
                    expectedUserId,
                    logMaintenanceRoot: invalidClockRoot,
                    nowMs: () => Number.NaN,
                })
            )
        ).toEqual(new Error("Log maintenance availability publisher failed"));
        expect(await readdir(invalidClockRoot)).toEqual([]);

        const failedProbeRoot = await temporaryRoot();
        expect(
            await captureFailure(() =>
                startLogMaintenanceAvailabilityPublisher({
                    availablePolicies: () =>
                        Promise.reject(new Error("private systemd output")),
                    expectedUserId,
                    logMaintenanceRoot: failedProbeRoot,
                })
            )
        ).toEqual(new Error("Log maintenance availability publisher failed"));
        expect(await readdir(failedProbeRoot)).toEqual([]);
    });
});
