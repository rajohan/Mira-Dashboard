import { describe, expect, test } from "bun:test";

import { readRuntimeIdentity, runtimeCandidate } from "./runtimeCandidate.ts";

describe("Bun runtime candidate", () => {
    test("executes on the exact qualified revision", () => {
        expect(readRuntimeIdentity()).toEqual({
            hasGlobalEventSource: false,
            revision: runtimeCandidate.revision,
            version: runtimeCandidate.version,
        });
    });
});
