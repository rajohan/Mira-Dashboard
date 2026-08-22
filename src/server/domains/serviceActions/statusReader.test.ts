import { describe, expect, test } from "bun:test";

import type { JobRunRecord } from "../jobs/records.ts";
import { serviceActionJobActionKeys } from "../jobs/serviceActionQueue.ts";
import { createSqliteServiceActionStatusReader } from "./statusReader.ts";

const expectedReleaseId = "a".repeat(40);
const actorId = "019ff451-7d0d-7880-9fed-67b776ed6631";

function run(id: string, actionKey: string, state: "failed" | "queued"): JobRunRecord {
    const queuedAt = new Date(1000);
    const finishedAt = state === "failed" ? new Date(2000) : null;
    return {
        actionKey,
        attemptCount: state === "failed" ? 1 : 0,
        attemptLimit: 1,
        availableAt: queuedAt,
        cancellationPolicy: "never",
        cancelRequestedAt: null,
        cancelRequestedById: null,
        cancelRequestedByKind: null,
        displayName: "Fixed Service Action",
        enqueueSha256: "b".repeat(64),
        eventBytes: 0,
        eventCount: state === "failed" ? 2 : 1,
        finishedAt,
        firstStartedAt: state === "failed" ? new Date(1500) : null,
        heartbeatAt: null,
        id,
        idempotencyKey: "A".repeat(43),
        lastAttemptStartedAt: state === "failed" ? new Date(1500) : null,
        leaseExpiresAt: null,
        leaseOwnerId: null,
        leaseToken: null,
        payloadEventCount: 0,
        payloadJson: "{}",
        priority: 20,
        queuedAt,
        requestedById: actorId,
        requestedByKind: "user",
        requiredWorkerReleaseId: null,
        resourceClass: "exclusive",
        resourceKeysJson: '["host.mutation"]',
        resultJson: null,
        retrySafe: false,
        scheduledForAt: null,
        scheduledJobId: null,
        scheduledJobVersion: null,
        state,
        stateVersion: state === "failed" ? 3 : 1,
        terminalCode: state === "failed" ? "failed/provider" : null,
        terminalMessage: state === "failed" ? "Service Action failed." : null,
        timeoutMs: 60_000,
        triggerType: "manual",
        updatedAt: finishedAt ?? queuedAt,
    };
}

describe("Service Action status reader", () => {
    test("requires fresh exact-release worker advertisements and projects bounded runs", async () => {
        const availabilityInputs: unknown[] = [];
        const active = run(
            "019ff451-7d0d-7880-9fed-67b776ed6632",
            serviceActionJobActionKeys["system-update"],
            "queued"
        );
        const latest = run(
            "019ff451-7d0d-7880-9fed-67b776ed6633",
            serviceActionJobActionKeys["system-update"],
            "failed"
        );
        const reader = createSqliteServiceActionStatusReader({
            expectedReleaseId,
            nowMs: () => 40_000,
            repository: {
                readActionPayloadRunSnapshots: ({ actionKey, payloadJsons }) => [
                    {
                        ...(actionKey === serviceActionJobActionKeys["system-update"]
                            ? { activeRun: active, lastRun: latest }
                            : {}),
                        payloadJson: payloadJsons[0] ?? "",
                    },
                ],
                readWorkerActionAvailability: (input) => {
                    availabilityInputs.push(input);
                    return Object.freeze([
                        serviceActionJobActionKeys["openclaw-cleanup"],
                        serviceActionJobActionKeys["openclaw-restart"],
                        serviceActionJobActionKeys["system-update"],
                    ]);
                },
            },
        });

        expect(await reader.read()).toEqual([
            { availability: "unavailable", id: "dashboard-restart" },
            { availability: "available", id: "openclaw-cleanup" },
            { availability: "available", id: "openclaw-restart" },
            { availability: "unavailable", id: "openclaw-update" },
            { availability: "unavailable", id: "system-cleanup" },
            { availability: "unavailable", id: "system-restart" },
            {
                activeRun: expect.objectContaining({ id: active.id, state: "queued" }),
                availability: "available",
                id: "system-update",
                latestRun: expect.objectContaining({ id: latest.id, state: "failed" }),
            },
            { availability: "unavailable", id: "worker-restart" },
        ]);
        expect(availabilityInputs).toEqual([
            {
                actionKeys: [
                    "host.dashboard.restart",
                    "openclaw.sessions.cleanup",
                    "openclaw.gateway.restart",
                    "openclaw.installation.update",
                    "host.system.cleanup",
                    "host.system.restart",
                    "host.system.update",
                    "host.worker.restart",
                ],
                expectedReleaseId,
                minimumHeartbeatAt: new Date(10_000),
            },
        ]);
    });

    test("rejects an already-aborted read before persistence", async () => {
        const controller = new AbortController();
        controller.abort(new Error("request closed"));
        const repositoryReads = {
            actionSnapshots: 0,
            workerAvailability: 0,
        };
        const reader = createSqliteServiceActionStatusReader({
            expectedReleaseId,
            repository: {
                readActionPayloadRunSnapshots: () => {
                    repositoryReads.actionSnapshots += 1;
                    return [];
                },
                readWorkerActionAvailability: () => {
                    repositoryReads.workerAvailability += 1;
                    return [];
                },
            },
        });

        let failure: unknown;
        try {
            await reader.read(controller.signal);
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe("request closed");
        expect(repositoryReads).toEqual({
            actionSnapshots: 0,
            workerAvailability: 0,
        });
    });
});
