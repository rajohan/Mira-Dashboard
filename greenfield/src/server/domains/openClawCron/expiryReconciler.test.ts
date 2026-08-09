import { describe, expect, test } from "bun:test";

import {
    createOpenClawCronExpiryReconciler,
    type OpenClawCronExpiryReconciliationFailure,
} from "./expiryReconciler.ts";
import { createInMemoryOpenClawCronIntentStore } from "./intentStore.ts";
import { OpenClawCronServiceError } from "./service.ts";

const actor = { id: "operator", kind: "user" } as const;

function deferredVoid() {
    let resolveDeferred!: () => void;
    const promise = new Promise<void>((resolve) => {
        resolveDeferred = resolve;
    });
    return { promise, resolve: resolveDeferred };
}

describe("OpenClaw cron expiry reconciler", () => {
    test("scans a bounded oldest-first batch and reconciles each exact target", async () => {
        const store = createInMemoryOpenClawCronIntentStore();
        await store.replaceActive({
            actor,
            expiresAtMs: 900,
            externalJobId: "later",
            reason: "Maintenance",
            recordedAtMs: 100,
        });
        await store.replaceActive({
            actor,
            expiresAtMs: 800,
            externalJobId: "earlier",
            reason: "Maintenance",
            recordedAtMs: 100,
        });
        await store.replaceActive({
            actor,
            expiresAtMs: 2000,
            externalJobId: "future",
            reason: "Maintenance",
            recordedAtMs: 100,
        });
        const calls: string[] = [];
        const reconciler = createOpenClawCronExpiryReconciler({
            batchSize: 2,
            clock: () => 1000,
            intentStore: store,
            service: {
                reconcileExpired: ({ id }) => {
                    calls.push(id);
                    return Promise.resolve({} as never);
                },
            },
        });

        expect(await reconciler.reconcile()).toEqual({
            attempted: 2,
            failed: 0,
            hasMore: true,
            reconciled: 2,
        });
        expect(calls).toEqual(["earlier", "later"]);
    });

    test("continues after classified failures without exposing raw causes", async () => {
        const store = createInMemoryOpenClawCronIntentStore();
        for (const externalJobId of ["conflict", "unexpected", "healthy"]) {
            await store.replaceActive({
                actor,
                expiresAtMs: 900,
                externalJobId,
                reason: "Maintenance",
                recordedAtMs: 100,
            });
        }
        const failures: OpenClawCronExpiryReconciliationFailure[] = [];
        const reconciler = createOpenClawCronExpiryReconciler({
            clock: () => 1000,
            intentStore: store,
            onFailure: (failure) => failures.push(failure),
            service: {
                reconcileExpired: ({ id }) => {
                    if (id === "conflict") {
                        return Promise.reject(
                            new OpenClawCronServiceError("conflict", {
                                cause: new Error("private Gateway detail"),
                            })
                        );
                    }
                    if (id === "unexpected") {
                        return Promise.reject(new Error("private database detail"));
                    }
                    return Promise.resolve({} as never);
                },
            },
        });

        expect(await reconciler.reconcile()).toEqual({
            attempted: 3,
            failed: 2,
            hasMore: false,
            reconciled: 1,
        });
        expect(failures).toEqual([
            { externalJobId: "conflict", reason: "conflict" },
            { externalJobId: "unexpected", reason: "unexpected" },
        ]);
        expect(JSON.stringify(failures)).not.toContain("private");
    });

    test("rejects unbounded scans and supports idempotent lifecycle shutdown", async () => {
        const store = createInMemoryOpenClawCronIntentStore();
        expect(store.listExpired(1000, 101)).rejects.toBeInstanceOf(RangeError);
        const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
        const cancelled: unknown[] = [];
        const reconciler = createOpenClawCronExpiryReconciler({
            clock: () => 1000,
            intentStore: store,
            service: { reconcileExpired: () => Promise.resolve({} as never) },
            timer: {
                cancel: (handle) => cancelled.push(handle),
                schedule: (callback, delayMs) => {
                    const handle = { callback, delayMs };
                    scheduled.push(handle);
                    return handle;
                },
            },
        });

        reconciler.start();
        reconciler.start();
        expect(scheduled).toHaveLength(1);
        expect(scheduled[0]?.delayMs).toBe(1);
        await reconciler.stop();
        await reconciler.stop();
        expect(cancelled).toEqual([scheduled[0]]);
        expect(() => reconciler.start()).toThrow();
    });

    test("serializes lifecycle runs and schedules the next bounded pass", async () => {
        const store = createInMemoryOpenClawCronIntentStore();
        const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
        const reconciler = createOpenClawCronExpiryReconciler({
            clock: () => 1000,
            intentStore: store,
            intervalMs: 2500,
            service: { reconcileExpired: () => Promise.resolve({} as never) },
            timer: {
                cancel: () => {},
                schedule: (callback, delayMs) => {
                    scheduled.push({ callback, delayMs });
                    return scheduled.length;
                },
            },
        });

        reconciler.start();
        scheduled[0]?.callback();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(scheduled.map(({ delayMs }) => delayMs)).toEqual([1, 2500]);
        await reconciler.stop();
    });

    test("lets force shutdown release a reconciliation that ignores cancellation", async () => {
        const store = createInMemoryOpenClawCronIntentStore();
        await store.replaceActive({
            actor,
            expiresAtMs: 900,
            externalJobId: "stalled",
            reason: "Maintenance",
            recordedAtMs: 100,
        });
        const stalled = deferredVoid();
        const scheduled: Array<() => void> = [];
        const reconciler = createOpenClawCronExpiryReconciler({
            clock: () => 1000,
            intentStore: store,
            service: {
                reconcileExpired: () => stalled.promise.then(() => ({}) as never),
            },
            timer: {
                cancel: () => {},
                schedule: (callback) => {
                    scheduled.push(callback);
                    return callback;
                },
            },
        });

        reconciler.start();
        scheduled[0]?.();
        await Promise.resolve();
        await Promise.resolve();
        const gracefulStop = reconciler.stop();
        let gracefullyStopped = false;
        void gracefulStop.then(() => {
            gracefullyStopped = true;
            return true;
        });
        await Promise.resolve();
        expect(gracefullyStopped).toBeFalse();

        expect(reconciler.stop(true)).toBe(gracefulStop);
        await gracefulStop;
        expect(gracefullyStopped).toBeTrue();

        stalled.resolve();
        await Promise.resolve();
    });
});
