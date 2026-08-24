import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { rejectionError } from "../../../scripts/testSupport/rejection.ts";
import {
    nextPreviewRetainedOwner,
    previewRetainedReconciliationIntervalMs,
    readPreviewRetainedOwner,
    removePreviewRetainedState,
    writePreviewRetainedOwner,
} from "./previewRetainedState.ts";
import { resolvePreviewStatePaths } from "./previewState.ts";

const head = "a".repeat(40);
const revision = "b".repeat(64);

function owner(number: number, reconciledAtMs = 0) {
    return {
        expectedHeadSha: head,
        formatVersion: 1 as const,
        number,
        previewRevision: revision,
        reconciledAtMs,
    };
}

async function fixture() {
    const parent = await mkdtemp(path.join(os.tmpdir(), "mira-preview-retained-"));
    const paths = await resolvePreviewStatePaths(path.join(parent, "preview"));
    return { parent, paths };
}

describe("preview retained state", () => {
    test("keeps bounded owner metadata outside candidate-writable state and selects one due owner", async () => {
        const context = await fixture();
        try {
            await mkdir(path.join(context.paths.statesRoot, "pr-42"), { mode: 0o700 });
            await writePreviewRetainedOwner(context.paths.ownersRoot, owner(42));
            await mkdir(path.join(context.paths.statesRoot, "pr-43"), { mode: 0o700 });
            await writePreviewRetainedOwner(context.paths.ownersRoot, owner(43, 100));

            expect(await readPreviewRetainedOwner(context.paths.ownersRoot, 42)).toEqual(
                owner(42)
            );
            expect(
                await nextPreviewRetainedOwner(
                    context.paths.ownersRoot,
                    previewRetainedReconciliationIntervalMs + 100
                )
            ).toEqual(owner(42));
            expect(
                await nextPreviewRetainedOwner(
                    context.paths.ownersRoot,
                    previewRetainedReconciliationIntervalMs + 101
                )
            ).toBeUndefined();
            expect(
                await readPreviewRetainedOwner(context.paths.ownersRoot, 999)
            ).toBeUndefined();
        } finally {
            await rm(context.parent, { force: true, recursive: true });
        }
    });

    test("removes one exact private tree and leaves other retained PRs untouched", async () => {
        const context = await fixture();
        try {
            const first = path.join(context.paths.statesRoot, "pr-42");
            const second = path.join(context.paths.statesRoot, "pr-43");
            await mkdir(path.join(first, "nested"), { mode: 0o700, recursive: true });
            await writeFile(path.join(first, "nested", "state.db"), "private\n", {
                mode: 0o600,
            });
            await mkdir(second, { mode: 0o700 });
            await mkdir(path.join(context.paths.gatewaysRoot, "pr-42"), {
                mode: 0o700,
            });
            await writeFile(path.join(second, "kept"), "kept\n", { mode: 0o600 });
            await writePreviewRetainedOwner(context.paths.ownersRoot, owner(42));
            await writePreviewRetainedOwner(context.paths.ownersRoot, owner(43));

            await removePreviewRetainedState(
                {
                    gatewaysRoot: context.paths.gatewaysRoot,
                    ownersRoot: context.paths.ownersRoot,
                    statesRoot: context.paths.statesRoot,
                },
                owner(42)
            );
            expect(
                await Bun.file(path.join(first, "nested", "state.db")).exists()
            ).toBeFalse();
            expect(await Bun.file(path.join(second, "kept")).exists()).toBeTrue();
            expect(await readdir(context.paths.gatewaysRoot)).not.toContain("pr-42");
            expect(
                await readPreviewRetainedOwner(context.paths.ownersRoot, 42)
            ).toBeUndefined();
            expect(await readPreviewRetainedOwner(context.paths.ownersRoot, 43)).toEqual(
                owner(43)
            );
        } finally {
            await rm(context.parent, { force: true, recursive: true });
        }
    });

    test("fails closed before deletion for public files or mismatched exact heads", async () => {
        const context = await fixture();
        try {
            const state = path.join(context.paths.statesRoot, "pr-42");
            await mkdir(state, { mode: 0o700 });
            await writeFile(path.join(state, "unsafe"), "public\n", { mode: 0o600 });
            await chmod(path.join(state, "unsafe"), 0o644);
            await writePreviewRetainedOwner(context.paths.ownersRoot, owner(42));

            expect(
                await rejectionError(
                    removePreviewRetainedState(
                        {
                            gatewaysRoot: context.paths.gatewaysRoot,
                            ownersRoot: context.paths.ownersRoot,
                            statesRoot: context.paths.statesRoot,
                        },
                        { ...owner(42), expectedHeadSha: "c".repeat(40) }
                    )
                )
            ).toMatchObject({ reason: "path-unsafe" });
            expect(await readPreviewRetainedOwner(context.paths.ownersRoot, 42)).toEqual(
                owner(42)
            );

            expect(
                await rejectionError(
                    removePreviewRetainedState(
                        {
                            gatewaysRoot: context.paths.gatewaysRoot,
                            ownersRoot: context.paths.ownersRoot,
                            statesRoot: context.paths.statesRoot,
                        },
                        owner(42)
                    )
                )
            ).toMatchObject({ reason: "path-unsafe" });
            expect(await readPreviewRetainedOwner(context.paths.ownersRoot, 42)).toEqual(
                owner(42)
            );
        } finally {
            await rm(context.parent, { force: true, recursive: true });
        }
    });
});
