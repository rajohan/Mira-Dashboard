import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveReviewedWorkerOpenClawFileRoot } from "./openClawFileRootConfiguration.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function fixture() {
    const parent = await mkdtemp(path.join(tmpdir(), "mira-worker-openclaw-root-"));
    temporaryDirectories.push(parent);
    const openClawRoot = path.join(parent, "openclaw");
    const productionRoot = path.join(parent, "dashboard", "production");
    await mkdir(openClawRoot, { mode: 0o700 });
    await mkdir(productionRoot, { mode: 0o700, recursive: true });
    return { openClawRoot, parent, productionRoot };
}

describe("reviewed worker OpenClaw file root", () => {
    test("returns only the two exact replacement targets", async () => {
        const { openClawRoot, productionRoot } = await fixture();

        expect(
            await resolveReviewedWorkerOpenClawFileRoot(openClawRoot, productionRoot)
        ).toEqual({
            id: "openclaw-config",
            path: openClawRoot,
            replacementManifest: [
                {
                    backupPolicy: "sibling-dot-bak",
                    maximumSizeBytes: 2_097_152,
                    segments: ["openclaw.json"],
                },
                {
                    backupPolicy: "sibling-dot-bak",
                    maximumSizeBytes: 2_097_152,
                    segments: ["hooks", "transforms", "agentmail.ts"],
                },
            ],
            writable: true,
        });
    });

    test("rejects aliases, unsafe roots, and production overlap", async () => {
        const { openClawRoot, parent, productionRoot } = await fixture();
        const alias = path.join(parent, "openclaw-link");
        await symlink(openClawRoot, alias, "dir");

        expect(
            resolveReviewedWorkerOpenClawFileRoot(alias, productionRoot)
        ).rejects.toThrow("OpenClaw file writer root is invalid");
        await chmod(openClawRoot, 0o750);
        expect(
            resolveReviewedWorkerOpenClawFileRoot(openClawRoot, productionRoot)
        ).rejects.toThrow("OpenClaw file writer root is invalid");
        expect(
            resolveReviewedWorkerOpenClawFileRoot(productionRoot, productionRoot)
        ).rejects.toThrow("OpenClaw file writer root is invalid");
    });
});
