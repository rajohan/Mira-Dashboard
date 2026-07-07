import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, jest } from "bun:test";

import * as processModule from "../src/lib/processes.ts";
import {
    syncDockerUpdaterChanges,
    syncOpenClawWorkspaceSafePaths,
} from "../src/services/gitHygiene.ts";

const cleanupCallbacks: Array<() => void> = [];

function rememberEnvironment(key: string): void {
    const originalValue = process.env[key];
    cleanupCallbacks.push(() => {
        if (originalValue === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalValue;
        }
    });
}

function createTemporaryRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    cleanupCallbacks.push(() => rmSync(root, { force: true, recursive: true }));
    return root;
}

afterEach(() => {
    while (cleanupCallbacks.length > 0) {
        cleanupCallbacks.pop()?.();
    }
});

describe("git hygiene automation", () => {
    it("commits and pushes only safe OpenClaw workspace paths", async () => {
        rememberEnvironment("MIRA_OPENCLAW_ROOT");
        process.env.MIRA_OPENCLAW_ROOT = createTemporaryRoot("mira-openclaw-sync-");
        const calls: Array<readonly string[]> = [];
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_) => {
                calls.push(arguments_);
                const command = arguments_.join(" ");
                if (command === "status --porcelain") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: [
                            " M workspace/MEMORY.md",
                            " M openclaw.json",
                            "?? workspace/memory/2026-07-07.md",
                            "",
                        ].join("\n"),
                    };
                }
                if (
                    command ===
                    "diff --cached --quiet -- workspace/MEMORY.md workspace/memory/2026-07-07.md"
                ) {
                    return { code: 1, stderr: "", stdout: "" };
                }
                if (command === "rev-parse --short HEAD") {
                    return { code: 0, stderr: "", stdout: "abc1234\n" };
                }
                return { code: 0, stderr: "", stdout: "" };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(syncOpenClawWorkspaceSafePaths()).resolves.toEqual({
            changedPaths: ["workspace/MEMORY.md", "workspace/memory/2026-07-07.md"],
            commit: "abc1234",
            pushed: true,
        });
        expect(calls).toEqual(
            expect.arrayContaining([
                ["add", "--", "workspace/MEMORY.md", "workspace/memory/2026-07-07.md"],
                [
                    "commit",
                    "--only",
                    "-m",
                    "chore: sync OpenClaw workspace state",
                    "--",
                    "workspace/MEMORY.md",
                    "workspace/memory/2026-07-07.md",
                ],
                ["push"],
            ])
        );
    });

    it("skips OpenClaw sync when only unsafe paths changed", async () => {
        rememberEnvironment("MIRA_OPENCLAW_ROOT");
        process.env.MIRA_OPENCLAW_ROOT = createTemporaryRoot("mira-openclaw-skip-");
        const calls: Array<readonly string[]> = [];
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_) => {
                calls.push(arguments_);
                if (
                    arguments_.join(" ") ===
                    "rev-parse --abbrev-ref --symbolic-full-name @{u}"
                ) {
                    return { code: 1, stderr: "no upstream", stdout: "" };
                }
                return {
                    code: 0,
                    stderr: "",
                    stdout: " M openclaw.json\n",
                };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(syncOpenClawWorkspaceSafePaths()).resolves.toEqual({
            changedPaths: [],
            pushed: false,
            skippedReason: "no safe changes",
        });
        expect(calls).toEqual([
            ["status", "--porcelain"],
            ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
        ]);
    });

    it("retries pending OpenClaw automation commits when the tree is already clean", async () => {
        rememberEnvironment("MIRA_OPENCLAW_ROOT");
        process.env.MIRA_OPENCLAW_ROOT = createTemporaryRoot("mira-openclaw-push-retry-");
        const calls: Array<readonly string[]> = [];
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_) => {
                calls.push(arguments_);
                const command = arguments_.join(" ");
                if (command === "status --porcelain") {
                    return { code: 0, stderr: "", stdout: "" };
                }
                if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
                    return { code: 0, stderr: "", stdout: "origin/main\n" };
                }
                if (command === "log --format=%s origin/main..HEAD") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: "chore: sync OpenClaw workspace state\n",
                    };
                }
                if (command === "rev-parse --short HEAD") {
                    return { code: 0, stderr: "", stdout: "abc1234\n" };
                }
                return { code: 0, stderr: "", stdout: "" };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(syncOpenClawWorkspaceSafePaths()).resolves.toEqual({
            changedPaths: [],
            commit: "abc1234",
            pushed: true,
        });
        expect(calls).toEqual(
            expect.arrayContaining([
                ["status", "--porcelain"],
                ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
                ["log", "--format=%s", "origin/main..HEAD"],
                ["push"],
            ])
        );
    });

    it("commits and pushes only Docker updater compose paths", async () => {
        rememberEnvironment("MIRA_DOCKER_ROOT");
        process.env.MIRA_DOCKER_ROOT = createTemporaryRoot("mira-docker-sync-");
        const calls: Array<readonly string[]> = [];
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_) => {
                calls.push(arguments_);
                const command = arguments_.join(" ");
                if (command === "status --porcelain -- apps") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: [
                            " M apps/jackett/compose.yaml",
                            " M apps/jackett/secrets.env",
                            "",
                        ].join("\n"),
                    };
                }
                if (command === "diff --cached --quiet -- apps/jackett/compose.yaml") {
                    return { code: 1, stderr: "", stdout: "" };
                }
                if (command === "rev-parse --short HEAD") {
                    return { code: 0, stderr: "", stdout: "def5678\n" };
                }
                return { code: 0, stderr: "", stdout: "" };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(syncDockerUpdaterChanges()).resolves.toEqual({
            changedPaths: ["apps/jackett/compose.yaml"],
            commit: "def5678",
            pushed: true,
        });
        expect(calls).toEqual(
            expect.arrayContaining([
                ["add", "--", "apps/jackett/compose.yaml"],
                [
                    "commit",
                    "--only",
                    "-m",
                    "chore: update managed app images",
                    "--",
                    "apps/jackett/compose.yaml",
                ],
                ["push"],
            ])
        );
    });

    it("surfaces Docker git push failures after staging safe paths", async () => {
        rememberEnvironment("MIRA_DOCKER_ROOT");
        process.env.MIRA_DOCKER_ROOT = createTemporaryRoot("mira-docker-push-fail-");
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_) => {
                const command = arguments_.join(" ");
                if (command === "status --porcelain -- apps") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: " M apps/jackett/compose.yaml\n",
                    };
                }
                if (command === "diff --cached --quiet -- apps/jackett/compose.yaml") {
                    return { code: 1, stderr: "", stdout: "" };
                }
                if (command === "rev-parse --short HEAD") {
                    return { code: 0, stderr: "", stdout: "def5678\n" };
                }
                if (command === "push") {
                    return { code: 1, stderr: "remote rejected", stdout: "" };
                }
                return { code: 0, stderr: "", stdout: "" };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(syncDockerUpdaterChanges()).rejects.toThrow("remote rejected");
    });
});
