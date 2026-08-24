import { describe, expect, test } from "bun:test";

import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
    cancelShutdownStreamBeforeDeadline,
    collectLinuxProcessGroupMembers,
    completeShutdownScenario,
    interruptedShutdownScenario,
    linuxProcessStatReadConcurrency,
    parseLinuxProcessStat,
} from "./completeShutdownScenario.ts";

describe("complete process shutdown scenario", () => {
    test("bounds a non-cooperative stream finalizer and continues older cleanup", async () => {
        const events: string[] = [];
        const program = Effect.gen(function* () {
            const cancelStarted = yield* Deferred.make<void>();
            const cleanupFiber = yield* Effect.scoped(
                Effect.gen(function* () {
                    yield* Effect.addFinalizer(() =>
                        Effect.sync(() => {
                            events.push("fallback");
                        })
                    );
                    yield* Effect.addFinalizer(() =>
                        Effect.sync(() => {
                            events.push("cancel");
                        }).pipe(
                            Effect.andThen(Deferred.succeed(cancelStarted, undefined)),
                            Effect.andThen(
                                cancelShutdownStreamBeforeDeadline(
                                    () => new Promise<void>(() => {}),
                                    25
                                )
                            )
                        )
                    );
                })
            ).pipe(Effect.forkChild);

            yield* Deferred.await(cancelStarted);
            yield* TestClock.adjust(25);
            yield* Fiber.join(cleanupFiber);
        });

        await Effect.runPromise(Effect.provide(program, TestClock.layer()));

        expect(events).toEqual(["cancel", "fallback"]);
    });

    test("parses Linux stat records whose command contains spaces and parentheses", () => {
        expect(
            parseLinuxProcessStat(
                "123 (bun worker (test)) S 100 123 123 0 -1 4194304 0 0 0 0"
            )
        ).toEqual({ processGroupId: 123, processId: 123 });
        expect(() => parseLinuxProcessStat("invalid")).toThrow(
            "Malformed Linux process stat record"
        );
    });

    test("bounds concurrent process-stat reads and tolerates exited candidates", async () => {
        const candidateProcessIds = Array.from({ length: 64 }, (_, index) => index + 100);
        const processGroupId = 4242;
        let activeReads = 0;
        let peakReads = 0;
        const members = await Effect.runPromise(
            collectLinuxProcessGroupMembers(
                candidateProcessIds,
                processGroupId,
                (processId) =>
                    Effect.sync(() => {
                        activeReads += 1;
                        peakReads = Math.max(peakReads, activeReads);
                    }).pipe(
                        Effect.andThen(Effect.sleep("5 millis")),
                        Effect.as(
                            processId === candidateProcessIds.at(-1)
                                ? null
                                : `${processId} (bounded reader) S 1 ${processGroupId} 1 0`
                        ),
                        Effect.ensuring(
                            Effect.sync(() => {
                                activeReads -= 1;
                            })
                        )
                    )
            )
        );

        expect(peakReads).toBeGreaterThan(1);
        expect(peakReads).toBeLessThanOrEqual(linuxProcessStatReadConcurrency);
        expect(activeReads).toBe(0);
        expect(members).toEqual(candidateProcessIds.slice(0, -1));
    });

    test("drains readiness before resources and restarts with WAL recovery", async () => {
        const report = await Effect.runPromise(completeShutdownScenario);

        expect(report.database).toEqual({
            activeLeaseCount: 0,
            cleanGenerationCount: 2,
            generations: [1, 2],
            integrityCheck: "ok",
            journalMode: "wal",
            releasedLeaseCount: 2,
        });
        expect(report.generations[0].readyStatus.recoveredGenerationCount).toBe(0);
        expect(report.generations[1].readyStatus.recoveredGenerationCount).toBe(1);

        for (const generation of report.generations) {
            expect(generation.startingReadinessStatus).toBe(503);
            expect(generation.stoppingReadinessStatus).toBe(503);
            expect(generation.readyState).toEqual({
                gatewaySocketOpen: true,
                leaseActive: true,
                readiness: true,
                sseConnectionCount: 1,
            });
            expect(generation.sseConnectionCountWhileDraining).toBe(1);
            expect(generation.sseClosedCleanly).toBe(true);
            expect(generation.exitCode).toBe(0);
            expect(generation.readyStatus.grandchildPid).toBeNumber();
            expect(generation.processGroupMembersWhileReady).toContain(
                generation.readyStatus.pid
            );
            expect(generation.processGroupMembersWhileReady).toContain(
                generation.readyStatus.grandchildPid!
            );
            expect(generation.processGroupMembersAfterExit).toEqual([]);
            expect(generation.stoppedStatus.gatewaySocketOpen).toBe(false);
            expect(generation.stoppedStatus.leaseActive).toBe(false);
            expect(generation.stoppedStatus.readiness).toBe(false);
            expect(generation.stoppedStatus.sseConnectionCount).toBe(0);

            const events = generation.stoppedStatus.events;
            const readinessDownIndex = events.indexOf("readiness-down");
            expect(readinessDownIndex).toBeGreaterThan(
                events.indexOf("shutdown-requested")
            );
            const listenerStopEvents = events.filter(
                (event) =>
                    event === "listener-drained" || event === "listener-force-stopped"
            );
            expect(listenerStopEvents).toHaveLength(1);
            const listenerStopIndex = events.indexOf(listenerStopEvents[0]!);
            expect(listenerStopIndex).toBeGreaterThan(readinessDownIndex);
            expect(events.indexOf("sse-server-closed")).toBeGreaterThan(
                listenerStopIndex
            );
            for (const cleanupEvent of [
                "sse-server-closed",
                "gateway-socket-closed",
                "gateway-fixture-closed",
                "child-process-reaped",
                "statement-finalized",
                "worker-lease-released",
                "database-checkpointed",
                "database-closed",
                "stopped",
            ] as const) {
                expect(events.indexOf(cleanupEvent)).toBeGreaterThan(readinessDownIndex);
            }
        }
    }, 60_000);

    test("interrupts the owner scope without leaking its detached process group", async () => {
        const report = await Effect.runPromise(interruptedShutdownScenario);

        expect(report.stoppedStatus.grandchildPid).toBeNumber();
        expect(report.processGroupMembersWhileReady).toContain(report.stoppedStatus.pid);
        expect(report.processGroupMembersWhileReady).toContain(
            report.stoppedStatus.grandchildPid!
        );
        expect(report.processGroupMembersAfterInterruption).toEqual([]);
        expect(report.stoppedStatus.phase).toBe("stopped");
        expect(report.stoppedStatus.events).toContain("readiness-down");
        expect(report.stoppedStatus.events.at(-1)).toBe("stopped");
    }, 30_000);
});
