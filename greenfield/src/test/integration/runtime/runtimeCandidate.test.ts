import { describe, expect, test } from "bun:test";

import { bunRuntimePolicy, readRuntimeIdentity } from "./runtimeCandidate.ts";

describe("Bun runtime candidate", () => {
    test("executes on the repository's Bun 1.4 canary channel", async () => {
        const selectedChannel = await Bun.file(
            new URL("../../../../.bun-version", import.meta.url)
        ).text();
        expect(selectedChannel.trim()).toBe(bunRuntimePolicy.channel);
        expect(readRuntimeIdentity()).toMatchObject({
            hasGlobalEventSource: false,
            version: bunRuntimePolicy.version,
        });
        expect(Bun.revision).toMatch(/^[a-f\d]{40}$/u);
    });
});
