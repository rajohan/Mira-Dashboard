import { describe, expect, test } from "bun:test";
import path from "node:path";

import { dashboardVersion } from "../src/shared/dashboardVersion.ts";
import { resolveDirectPackageVersions } from "./packageIdentity.ts";

describe("direct package identity", () => {
    test("keeps the browser version aligned with package metadata", async () => {
        const packageMetadata: unknown = await Bun.file(
            path.resolve(import.meta.dir, "../package.json")
        ).json();

        expect(packageMetadata).toMatchObject({ version: dashboardVersion });
    });

    test("separates declared constraints from exact direct resolutions", () => {
        const lockfile = `{
            "packages": {
                "react": ["react@19.2.8", "", {}],
                "typescript": ["typescript@7.0.2", "", {}],
            },
        }`;

        expect(
            resolveDirectPackageVersions(
                [{ react: "^19.2.8" }, { typescript: "^7.0.2" }],
                lockfile
            )
        ).toEqual({ react: "19.2.8", typescript: "7.0.2" });
    });

    test("fails when a direct package is absent or has an unexpected resolution", () => {
        expect(() =>
            resolveDirectPackageVersions([{ react: "^19.2.8" }], '{"packages":{}}')
        ).toThrow("Direct package is missing");
        expect(() =>
            resolveDirectPackageVersions(
                [{ react: "^19.2.8" }],
                '{"packages":{"react":["preact@10.0.0"]}}'
            )
        ).toThrow("Unexpected Bun lockfile resolution");
    });
});
