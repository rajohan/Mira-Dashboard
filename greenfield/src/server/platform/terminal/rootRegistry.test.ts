import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTerminalRootRegistry, TerminalRootAccessError } from "./rootRegistry.ts";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(name: string): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), name));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

describe("terminal starting-root registry", () => {
    test("publishes canonical PTY capabilities and resolves reviewed directories", async () => {
        const root = await temporaryDirectory("mira-terminal-root-");
        await mkdir(path.join(root, "workspace"));
        const registry = await createTerminalRootRegistry([
            {
                absolutePath: root,
                defaultPath: "/workspace",
                id: "workspace",
                label: "Workspace",
            },
        ]);

        expect(registry.runtime()).toMatchObject({
            defaultLocation: { path: "/workspace", rootId: "workspace" },
            mode: "pty",
            supportsInput: true,
            supportsPty: true,
            supportsResize: true,
        });
        expect(
            await registry.resolveDirectory({ path: "/workspace", rootId: "workspace" })
        ).toBe(path.join(root, "workspace"));
    });

    test("sorts public roots without allowing duplicate ids", async () => {
        const first = await temporaryDirectory("mira-terminal-first-");
        const second = await temporaryDirectory("mira-terminal-second-");
        const registry = await createTerminalRootRegistry([
            { absolutePath: second, id: "z-root", label: "Z" },
            { absolutePath: first, id: "a-root", label: "A" },
        ]);
        expect(registry.runtime().roots.map(({ id }) => id)).toEqual([
            "a-root",
            "z-root",
        ]);

        expect(
            createTerminalRootRegistry([
                { absolutePath: first, id: "same", label: "A" },
                { absolutePath: second, id: "same", label: "B" },
            ])
        ).rejects.toBeInstanceOf(TerminalRootAccessError);
    });

    test("rejects a symlinked starting directory that escapes its reviewed root", async () => {
        const root = await temporaryDirectory("mira-terminal-contained-");
        const outside = await temporaryDirectory("mira-terminal-outside-");
        await symlink(outside, path.join(root, "escape"));
        const registry = await createTerminalRootRegistry([
            { absolutePath: root, id: "workspace", label: "Workspace" },
        ]);

        expect(
            registry.resolveDirectory({ path: "/escape", rootId: "workspace" })
        ).rejects.toMatchObject({ reason: "invalid-location" });
    });

    test("rejects unknown roots and unavailable directories without exposing host paths", async () => {
        const root = await temporaryDirectory("mira-terminal-errors-");
        const registry = await createTerminalRootRegistry([
            { absolutePath: root, id: "workspace", label: "Workspace" },
        ]);

        expect(
            registry.resolveDirectory({ path: "/", rootId: "missing" })
        ).rejects.toMatchObject({ reason: "invalid-location" });
        expect(
            registry.resolveDirectory({ path: "/missing", rootId: "workspace" })
        ).rejects.toMatchObject({ reason: "directory-unavailable" });
    });
});
