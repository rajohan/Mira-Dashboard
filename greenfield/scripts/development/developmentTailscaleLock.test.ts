import { expect, test } from "bun:test";

import { acquireDevelopmentTailscaleRouteLock } from "./developmentTailscaleLock.ts";

test("serializes one host-local Tailscale port independently of state roots", async () => {
    const port = 40_000 + (process.pid % 20_000);
    const first = await acquireDevelopmentTailscaleRouteLock(port);
    try {
        const failure = await acquireDevelopmentTailscaleRouteLock(port).then(
            () => null,
            (error: unknown) => error
        );
        expect(failure).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) throw new Error("Expected route lock conflict");
        expect(failure.message).toContain("already in use");
    } finally {
        await Promise.all([first.release(), first.release()]);
    }

    const next = await acquireDevelopmentTailscaleRouteLock(port);
    await next.release();
});
