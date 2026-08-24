import { describe, expect, test } from "bun:test";

import { revealIssuedAutomationToken } from "./issuedAutomationToken.ts";

describe("issued automation token", () => {
    test("reveals the one-time token before awaiting cache refresh", async () => {
        const refresh = Promise.withResolvers<void>();
        const sequence: string[] = [];
        const completion = revealIssuedAutomationToken(
            "one-time-token",
            (token) => sequence.push(`reveal:${token}`),
            async () => {
                sequence.push("refresh:start");
                await refresh.promise;
                sequence.push("refresh:complete");
            }
        );

        expect(sequence).toEqual(["reveal:one-time-token", "refresh:start"]);
        refresh.resolve();
        await completion;
        expect(sequence).toEqual([
            "reveal:one-time-token",
            "refresh:start",
            "refresh:complete",
        ]);
    });
});
