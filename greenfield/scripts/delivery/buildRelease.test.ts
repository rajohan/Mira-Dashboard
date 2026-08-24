import { afterEach, describe, expect, test } from "bun:test";
import {
    chmod,
    cp,
    mkdir,
    mkdtemp,
    readdir,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { releaseBuildCommands } from "../../src/shared/releaseManifest.ts";
import type { BuildSourceIdentity } from "../buildSourceIdentity.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import { buildDashboardRelease, type ReleaseBuildCommand } from "./buildRelease.ts";
import type { ReleaseRuntimeIdentity } from "./releaseIdentity.ts";

const sourceProjectRoot = path.resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];
const commitSha = "b".repeat(40);
const cleanSource: BuildSourceIdentity = Object.freeze({
    commitSha,
    state: "clean",
});
const runtimeIdentity: ReleaseRuntimeIdentity = Object.freeze({
    revision: "a".repeat(40),
    version: "1.4.0",
});

async function restoreOwnerWrite(directory: string): Promise<void> {
    const status = await stat(directory).catch(() => {});
    if (!status?.isDirectory()) return;
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            await restoreOwnerWrite(path.join(directory, entry.name));
        }
    }
}

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await restoreOwnerWrite(directory);
        await rm(directory, { force: true, recursive: true });
    }
});

async function repositoryFixture(): Promise<string> {
    const repositoryRoot = await mkdtemp(path.join(tmpdir(), "mira-release-build-"));
    temporaryDirectories.push(repositoryRoot);
    await Promise.all([
        cp(
            path.join(sourceProjectRoot, "docs/generated"),
            path.join(repositoryRoot, "docs/generated"),
            { recursive: true }
        ),
        cp(
            path.join(sourceProjectRoot, "migrations"),
            path.join(repositoryRoot, "migrations"),
            { recursive: true }
        ),
        cp(
            path.join(sourceProjectRoot, "systemd"),
            path.join(repositoryRoot, "systemd"),
            { recursive: true }
        ),
        cp(
            path.join(sourceProjectRoot, "scripts/delivery/provisioning/log-maintenance"),
            path.join(repositoryRoot, "scripts/delivery/provisioning/log-maintenance"),
            { recursive: true }
        ),
        cp(
            path.join(sourceProjectRoot, ".bun-version"),
            path.join(repositoryRoot, ".bun-version")
        ),
        cp(
            path.join(sourceProjectRoot, "bun.lock"),
            path.join(repositoryRoot, "bun.lock")
        ),
        cp(
            path.join(sourceProjectRoot, "package.json"),
            path.join(repositoryRoot, "package.json")
        ),
    ]);
    return repositoryRoot;
}

async function materializeCommandOutput(
    command: ReleaseBuildCommand,
    repositoryRoot: string
): Promise<void> {
    if (command === "bun run build:browser") {
        await mkdir(path.join(repositoryRoot, "dist/browser/assets"), {
            recursive: true,
        });
        await Promise.all([
            writeFile(path.join(repositoryRoot, "dist/browser/index.html"), "dashboard"),
            writeFile(
                path.join(repositoryRoot, "dist/browser/assets/app-a1b2c3d4.js"),
                "app"
            ),
        ]);
    }
    if (command === "bun run build:processes") {
        await mkdir(path.join(repositoryRoot, "dist/processes"), { recursive: true });
        await Promise.all([
            writeFile(
                path.join(repositoryRoot, "dist/processes/databaseMaintenance.js"),
                "database-maintenance"
            ),
            writeFile(path.join(repositoryRoot, "dist/processes/web.js"), "web"),
            writeFile(path.join(repositoryRoot, "dist/processes/worker.js"), "worker"),
        ]);
    }
}

describe("Dashboard release build", () => {
    test("runs every represented command and publishes one frozen commit artifact", async () => {
        const repositoryRoot = await repositoryFixture();
        const commands: ReleaseBuildCommand[] = [];
        const result = await buildDashboardRelease(repositoryRoot, {
            resolveSourceIdentity: () => cleanSource,
            runCommand: async (command, root) => {
                commands.push(command);
                await materializeCommandOutput(command, root);
            },
            runtimeIdentity,
        });

        expect(commands).toEqual(releaseBuildCommands);
        expect(result.releaseRoot).toBe(
            path.join(repositoryRoot, "dist/releases", commitSha)
        );
        expect(result.manifest.source.commitSha).toBe(commitSha);
        const releaseStatus = await stat(result.releaseRoot);
        const manifestStatus = await stat(
            path.join(result.releaseRoot, "release-manifest.json")
        );
        const releaseEntries = await readdir(path.dirname(result.releaseRoot));
        expect(releaseStatus.mode & 0o777).toBe(0o500);
        expect(manifestStatus.mode & 0o777).toBe(0o400);
        expect(releaseEntries).toEqual([commitSha]);
    });

    test("rejects dirty or changing source and removes its staging tree", async () => {
        const dirtyRoot = await repositoryFixture();
        let dirtyCommandRan = false;
        const dirtyFailure = await rejectionError(
            buildDashboardRelease(dirtyRoot, {
                resolveSourceIdentity: () => ({ commitSha, state: "dirty" }),
                runCommand: () => {
                    dirtyCommandRan = true;
                    return Promise.resolve();
                },
                runtimeIdentity,
            })
        );
        expect(dirtyFailure.message).toBe("Dashboard release build failed");
        expect(dirtyCommandRan).toBeFalse();

        const changingRoot = await repositoryFixture();
        let sourceReadCount = 0;
        const changingFailure = await rejectionError(
            buildDashboardRelease(changingRoot, {
                resolveSourceIdentity: () => {
                    sourceReadCount += 1;
                    return sourceReadCount === 1
                        ? cleanSource
                        : { commitSha, state: "dirty" };
                },
                runCommand: materializeCommandOutput,
                runtimeIdentity,
            })
        );
        const changingEntries = await readdir(path.join(changingRoot, "dist/releases"));
        expect(changingFailure.message).toBe("Dashboard release build failed");
        expect(changingEntries).toEqual([]);
    });

    test("does not overwrite an existing commit artifact or retain failed staging", async () => {
        const existingRoot = await repositoryFixture();
        const finalRoot = path.join(existingRoot, "dist/releases", commitSha);
        await mkdir(finalRoot, { recursive: true });
        let existingCommandRan = false;
        const existingFailure = await rejectionError(
            buildDashboardRelease(existingRoot, {
                resolveSourceIdentity: () => cleanSource,
                runCommand: () => {
                    existingCommandRan = true;
                    return Promise.resolve();
                },
                runtimeIdentity,
            })
        );
        expect(existingFailure.message).toBe("Dashboard release build failed");
        expect(existingCommandRan).toBeFalse();

        const failedRoot = await repositoryFixture();
        const commandFailure = await rejectionError(
            buildDashboardRelease(failedRoot, {
                resolveSourceIdentity: () => cleanSource,
                runCommand: async (command, root) => {
                    if (command === "bun run docs:check") throw new Error("failed");
                    await materializeCommandOutput(command, root);
                },
                runtimeIdentity,
            })
        );
        const failedEntries = await readdir(path.join(failedRoot, "dist/releases"));
        expect(commandFailure.message).toBe("Dashboard release build failed");
        expect(failedEntries).toEqual([]);
    });
});
