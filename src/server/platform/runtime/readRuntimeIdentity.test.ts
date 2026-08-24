import { describe, expect, test } from "bun:test";

import { createBunRuntimePolicy } from "../../../shared/bunRuntimePolicy.ts";
import { readRuntimeIdentity } from "./readRuntimeIdentity.ts";

const bunRuntimePolicy = createBunRuntimePolicy("1.4.0");

describe("runtime identity validation", () => {
    test("returns a validated Bun runtime identity", () => {
        const revision = "a".repeat(40);

        expect(
            readRuntimeIdentity({ revision, version: bunRuntimePolicy.version })
        ).toEqual({
            revision,
            version: bunRuntimePolicy.version,
            versionWithRevision: `${bunRuntimePolicy.version}+${"a".repeat(9)}`,
        });
    });

    test("preserves the runtime-version error before revision validation", () => {
        expect(() =>
            readRuntimeIdentity(
                { revision: "invalid", version: "1.3.0" },
                bunRuntimePolicy.version
            )
        ).toThrow(`Serving Bun runtime must be ${bunRuntimePolicy.version}`);
    });

    test("rejects a malformed Bun revision with the operational error", () => {
        expect(() =>
            readRuntimeIdentity({
                revision: "A".repeat(40),
                version: bunRuntimePolicy.version,
            })
        ).toThrow("Serving Bun runtime revision is malformed");
    });
});
