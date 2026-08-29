import { describe, expect, test } from "bun:test";

import {
    ProductionDeployTemporarilyUnavailableError,
    queueProductionDeploy,
    readBoundedProductionDeployResponse,
} from "./productionDeployClient.ts";

const runId = "018f6f50-6a9e-7b88-8000-000000000002";

function run(state: "running" | "succeeded") {
    const running = state === "running";
    return {
        events: [],
        ...(running ? {} : { result: { operation: "deploy", outcome: "completed" } }),
        run: {
            actionKey: "delivery.production.v1",
            attemptCount: 1,
            attemptLimit: 1,
            availableAtMs: 1000,
            cancellationPolicy: "never" as const,
            displayName: "Delivery production operation",
            eventCount: 0,
            firstStartedAtMs: 1000,
            id: runId,
            lastAttemptStartedAtMs: 1000,
            operationKey: "delivery:deploy",
            priority: 50,
            queuedAtMs: 1000,
            resourceClass: "exclusive" as const,
            resourceKeys: [
                "database",
                "delivery.mutation",
                "delivery.production",
                "github.repository",
                "host.mutation",
            ],
            retrySafe: true,
            state,
            stateVersion: running ? 2 : 3,
            ...(running ? {} : { finishedAtMs: 2000 }),
            timeoutMs: 90 * 60 * 1000,
            triggerType: "manual" as const,
            updatedAtMs: running ? 1000 : 2000,
        },
    };
}

describe("production deploy client", () => {
    test("cancels a streamed response as soon as it exceeds the byte limit", async () => {
        let cancelled = false;
        const response = new Response(
            new ReadableStream<Uint8Array>({
                cancel: () => {
                    cancelled = true;
                },
                start(controller) {
                    controller.enqueue(new Uint8Array(1024 * 1024));
                    controller.enqueue(new Uint8Array([1]));
                },
            })
        );

        const thrownError = await readBoundedProductionDeployResponse(response).catch(
            (error: unknown) => error
        );
        expect(thrownError).toBeInstanceOf(Error);
        expect((thrownError as Error).message).toBe("Production deploy request failed");
        expect(cancelled).toBeTrue();
    });

    test("queues one real Delivery job and waits through the same run detail", async () => {
        const calls: Array<readonly [string, string, unknown]> = [];
        const responses: unknown[] = [
            { jobRunId: runId, operation: "deploy", queued: true },
            run("running"),
            run("succeeded"),
        ];
        await queueProductionDeploy({
            nowMs: () => 1000,
            readToken: () => Promise.resolve("token"),
            request: (_token, kind, procedure, input) => {
                calls.push([kind, procedure, input]);
                return Promise.resolve(responses.shift());
            },
            sleep: () => Promise.resolve(),
        });
        expect(calls.map(([, procedure]) => procedure)).toEqual([
            "delivery.deployCurrent",
            "jobs.getRun",
            "jobs.getRun",
        ]);
        expect(calls[1]?.[2]).toEqual({ id: runId });
    });

    test("returns a failing exit boundary for a failed durable run", () => {
        expect(
            queueProductionDeploy({
                nowMs: () => 1000,
                readToken: () => Promise.resolve("token"),
                request: (_token, kind) =>
                    Promise.resolve(
                        kind === "mutation"
                            ? { jobRunId: runId, operation: "deploy", queued: true }
                            : {
                                  ...run("succeeded"),
                                  run: {
                                      ...run("succeeded").run,
                                      state: "failed",
                                      terminalCode: "action-failed",
                                      terminalMessage: "The job action failed.",
                                  },
                                  result: undefined,
                              }
                    ),
                sleep: () => Promise.resolve(),
            })
        ).rejects.toThrow("Production deploy job failed");
    });

    test("rejects a succeeded job whose deployment outcome is unknown", () => {
        expect(
            queueProductionDeploy({
                nowMs: () => 1000,
                readToken: () => Promise.resolve("token"),
                request: (_token, kind) =>
                    Promise.resolve(
                        kind === "mutation"
                            ? { jobRunId: runId, operation: "deploy", queued: true }
                            : {
                                  ...run("succeeded"),
                                  result: {
                                      operation: "deploy",
                                      outcome: "unknown-outcome",
                                  },
                              }
                    ),
                sleep: () => Promise.resolve(),
            })
        ).rejects.toThrow("Production deploy outcome unknown-outcome");
    });

    test("retries an ambiguous enqueue with the same idempotency key", async () => {
        const enqueueInputs: unknown[] = [];
        let attempt = 0;
        await queueProductionDeploy({
            nowMs: () => 1000,
            readToken: () => Promise.resolve("token"),
            request: (_token, kind, _procedure, input) => {
                if (kind === "query") return Promise.resolve(run("succeeded"));
                enqueueInputs.push(input);
                attempt += 1;
                if (attempt === 1) {
                    return Promise.reject(
                        new ProductionDeployTemporarilyUnavailableError()
                    );
                }
                return Promise.resolve({
                    jobRunId: runId,
                    operation: "deploy",
                    queued: true,
                });
            },
            sleep: () => Promise.resolve(),
        });
        expect(enqueueInputs).toHaveLength(2);
        expect(enqueueInputs[1]).toEqual(enqueueInputs[0]);
    });
});
