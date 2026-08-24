/* oxlint-disable typescript/require-await -- Async test doubles mirror production promise ports. */
import { describe, expect, test } from "bun:test";

import {
    type OpenClawTaskProvider,
    OpenClawTaskProviderNotFoundError,
    OpenClawTaskProviderUnknownOutcomeError,
    OpenClawTaskProviderUnavailableError,
} from "./provider.ts";
import type { OpenClawTasksRealtimePublisher } from "./realtime.ts";
import { createOpenClawTasksService, OpenClawTasksServiceError } from "./service.ts";

function provider(overrides: Partial<OpenClawTaskProvider>): OpenClawTaskProvider {
    return {
        cancel: async () => ({ cancelled: false, found: false }),
        get: async () => ({
            task: {
                createdAtMs: 1000,
                id: "task-1",
                startedAtMs: 1100,
                status: "running",
                taskId: "task-1",
                updatedAtMs: 1200,
            },
        }),
        list: async () => ({ tasks: [] }),
        subscribeTasks: async () => ({
            close: async () => {},
            done: Promise.resolve(),
        }),
        ...overrides,
    };
}

function realtimePublisher(
    publishSnapshotRequired: OpenClawTasksRealtimePublisher["publishSnapshotRequired"] = async () => {}
): OpenClawTasksRealtimePublisher {
    return { publishSnapshotRequired };
}

async function failureOf(operation: () => Promise<unknown>): Promise<unknown> {
    try {
        await operation();
        return new Error("Expected rejection");
    } catch (error) {
        return error;
    }
}

describe("OpenClaw tasks service", () => {
    test("rejects a contradictory provider cancellation result", async () => {
        const service = createOpenClawTasksService(
            provider({
                cancel: async () => ({ cancelled: true, found: false }),
            }),
            realtimePublisher()
        );

        const error = await failureOf(() => service.cancel({ taskId: "task-1" }));
        expect(error).toBeInstanceOf(OpenClawTasksServiceError);
        expect((error as OpenClawTasksServiceError).reason).toBe("provider-data-invalid");
    });

    test("rejects malformed task lifecycle data returned by the provider", async () => {
        const service = createOpenClawTasksService(
            provider({
                list: async () =>
                    ({
                        tasks: [
                            {
                                createdAtMs: 2000,
                                endedAtMs: 1500,
                                id: "task-1",
                                status: "completed",
                                updatedAtMs: 2100,
                            },
                        ],
                    }) as never,
            }),
            realtimePublisher()
        );

        const error = await failureOf(() => service.list({ limit: 100 }));
        expect(error).toBeInstanceOf(OpenClawTasksServiceError);
        expect((error as OpenClawTasksServiceError).reason).toBe("provider-data-invalid");
    });

    test("durably invalidates before forwarding a validated provider event", async () => {
        let providerListener:
            | ((
                  event: Parameters<
                      Parameters<OpenClawTaskProvider["subscribeTasks"]>[0]
                  >[0]
              ) => void | Promise<void>)
            | undefined;
        const order: string[] = [];
        const publishedArguments: (Date | undefined)[] = [];
        const service = createOpenClawTasksService(
            provider({
                subscribeTasks: async (listener) => {
                    providerListener = listener;
                    return { close: async () => {}, done: Promise.resolve() };
                },
            }),
            realtimePublisher(async (at) => {
                publishedArguments.push(at);
                order.push("published");
            })
        );
        await service.subscribe(() => {
            order.push("listener");
        });

        await providerListener?.({
            kind: "upserted",
            task: {
                createdAtMs: 1000,
                id: "task-1",
                startedAtMs: 1100,
                status: "running",
                taskId: "task-1",
                updatedAtMs: 1200,
            },
        });

        expect(order).toEqual(["published", "listener"]);
        expect(publishedArguments).toEqual([undefined]);
    });

    test("rejects malformed provider events before writing an invalidation", async () => {
        let providerListener: ((event: never) => void | Promise<void>) | undefined;
        let publishes = 0;
        const service = createOpenClawTasksService(
            provider({
                subscribeTasks: async (listener) => {
                    providerListener = listener;
                    return { close: async () => {}, done: Promise.resolve() };
                },
            }),
            realtimePublisher(async () => {
                publishes += 1;
            })
        );
        await service.subscribe(() => {});

        const error = await failureOf(async () =>
            providerListener?.({ kind: "deleted", taskId: "" } as never)
        );
        expect(error).toBeInstanceOf(OpenClawTasksServiceError);
        expect((error as OpenClawTasksServiceError).reason).toBe("provider-data-invalid");
        expect(publishes).toBe(0);
    });

    test("publishes confirmed and unknown cancellation invalidations without changing results", async () => {
        let publishes = 0;
        const failures: unknown[] = [];
        const confirmed = createOpenClawTasksService(
            provider({
                cancel: async () => ({
                    cancelled: false,
                    found: true,
                    task: {
                        createdAtMs: 1000,
                        id: "task-1",
                        startedAtMs: 1100,
                        status: "running",
                        updatedAtMs: 1200,
                    },
                }),
            }),
            realtimePublisher(async () => {
                publishes += 1;
                throw new Error("pump bridge unavailable");
            }),
            (error) => failures.push(error)
        );

        expect(await confirmed.cancel({ taskId: "task-1" })).toMatchObject({
            cancelled: false,
            found: true,
        });
        expect(publishes).toBe(1);
        expect(failures).toHaveLength(1);

        const unknown = createOpenClawTasksService(
            provider({
                cancel: async () => {
                    throw new OpenClawTaskProviderUnknownOutcomeError();
                },
            }),
            realtimePublisher(async () => {
                publishes += 1;
            })
        );
        const error = await failureOf(() => unknown.cancel({ taskId: "task-1" }));
        expect(error).toBeInstanceOf(OpenClawTasksServiceError);
        expect((error as OpenClawTasksServiceError).reason).toBe("unknown-outcome");
        expect(publishes).toBe(2);
    });

    test("publishes every post-dispatch unknown cancellation outcome", async () => {
        let publishes = 0;
        let attempts = 0;
        const service = createOpenClawTasksService(
            provider({
                cancel: async () => {
                    attempts += 1;
                    throw new OpenClawTaskProviderUnknownOutcomeError();
                },
            }),
            realtimePublisher(async () => {
                publishes += 1;
            })
        );

        for (const taskId of ["lifecycle-invalid", "prompt-leaking", "final-invalid"]) {
            const error = await failureOf(() => service.cancel({ taskId }));
            expect(error).toBeInstanceOf(OpenClawTasksServiceError);
            expect((error as OpenClawTasksServiceError).reason).toBe("unknown-outcome");
        }
        expect(attempts).toBe(3);
        expect(publishes).toBe(3);
    });

    test("does not publish a definitive pre-dispatch cancellation failure", async () => {
        let publishes = 0;
        const service = createOpenClawTasksService(
            provider({
                cancel: async () => {
                    throw new OpenClawTaskProviderUnavailableError();
                },
            }),
            realtimePublisher(async () => {
                publishes += 1;
            })
        );

        const error = await failureOf(() => service.cancel({ taskId: "task-1" }));
        expect(error).toBeInstanceOf(OpenClawTasksServiceError);
        expect((error as OpenClawTasksServiceError).reason).toBe("provider-unavailable");
        expect(publishes).toBe(0);
    });

    test("normalizes provider not-found cancellation to an idempotent absent result", async () => {
        let publishes = 0;
        const service = createOpenClawTasksService(
            provider({
                cancel: async () => {
                    throw new OpenClawTaskProviderNotFoundError();
                },
            }),
            realtimePublisher(async () => {
                publishes += 1;
            })
        );

        expect(await service.cancel({ taskId: "missing-task" })).toEqual({
            cancelled: false,
            found: false,
        });
        expect(publishes).toBe(0);
    });
});
