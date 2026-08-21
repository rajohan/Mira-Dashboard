import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    ensurePreviewPrStateRoot,
    prepareManagedPreviewStateRoot,
    readPreviewState,
    resolvePreviewStatePaths,
    writePreviewState,
} from "./previewState.ts";
import { previewFormatVersion, previewMaximumDurationMs } from "./previewTypes.ts";

const operationId = "018f1f0e-7c52-7d63-8f22-b5f776933127";
const revision = "a".repeat(64);
const head = "b".repeat(40);

describe("preview durable state", () => {
    test("writes a private bounded record and fences stale revisions", async () => {
        const parent = await mkdtemp(path.join(os.tmpdir(), "mira-preview-state-"));
        const root = path.join(parent, "preview");
        try {
            const paths = await resolvePreviewStatePaths(root);
            const record = {
                expectedHeads: [{ headSha: head, number: 42 }],
                expiresAtMs: previewMaximumDurationMs,
                formatVersion: previewFormatVersion,
                number: 42,
                operationId,
                ownsTailscaleServe: false,
                previewRevision: revision,
                publicOrigin: "https://preview.example.test:3445",
                status: "starting" as const,
                title: "Preview",
                updatedAtMs: 0,
            };
            await writePreviewState(paths, record);
            expect(await readPreviewState(paths)).toEqual(record);
            const stateMetadata = await lstat(paths.stateFile);
            expect(stateMetadata.mode & 0o777).toBe(0o600);

            expect(
                writePreviewState(paths, record, "c".repeat(64))
            ).rejects.toMatchObject({ reason: "state-conflict" });
            expect(writePreviewState(paths, record)).rejects.toMatchObject({
                reason: "state-conflict",
            });
        } finally {
            await rm(parent, { force: true, recursive: true });
        }
    });

    test("rejects symlinked per-PR state roots", async () => {
        const parent = await mkdtemp(path.join(os.tmpdir(), "mira-preview-symlink-"));
        const root = path.join(parent, "preview");
        try {
            const paths = await resolvePreviewStatePaths(root);
            const outside = path.join(parent, "outside");
            await mkdir(outside);
            await symlink(outside, path.join(paths.statesRoot, "pr-42"));
            expect(ensurePreviewPrStateRoot(paths, 42)).rejects.toMatchObject({
                reason: "path-unsafe",
            });
        } finally {
            await rm(parent, { force: true, recursive: true });
        }
    });

    test("fails closed on public or malformed state", async () => {
        const parent = await mkdtemp(path.join(os.tmpdir(), "mira-preview-invalid-"));
        const root = path.join(parent, "preview");
        try {
            const paths = await resolvePreviewStatePaths(root);
            await writeFile(paths.stateFile, "{}", { mode: 0o600 });
            await chmod(paths.stateFile, 0o644);
            expect(readPreviewState(paths)).rejects.toMatchObject({
                reason: "state-unavailable",
            });
        } finally {
            await rm(parent, { force: true, recursive: true });
        }
    });

    test("prepares and revalidates the exact managed development owner marker", async () => {
        const parent = await mkdtemp(path.join(os.tmpdir(), "mira-preview-marker-"));
        try {
            const paths = await resolvePreviewStatePaths(path.join(parent, "preview"));
            const stateRoot = await prepareManagedPreviewStateRoot(paths, 42);
            const marker = path.join(stateRoot, ".mira-dashboard-development-state.json");
            expect(JSON.parse(await Bun.file(marker).text())).toEqual({
                formatVersion: 1,
                owner: "mira-dashboard-source-development-v1",
            });
            await prepareManagedPreviewStateRoot(paths, 42);
            await writeFile(marker, "{}\n", { mode: 0o600 });
            expect(prepareManagedPreviewStateRoot(paths, 42)).rejects.toMatchObject({
                reason: "state-unavailable",
            });
        } finally {
            await rm(parent, { force: true, recursive: true });
        }
    });
});
