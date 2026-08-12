import { describe, expect, test } from "bun:test";

import type { JobRunRecord } from "../jobs/records.ts";
import type {
    EnqueueManualRunInput,
    EnqueueManualRunResult,
} from "../jobs/repository.ts";
import {
    createOpenClawGatewayRestartQueue,
    OpenClawGatewayRestartQueueError,
    type OpenClawGatewayRestartQueueDependencies,
} from "./restartQueue.ts";

const actor = Object.freeze({
    authenticatorId: "019fdf50-0000-7000-8000-000000000010",
    id: "019fdf50-0000-7000-8000-000000000011",
    kind: "user" as const,
});
const idempotencyKey = "019fdf50-0000-4000-8000-000000000012";

function repositoryFixture() {
    const enqueues: EnqueueManualRunInput[] = [];
    let stored: JobRunRecord | undefined;
    const repository: OpenClawGatewayRestartQueueDependencies["repository"] = {
        enqueueManualRun(input): Promise<EnqueueManualRunResult> {
            enqueues.push(input);
            stored = {
                ...input.run,
                attemptCount: 0,
                eventBytes: 0,
                eventCount: 1,
                payloadEventCount: 0,
                stateVersion: 1,
            };
            return Promise.resolve({ kind: "inserted", run: stored });
        },
        findRun(id) {
            return stored?.id === id ? stored : undefined;
        },
        findRunByIdempotency(requestedByKind, requestedById, observedKey) {
            return stored?.requestedByKind === requestedByKind &&
                stored.requestedById === requestedById &&
                stored.idempotencyKey === observedKey
                ? stored
                : undefined;
        },
    };
    return {
        complete() {
            if (stored === undefined) throw new Error("Run was not queued");
            stored = {
                ...stored,
                finishedAt: new Date(1001),
                resultJson: JSON.stringify({
                    completedAtMs: 1001,
                    status: "restarted",
                }),
                state: "succeeded",
                stateVersion: stored.stateVersion + 1,
                updatedAt: new Date(1001),
            };
        },
        enqueues,
        repository,
        run: () => stored,
    };
}

function request(authorizeDispatch: () => Promise<void>, signal?: AbortSignal) {
    return {
        actor,
        authorizeDispatch,
        idempotencyKey,
        requestId: "request-1",
        ...(signal === undefined ? {} : { signal }),
    };
}

describe("OpenClaw Gateway restart queue", () => {
    test("persists one exclusive run, ignores cancellation after commit, and reconciles replay", async () => {
        const fixture = repositoryFixture();
        const ids = [
            "019fdf50-0000-7000-8000-000000000020",
            "019fdf50-0000-7000-8000-000000000021",
        ];
        const controller = new AbortController();
        let authorizationChecks = 0;
        const originalEnqueue = fixture.repository.enqueueManualRun;
        fixture.repository.enqueueManualRun = async (input) => {
            const result = await originalEnqueue(input);
            controller.abort();
            fixture.complete();
            return result;
        };
        const queue = createOpenClawGatewayRestartQueue({
            generateId: () => ids.shift()!,
            nowMs: () => 1000,
            repository: fixture.repository,
        });

        const first = await queue.restart(
            request(() => {
                authorizationChecks += 1;
                return Promise.resolve();
            }, controller.signal)
        );
        const replay = await queue.restart(
            request(() => {
                authorizationChecks += 1;
                return Promise.resolve();
            })
        );

        expect(first).toEqual({
            completedAtMs: 1001,
            jobRunId: "019fdf50-0000-7000-8000-000000000020",
            status: "restarted",
        });
        expect(replay).toEqual(first);
        expect(authorizationChecks).toBe(1);
        expect(fixture.enqueues).toHaveLength(1);
        expect(fixture.enqueues[0]?.run).toMatchObject({
            actionKey: "openclaw.gateway.restart",
            attemptLimit: 1,
            cancellationPolicy: "never",
            idempotencyKey,
            resourceClass: "exclusive",
            retrySafe: false,
        });
        expect(fixture.enqueues[0]?.run.payloadJson).toBe("{}");
        expect(fixture.enqueues[0]?.auditEvents).toMatchObject([
            {
                action: "openclaw.settings.restart.enqueue",
                actorId: actor.id,
                authenticatorId: actor.authenticatorId,
                outcome: "accepted",
            },
        ]);
    });

    test("times out confirmation without cancelling or re-enqueueing the durable run", async () => {
        const fixture = repositoryFixture();
        let monotonic = 0;
        const ids = [
            "019fdf50-0000-7000-8000-000000000030",
            "019fdf50-0000-7000-8000-000000000031",
        ];
        const queue = createOpenClawGatewayRestartQueue({
            confirmationTimeoutMs: 10,
            delay: (milliseconds) => {
                monotonic += milliseconds;
                return Promise.resolve();
            },
            generateId: () => ids.shift()!,
            monotonicNowMs: () => monotonic,
            nowMs: () => 1000,
            pollIntervalMs: 5,
            repository: fixture.repository,
        });

        const failure = await queue
            .restart(request(async () => {}))
            .catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(OpenClawGatewayRestartQueueError);
        expect(failure).toMatchObject({ reason: "unknown-outcome" });
        expect(fixture.enqueues).toHaveLength(1);
        expect(fixture.run()).toMatchObject({ state: "queued" });

        fixture.complete();
        expect(await queue.restart(request(async () => {}))).toMatchObject({
            jobRunId: "019fdf50-0000-7000-8000-000000000030",
            status: "restarted",
        });
        expect(fixture.enqueues).toHaveLength(1);
    });
});
