import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { acquireDevelopmentTailscaleRouteLock } from "./developmentTailscaleLock.ts";

test("serializes one host-local Tailscale port independently of state roots", async () => {
    const runtimeDirectory = await mkdtemp(
        path.join(tmpdir(), "mira-dashboard-development-tailscale-lock-")
    );
    const dependencies = {
        runtimeDirectory: () => Promise.resolve(runtimeDirectory),
    };
    const port = 40_000 + (process.pid % 20_000);
    try {
        const first = await acquireDevelopmentTailscaleRouteLock(port, dependencies);
        try {
            const failure = await acquireDevelopmentTailscaleRouteLock(
                port,
                dependencies
            ).then(
                () => null,
                (error: unknown) => error
            );
            expect(failure).toBeInstanceOf(Error);
            if (!(failure instanceof Error))
                throw new Error("Expected route lock conflict");
            expect(failure.message).toContain("already in use");
        } finally {
            await Promise.all([first.release(), first.release()]);
        }

        const next = await acquireDevelopmentTailscaleRouteLock(port, dependencies);
        await next.release();
    } finally {
        await rm(runtimeDirectory, { force: true, recursive: true });
    }
});
