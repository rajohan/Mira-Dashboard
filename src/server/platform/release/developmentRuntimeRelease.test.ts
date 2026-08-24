import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDevelopmentRuntimeRelease } from "./developmentRuntimeRelease.ts";

describe("development runtime release identity", () => {
    test("creates a source-rooted in-memory identity without production activation", () => {
        const repositoryRoot = path.resolve(import.meta.dir, "../../../..");
        const release = createDevelopmentRuntimeRelease(repositoryRoot, "1".repeat(40));

        expect(release.releaseRoot).toBe(repositoryRoot);
        expect(release.manifest.source.commitSha).toBe("1".repeat(40));
        expect(
            release.manifest.artifacts.map(({ path: artifactPath }) => artifactPath)
        ).toEqual(["development.marker"]);
        expect(Object.isFrozen(release.manifest)).toBeTrue();
    });

    test("rejects ambiguous roots and source identities", () => {
        expect(() => createDevelopmentRuntimeRelease("relative", "1".repeat(40))).toThrow(
            "Development source identity is invalid"
        );
        expect(() =>
            createDevelopmentRuntimeRelease("/srv/dashboard", "not-a-sha")
        ).toThrow("Development source identity is invalid");
    });

    test("rejects a runtime outside the repository-selected version", async () => {
        const repositoryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-development-runtime-version-")
        );
        try {
            await writeFile(path.join(repositoryRoot, ".bun-version"), "9.9.9\n");
            expect(() =>
                createDevelopmentRuntimeRelease(repositoryRoot, "1".repeat(40))
            ).toThrow("Serving Bun runtime must be 9.9.9");
        } finally {
            await rm(repositoryRoot, { force: true, recursive: true });
        }
    });
});
