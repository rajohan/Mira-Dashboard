import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionError } from "../testSupport/rejection.ts";
import { checkDocumentationArtifacts, writeDocumentationArtifacts } from "./files.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function outputFixture(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "mira-documentation-files-"));
    temporaryDirectories.push(root);
    return path.join(root, "generated");
}

describe("generated documentation files", () => {
    test("writes the exact artifact inventory and removes stale files", async () => {
        const outputDirectory = await outputFixture();
        await mkdir(path.join(outputDirectory, "stale"), { recursive: true });
        await writeFile(path.join(outputDirectory, "stale", "old.md"), "old\n");
        const artifacts = new Map([
            ["README.md", "index\n"],
            ["schemas/example.json", '{"type":"object"}\n'],
        ]);

        await writeDocumentationArtifacts(outputDirectory, artifacts);

        expect(await readFile(path.join(outputDirectory, "README.md"), "utf8")).toBe(
            "index\n"
        );
        expect(
            await readFile(path.join(outputDirectory, "schemas", "example.json"), "utf8")
        ).toBe('{"type":"object"}\n');
        expect(
            Bun.file(path.join(outputDirectory, "stale", "old.md")).exists()
        ).resolves.toBe(false);
        expect(
            checkDocumentationArtifacts(outputDirectory, artifacts)
        ).resolves.toBeUndefined();
    });

    test("rejects a stale file inventory and stale artifact contents", async () => {
        const outputDirectory = await outputFixture();
        const artifacts = new Map([["README.md", "current\n"]]);

        const missingInventory = await rejectionError(
            checkDocumentationArtifacts(outputDirectory, artifacts)
        );
        expect(missingInventory.message).toBe(
            "Generated documentation file set is stale; run bun run docs:generate"
        );

        await mkdir(outputDirectory, { recursive: true });
        await writeFile(path.join(outputDirectory, "README.md"), "stale\n");
        const staleArtifact = await rejectionError(
            checkDocumentationArtifacts(outputDirectory, artifacts)
        );
        expect(staleArtifact.message).toBe(
            "Generated documentation is stale at README.md; run bun run docs:generate"
        );
    });
});
