import { describe, expect, spyOn, test } from "bun:test";

import { createFixedOpenClawGatewayLifecycle } from "./gatewayLifecycle.ts";

describe("fixed OpenClaw Gateway lifecycle", () => {
    test("executes only the reviewed argv with a secret-free environment", async () => {
        const calls: unknown[] = [];
        const lifecycle = createFixedOpenClawGatewayLifecycle({
            openClawRoot: "/home/dashboard/.openclaw",
            process: {
                run(argv, environment, signal) {
                    calls.push({ argv, environment, signal });
                    return Promise.resolve(0);
                },
            },
        });

        await lifecycle.restart();

        if (typeof process.getuid !== "function") {
            throw new TypeError("Gateway lifecycle test requires a POSIX runtime");
        }
        const runtimeDirectory = `/run/user/${process.getuid()}`;
        expect(calls).toEqual([
            {
                argv: ["/home/dashboard/.local/bin/openclaw", "gateway", "restart"],
                environment: {
                    DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDirectory}/bus`,
                    HOME: "/home/dashboard",
                    LANG: "C",
                    LC_ALL: "C",
                    OPENCLAW_NO_RESPAWN: "1",
                    PATH: "/usr/local/bin:/usr/bin:/bin",
                    XDG_RUNTIME_DIR: runtimeDirectory,
                },
                signal: expect.any(AbortSignal),
            },
        ]);
    });

    test("sanitizes caller aborts propagated into the fixed process", async () => {
        const controller = new AbortController();
        const privateReason = new Error("private caller abort detail");
        controller.abort(privateReason);
        let observedSignal: AbortSignal | undefined;
        const lifecycle = createFixedOpenClawGatewayLifecycle({
            openClawRoot: "/home/dashboard/.openclaw",
            process: {
                run: (_argv, _environment, signal) => {
                    observedSignal = signal;
                    signal.throwIfAborted();
                    return Promise.resolve(0);
                },
            },
        });

        const failure = await lifecycle
            .restart(controller.signal)
            .catch((error: unknown) => error);

        expect(observedSignal?.aborted).toBeTrue();
        expect(observedSignal?.reason).toBe(privateReason);
        expect(failure).toMatchObject({
            cause: privateReason,
            message: "OpenClaw Gateway restart process failed",
        });
        expect(String(failure)).not.toContain("private caller abort detail");
    });

    test("enforces and sanitizes the fixed restart deadline without sleeping", async () => {
        const deadline = new AbortController();
        const privateReason = new Error("private timeout detail");
        const timeout = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);

        try {
            const lifecycle = createFixedOpenClawGatewayLifecycle({
                openClawRoot: "/home/dashboard/.openclaw",
                process: {
                    run: (_argv, _environment, signal) => {
                        deadline.abort(privateReason);
                        signal.throwIfAborted();
                        return Promise.resolve(0);
                    },
                },
                timeoutMs: 1000,
            });

            const failure = await lifecycle.restart().catch((error: unknown) => error);

            expect(timeout.mock.calls).toEqual([[1000]]);
            expect(failure).toMatchObject({
                cause: privateReason,
                message: "OpenClaw Gateway restart process failed",
            });
            expect(String(failure)).not.toContain("private timeout detail");
        } finally {
            timeout.mockRestore();
        }
    });

    test("sanitizes thrown process failures", async () => {
        const processFailure = new Error(
            "spawn /home/dashboard/.local/bin/openclaw EACCES"
        );
        const lifecycle = createFixedOpenClawGatewayLifecycle({
            openClawRoot: "/home/dashboard/.openclaw",
            process: {
                run: () => Promise.reject(processFailure),
            },
        });

        const failure = await lifecycle.restart().catch((error: unknown) => error);

        expect(failure).toMatchObject({
            cause: processFailure,
            message: "OpenClaw Gateway restart process failed",
        });
        expect(String(failure)).not.toContain("/home/dashboard");
        expect(String(failure)).not.toContain("EACCES");
    });

    test("sanitizes nonzero exits and rejects non-Linux-style roots", async () => {
        const lifecycle = createFixedOpenClawGatewayLifecycle({
            openClawRoot: "/home/dashboard/.openclaw",
            process: {
                run: () => Promise.resolve(1),
            },
        });
        const failure = await lifecycle.restart().catch((error: unknown) => error);
        expect(failure).toEqual(new Error("OpenClaw Gateway restart process failed"));
        expect(failure).not.toHaveProperty("cause");
        expect(String(failure)).not.toContain("/home/dashboard");

        expect(() =>
            createFixedOpenClawGatewayLifecycle({ openClawRoot: "relative" })
        ).toThrow("lifecycle root is invalid");
    });
});
