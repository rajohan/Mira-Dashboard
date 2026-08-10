import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    assertReviewedOpenClawFileRoot,
    resolveReviewedOpenClawFileRoot,
} from "./openClawFileRootConfiguration.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function fixture() {
    const parent = await mkdtemp(path.join(tmpdir(), "mira-openclaw-root-"));
    temporaryDirectories.push(parent);
    const openClawRoot = path.join(parent, "openclaw");
    const productionRoot = path.join(parent, "dashboard", "production");
    await mkdir(openClawRoot, { mode: 0o700 });
    await mkdir(productionRoot, { mode: 0o700, recursive: true });
    return { openClawRoot, parent, productionRoot };
}

describe("reviewed OpenClaw file root", () => {
    test("returns only the fixed legacy-editable manifest", async () => {
        const { openClawRoot, productionRoot } = await fixture();

        expect(
            await resolveReviewedOpenClawFileRoot(openClawRoot, productionRoot)
        ).toEqual({
            id: "openclaw-config",
            label: "OpenClaw Config",
            manifest: [
                {
                    contentPolicy: "redacted-config-json",
                    maximumSizeBytes: 1_048_576,
                    segments: ["openclaw.json"],
                    writable: true,
                },
                {
                    contentPolicy: "raw",
                    maximumSizeBytes: 1_048_576,
                    segments: ["hooks", "transforms", "agentmail.ts"],
                    writable: true,
                },
            ],
            path: openClawRoot,
            writable: false,
        });
    });

    test("rejects aliases, unsafe roots, and Dashboard production overlap", async () => {
        const { openClawRoot, parent, productionRoot } = await fixture();
        const alias = path.join(parent, "openclaw-link");
        await symlink(openClawRoot, alias, "dir");

        expect(resolveReviewedOpenClawFileRoot(alias, productionRoot)).rejects.toThrow(
            "OpenClaw file root is invalid"
        );
        await chmod(openClawRoot, 0o750);
        expect(
            resolveReviewedOpenClawFileRoot(openClawRoot, productionRoot)
        ).rejects.toThrow("OpenClaw file root is invalid");
        expect(
            resolveReviewedOpenClawFileRoot(productionRoot, productionRoot)
        ).rejects.toThrow("OpenClaw file root is invalid");
    });

    test("rejects a substituted or broadened manifest at composition", () => {
        expect(() =>
            assertReviewedOpenClawFileRoot({
                id: "openclaw-config",
                label: "OpenClaw Config",
                manifest: [
                    {
                        contentPolicy: "raw",
                        maximumSizeBytes: 1_048_576,
                        segments: ["openclaw.json"],
                        writable: true,
                    },
                    {
                        contentPolicy: "raw",
                        maximumSizeBytes: 1_048_576,
                        segments: ["credentials.json"],
                        writable: true,
                    },
                ],
                path: "/srv/openclaw",
                writable: false,
            })
        ).toThrow("OpenClaw file root is invalid");
    });
});
