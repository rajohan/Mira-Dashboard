import { describe, expect, test } from "bun:test";

import {
    OpenClawTaskProviderNotFoundError,
    OpenClawTaskProviderUnknownOutcomeError,
    OpenClawTaskProviderUnavailableError,
} from "../../domains/openClawTasks/provider.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createPersistentGatewayOpenClawTasksProvider,
    type PersistentGatewayOpenClawTasksTransport,
} from "./persistentGatewayOpenClawTasksProvider.ts";
import {
    persistentGatewayTaskNotFoundReason,
    PersistentGatewayRequestError,
    type PersistentGatewayListener,
} from "./persistentGatewayTransport.ts";

interface RecordedRequest {
    readonly method: string;
    readonly parameters: Readonly<Record<string, unknown>>;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
    return Array.isArray(value);
}

function createHarness(responses: Readonly<Record<string, unknown>>) {
    const requests: RecordedRequest[] = [];
    const queues = new Map(
        Object.entries(responses).map(([method, response]) => [
            method,
            isUnknownArray(response) ? [...response] : [response],
        ])
    );
    let listener: PersistentGatewayListener | undefined;
    const request = (
        method: string,
        parameters: Readonly<Record<string, unknown>>
    ): Promise<unknown> => {
        requests.push({ method, parameters });
        const queue = queues.get(method);
        if (queue === undefined || queue.length === 0) {
            return Promise.reject(
                new Error(`Missing task fixture response for ${method}`)
            );
        }
        const response = queue.shift();
        return response instanceof Error
            ? Promise.reject(response)
            : Promise.resolve(response);
    };
    const transport = {
        requestTaskRead: request,
        requestTaskWrite: request,
        subscribe: (next: PersistentGatewayListener) => {
            listener = next;
            return () => {
                if (listener === next) listener = undefined;
            };
        },
    } as PersistentGatewayOpenClawTasksTransport;
    return {
        emitEvent: (event: "cron" | "sessions.changed" | "task") =>
            listener?.onEvent?.({
                connectionGeneration: 1,
                frame: { event, type: "event" },
                receivedAtMs: 1000,
            }),
        emitGap: () =>
            listener?.onEventGap?.({
                connectionGeneration: 1,
                expectedSequence: 2,
                receivedSequence: 4,
            }),
        emitState: (phase: "connected" | "degraded", generation: number) =>
            listener?.onState?.({
                connectionGeneration: generation,
                phase,
                reconnectAttempt: 0,
            }),
        hasListener: () => listener !== undefined,
        provider: createPersistentGatewayOpenClawTasksProvider(transport),
        requests,
    };
}

describe("persistent Gateway OpenClaw tasks provider", () => {
    test("maps bounded list filters, cursor, status, and prompt-free summaries", async () => {
        const harness = createHarness({
            "tasks.list": {
                nextCursor: "12",
                tasks: [
                    {
                        createdAt: 1000,
                        id: "task-running",
                        ownerKey: "",
                        sessionKey: "",
                        startedAt: 1100,
                        status: "running",
                        taskId: "task-running",
                        updatedAt: 1200,
                    },
                    {
                        createdAt: "1970-01-01T00:00:02.000Z",
                        endedAt: 2400,
                        id: "task-failed",
                        status: "failed",
                        terminalSummary: "Worker was lost",
                        updatedAt: 2400,
                    },
                ],
            },
        });

        const page = await harness.provider.list({
            cursor: "10",
            limit: 2,
            statuses: ["running", "failed"],
        });

        expect(harness.requests).toEqual([
            {
                method: "tasks.list",
                parameters: {
                    cursor: "10",
                    limit: 2,
                    status: ["running", "failed"],
                },
            },
        ]);
        expect(page).toEqual({
            nextCursor: "12",
            tasks: [
                {
                    createdAtMs: 1000,
                    id: "task-running",
                    startedAtMs: 1100,
                    status: "running",
                    taskId: "task-running",
                    updatedAtMs: 1200,
                },
                {
                    createdAtMs: 2000,
                    endedAtMs: 2400,
                    id: "task-failed",
                    status: "failed",
                    terminalSummary: "Worker was lost",
                    updatedAtMs: 2400,
                },
            ],
        });
        expect(JSON.stringify(page)).not.toContain("prompt");
    });

    test("allows a bounded prompt only on get and maps audited not-found errors", async () => {
        const notFound = new PersistentGatewayRequestError({
            code: "INVALID_REQUEST",
            reason: persistentGatewayTaskNotFoundReason,
        });
        const harness = createHarness({
            "tasks.get": [
                {
                    task: {
                        createdAt: 1000,
                        id: "task-1",
                        ownerKey: "",
                        prompt: "Inspect the deployment",
                        sessionKey: "",
                        startedAt: 1100,
                        status: "running",
                        taskId: "task-1",
                        updatedAt: 1200,
                    },
                },
                notFound,
            ],
        });

        expect(await harness.provider.get({ taskId: "task-1" })).toEqual({
            task: {
                createdAtMs: 1000,
                id: "task-1",
                prompt: "Inspect the deployment",
                startedAtMs: 1100,
                status: "running",
                taskId: "task-1",
                updatedAtMs: 1200,
            },
        });
        expect(
            await captureFailure(() => harness.provider.get({ taskId: "task-1" }))
        ).toBeInstanceOf(OpenClawTaskProviderNotFoundError);
    });

    test("rejects malformed cancellation acknowledgements and list prompt leakage", async () => {
        const harness = createHarness({
            "tasks.cancel": { cancelled: true, found: false },
            "tasks.list": {
                tasks: [
                    {
                        id: "task-1",
                        prompt: "must stay detail-only",
                        status: "running",
                    },
                ],
            },
        });

        expect(
            await captureFailure(() => harness.provider.cancel({ taskId: "task-1" }))
        ).toBeInstanceOf(OpenClawTaskProviderUnknownOutcomeError);
        expect(
            await captureFailure(() => harness.provider.list({ limit: 1 }))
        ).toBeInstanceOf(OpenClawTaskProviderUnavailableError);
    });

    test("classifies every post-dispatch cancellation projection defect as unknown", async () => {
        for (const task of [
            {
                createdAt: 2000,
                endedAt: 1500,
                id: "task-1",
                status: "completed",
            },
            {
                id: "task-1",
                prompt: "must stay detail-only",
                status: "running",
            },
            {
                id: "task-1",
                status: "running",
                taskId: "different-task",
            },
        ] as const) {
            const harness = createHarness({
                "tasks.cancel": {
                    cancelled: true,
                    found: true,
                    task,
                },
            });

            expect(
                await captureFailure(() => harness.provider.cancel({ taskId: "task-1" }))
            ).toBeInstanceOf(OpenClawTaskProviderUnknownOutcomeError);
            expect(harness.requests).toEqual([
                {
                    method: "tasks.cancel",
                    parameters: { taskId: "task-1" },
                },
            ]);
        }
    });

    test("keeps canonical cancel absence successful and rejects request-level not-found", async () => {
        const notFound = new PersistentGatewayRequestError({
            code: "INVALID_REQUEST",
            reason: persistentGatewayTaskNotFoundReason,
        });
        const harness = createHarness({
            "tasks.cancel": [
                {
                    cancelled: false,
                    found: false,
                    reason: "Task was not found",
                },
                notFound,
            ],
        });

        expect(await harness.provider.cancel({ taskId: "missing-task" })).toEqual({
            cancelled: false,
            found: false,
            reason: "Task was not found",
        });
        expect(
            await captureFailure(() =>
                harness.provider.cancel({ taskId: "missing-task" })
            )
        ).toBeInstanceOf(OpenClawTaskProviderUnavailableError);
    });

    test("coalesces task payloads, gaps, and reconnects into payload-free restored events", async () => {
        const harness = createHarness({});
        const gate = Promise.withResolvers<void>();
        const observed: unknown[] = [];
        const subscription = await harness.provider.subscribeTasks(async (event) => {
            observed.push(event);
            await gate.promise;
        });

        harness.emitState("connected", 1);
        await Promise.resolve();
        expect(observed).toEqual([{ kind: "restored" }]);
        harness.emitEvent("task");
        harness.emitEvent("task");
        harness.emitEvent("cron");
        harness.emitGap();
        harness.emitState("degraded", 1);
        harness.emitState("connected", 2);

        gate.resolve();
        for (let index = 0; index < 8; index += 1) await Promise.resolve();
        expect(observed).toEqual([{ kind: "restored" }, { kind: "restored" }]);
        expect(JSON.stringify(observed)).not.toContain("taskId");
        await subscription.close();
        expect(await subscription.done).toBeUndefined();
    });

    test("rejects done and unsubscribes when the durable bridge listener fails", async () => {
        const harness = createHarness({});
        const subscription = await harness.provider.subscribeTasks(() =>
            Promise.reject(new Error("durable outbox unavailable"))
        );

        harness.emitState("connected", 1);
        expect(await captureFailure(() => subscription.done)).toBeInstanceOf(
            OpenClawTaskProviderUnavailableError
        );
        expect(harness.hasListener()).toBe(false);
        await subscription.close();
    });
});
