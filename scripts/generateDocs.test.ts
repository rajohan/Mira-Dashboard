import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { synchronizeGeneratedDocumentation } from "./generateDocs.ts";
import { rejectionError } from "./testSupport/rejection.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function repositoryFixture(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "mira-generate-docs-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "docs", "operations"), { recursive: true });
    await Promise.all([
        mkdir(path.join(root, "docs", "generated"), { recursive: true }),
        writeFile(
            path.join(root, "package.json"),
            `${JSON.stringify({ dependencies: {}, devDependencies: { "bun-types": "*" } }, null, 2)}\n`
        ),
        writeFile(
            path.join(root, "bun.lock"),
            '{"packages":{"bun-types":["bun-types@1.4.0","",{}]}}\n'
        ),
        writeFile(path.join(root, ".bun-version"), "1.4.0\n"),
        writeFile(path.join(root, "docs", "operations", "runbook.md"), "# Runbook\n"),
    ]);
    return root;
}

describe("generated documentation synchronization", () => {
    test("writes and then verifies the deterministic artifact tree", async () => {
        const projectRoot = await repositoryFixture();

        await synchronizeGeneratedDocumentation(projectRoot, "write");

        expect(
            Bun.file(path.join(projectRoot, "docs/generated/README.md")).exists()
        ).resolves.toBe(true);
        expect(
            Bun.file(
                path.join(projectRoot, "docs/generated/browser-reference.json")
            ).json()
        ).resolves.toContainEqual({
            content: "# Runbook\n",
            kind: "markdown",
            path: "operations/runbook.md",
            source: "maintained",
        });
        expect(
            synchronizeGeneratedDocumentation(projectRoot, "check")
        ).resolves.toBeUndefined();
    });

    test("rejects stale generated documentation in check mode", async () => {
        const projectRoot = await repositoryFixture();

        const failure = await rejectionError(
            synchronizeGeneratedDocumentation(projectRoot, "check")
        );

        expect(failure.message).toBe(
            "Generated documentation file set is stale; run bun run generate docs"
        );
    });

    test("rejects bun-types drift from the sole runtime pin", async () => {
        const projectRoot = await repositoryFixture();
        await writeFile(path.join(projectRoot, ".bun-version"), "1.4.1\n");

        expect(synchronizeGeneratedDocumentation(projectRoot, "write")).rejects.toThrow(
            "Locked bun-types must match .bun-version"
        );
    });
});
