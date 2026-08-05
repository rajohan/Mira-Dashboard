import { describe, expect, spyOn, test } from "bun:test";

import { secondsToMilliseconds } from "date-fns";

import { createServer } from "../../../app/server.ts";
import { createReadinessController } from "../../platform/readiness/readinessState.ts";
import { createTestApplicationRuntime } from "../support/requestContext.ts";

async function captureFailure(work: () => Promise<unknown>): Promise<unknown> {
    try {
        await work();
    } catch (error) {
        return error;
    }
    throw new Error("Expected server startup to fail");
}

function createPendingBunServer(): {
    readonly server: ReturnType<typeof Bun.serve>;
    readonly stopCalls: boolean[];
} {
    const gracefulStop = Promise.withResolvers<void>();
    const stopCalls: boolean[] = [];
    const server = {
        port: 3100,
        stop(force = false) {
            stopCalls.push(force);
            if (force) gracefulStop.resolve();
            return gracefulStop.promise;
        },
        url: new URL("http://127.0.0.1:3100"),
    } as unknown as ReturnType<typeof Bun.serve>;
    return { server, stopCalls };
}

describe("application server shutdown", () => {
    test.each([
        {
            forceAfterGracefulStart: false,
            timeoutMs: 1,
            trigger: "bounded deadline",
        },
        {
            forceAfterGracefulStart: true,
            timeoutMs: secondsToMilliseconds(30),
            trigger: "explicit force escalation",
        },
    ])("forces a pending graceful stop after $trigger", async (scenario) => {
        const fake = createPendingBunServer();
        const serveSpy = spyOn(Bun, "serve").mockReturnValue(fake.server);
        let disposals = 0;

        try {
            const server = await createServer({
                applicationRuntime: createTestApplicationRuntime({
                    dispose: () => {
                        disposals += 1;
                        return Promise.resolve();
                    },
                }),
                authenticateRequest: () => ({ kind: "anonymous" }),
                gracefulShutdownTimeoutMs: scenario.timeoutMs,
                port: 3100,
                readiness: createReadinessController(),
            });
            const gracefulStop = server.stop();
            if (scenario.forceAfterGracefulStart) {
                expect(server.stop(true)).toBe(gracefulStop);
            }

            await gracefulStop;

            expect(fake.stopCalls).toEqual([false, true]);
            expect(disposals).toBe(1);
        } finally {
            serveSpy.mockRestore();
        }
    });

    test("preserves a startup failure when runtime disposal also fails", async () => {
        const startupError = new Error("simulated listener startup failure");
        const disposalError = new Error("simulated runtime disposal failure");
        const serveSpy = spyOn(Bun, "serve").mockImplementation(() => {
            throw startupError;
        });
        let disposals = 0;

        try {
            const failure = await captureFailure(() =>
                createServer({
                    applicationRuntime: createTestApplicationRuntime({
                        dispose: () => {
                            disposals += 1;
                            return Promise.reject(disposalError);
                        },
                    }),
                    authenticateRequest: () => ({ kind: "anonymous" }),
                    port: 3100,
                    readiness: createReadinessController(),
                })
            );

            expect(failure).toBe(startupError);
            expect(disposals).toBe(1);
        } finally {
            serveSpy.mockRestore();
        }
    });

    test.each([{ timeoutMs: 0 }, { timeoutMs: secondsToMilliseconds(61) }])(
        "rejects invalid shutdown timeout $timeoutMs before opening the listener",
        async ({ timeoutMs }) => {
            const serveSpy = spyOn(Bun, "serve").mockImplementation(() => {
                throw new Error("Bun.serve must not receive invalid shutdown policy");
            });
            let disposals = 0;
            let initializations = 0;

            try {
                const failure = await captureFailure(() =>
                    createServer({
                        applicationRuntime: createTestApplicationRuntime({
                            dispose: () => {
                                disposals += 1;
                                return Promise.resolve();
                            },
                            initialize: () => {
                                initializations += 1;
                                return Promise.resolve();
                            },
                        }),
                        authenticateRequest: () => ({ kind: "anonymous" }),
                        gracefulShutdownTimeoutMs: timeoutMs,
                        port: 3100,
                        readiness: createReadinessController(),
                    })
                );

                expect(failure).toBeInstanceOf(Error);
                expect(initializations).toBe(0);
                expect(disposals).toBe(1);
                expect(serveSpy).not.toHaveBeenCalled();
            } finally {
                serveSpy.mockRestore();
            }
        }
    );
});
