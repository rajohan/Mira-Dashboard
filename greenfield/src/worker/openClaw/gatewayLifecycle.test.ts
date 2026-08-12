import { describe, expect, test } from "bun:test";

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

        expect(calls).toMatchObject([
            {
                argv: ["/home/dashboard/.local/bin/openclaw", "gateway", "restart"],
                environment: {
                    HOME: "/home/dashboard",
                    OPENCLAW_NO_RESPAWN: "1",
                    PATH: "/usr/local/bin:/usr/bin:/bin",
                },
                signal: expect.any(AbortSignal),
            },
        ]);
        const environment = (calls[0] as { environment: Record<string, string> })
            .environment;
        expect(Object.keys(environment)).not.toContain("OPENCLAW_GATEWAY_TOKEN");
        expect(Object.keys(environment)).not.toContain("MOLTBOOK_API_KEY");
    });

    test("sanitizes process failures and rejects non-Linux-style roots", async () => {
        const lifecycle = createFixedOpenClawGatewayLifecycle({
            openClawRoot: "/home/dashboard/.openclaw",
            process: {
                run: () => Promise.resolve(1),
            },
        });
        const failure = await lifecycle.restart().catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).not.toContain("/home/dashboard");

        expect(() =>
            createFixedOpenClawGatewayLifecycle({ openClawRoot: "relative" })
        ).toThrow("lifecycle root is invalid");
    });
});
