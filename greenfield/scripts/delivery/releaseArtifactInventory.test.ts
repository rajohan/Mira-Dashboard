import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionError } from "../testSupport/rejection.ts";
import { inventoryReleaseArtifactTree } from "./releaseArtifactInventory.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function releaseTree(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "mira-release-tree-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "browser"));
    await mkdir(path.join(root, "server"));
    await writeFile(path.join(root, "browser/index.html"), "dashboard");
    await writeFile(path.join(root, "server/web.js"), "web");
    await writeFile(path.join(root, "server/worker.js"), "worker");
    return root;
}

describe("release artifact inventory", () => {
    test("returns a stable sorted identity for every regular artifact", async () => {
        const root = await releaseTree();

        const inventory = await inventoryReleaseArtifactTree(root);

        expect(
            inventory.map(({ bytes, path: artifactPath }) => ({
                bytes,
                path: artifactPath,
            }))
        ).toEqual([
            { bytes: 9, path: "browser/index.html" },
            { bytes: 3, path: "server/web.js" },
            { bytes: 6, path: "server/worker.js" },
        ]);
        expect(inventory.every(({ sha256 }) => /^[a-f\d]{64}$/u.test(sha256))).toBe(true);
        expect(Object.isFrozen(inventory)).toBe(true);
        expect(inventory.every((record) => Object.isFrozen(record))).toBe(true);
    });

    test("rejects symlinks, hardlinks, empty files and noncanonical names", async () => {
        for (const invalidKind of ["symlink", "hardlink", "empty", "name"] as const) {
            const root = await releaseTree();
            const target = path.join(root, "browser/index.html");
            if (invalidKind === "symlink") {
                await symlink(target, path.join(root, "linked.html"));
            } else if (invalidKind === "hardlink") {
                await link(target, path.join(root, "linked.html"));
            } else if (invalidKind === "empty") {
                await writeFile(path.join(root, "empty.txt"), "");
            } else {
                await writeFile(path.join(root, "not canonical.txt"), "invalid");
            }
            const failure = await rejectionError(inventoryReleaseArtifactTree(root));
            expect(failure.message).toBe("Release artifact tree is invalid");
        }
    });

    test("rejects a path replacement after file verification", async () => {
        const root = await releaseTree();
        const target = path.join(root, "browser/index.html");
        const displaced = path.join(root, "browser/displaced.html");
        let replaced = false;

        const failure = await rejectionError(
            inventoryReleaseArtifactTree(root, {
                afterFileRead: async (relativePath) => {
                    if (!replaced && relativePath === "browser/index.html") {
                        replaced = true;
                        await rename(target, displaced);
                        await writeFile(target, "replacement");
                    }
                },
            })
        );
        expect(failure.message).toBe("Release artifact tree is invalid");
        expect(replaced).toBe(true);
    });
});
