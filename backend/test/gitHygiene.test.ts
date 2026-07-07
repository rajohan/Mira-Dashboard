import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
                if (command === "status --porcelain=v1 -z") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: [
                            " M workspace/MEMORY.md",
                            " M openclaw.json",
                            "?? workspace/memory/2026-07-07.md",
                            "",
                        ].join("\0"),
                    };
                }
                if (
                    command ===
                    "diff --cached --quiet -- :(literal)workspace/MEMORY.md :(literal)workspace/memory/2026-07-07.md"
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
                [
                    "add",
                    "--",
                    ":(literal)workspace/MEMORY.md",
                    ":(literal)workspace/memory/2026-07-07.md",
                ],
                [
                    "commit",
                    "--only",
                    "-m",
                    "chore: sync OpenClaw workspace state",
                    "--",
                    ":(literal)workspace/MEMORY.md",
                    ":(literal)workspace/memory/2026-07-07.md",
                ],
                ["push"],
            ])
        );
    });

    it("uses configured OpenClaw home and handles non-ASCII safe paths", async () => {
        rememberEnvironment("MIRA_OPENCLAW_ROOT");
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        delete process.env.MIRA_OPENCLAW_ROOT;
        process.env.OPENCLAW_HOME = createTemporaryRoot("mira-openclaw-home-sync-");
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME = createTemporaryRoot(
            "mira-openclaw-dashboard-home-"
        );
        const calls: Array<{ arguments_: readonly string[]; cwd: string }> = [];
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_, options) => {
                calls.push({ arguments_, cwd: options?.cwd ?? "" });
                const command = arguments_.join(" ");
                if (command === "status --porcelain=v1 -z") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: "?? workspace/wiki/å.md\0",
                    };
                }
                if (
                    command === "diff --cached --quiet -- :(literal)workspace/wiki/å.md"
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
            changedPaths: ["workspace/wiki/å.md"],
            commit: "abc1234",
            pushed: true,
        });
        expect(calls).toEqual(
            expect.arrayContaining([
                {
                    arguments_: ["add", "--", ":(literal)workspace/wiki/å.md"],
                    cwd: process.env.OPENCLAW_HOME,
                },
            ])
        );
    });

    it("uses the process home OpenClaw default when no OpenClaw home is configured", async () => {
        rememberEnvironment("HOME");
        rememberEnvironment("MIRA_OPENCLAW_ROOT");
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        const homeRoot = createTemporaryRoot("mira-openclaw-home-default-");
        process.env.HOME = homeRoot;
        delete process.env.MIRA_OPENCLAW_ROOT;
        delete process.env.OPENCLAW_HOME;
        delete process.env.MIRA_DASHBOARD_OPENCLAW_HOME;
        const calls: Array<{ arguments_: readonly string[]; cwd: string }> = [];
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_, options) => {
                calls.push({ arguments_, cwd: options?.cwd ?? "" });
                if (arguments_.join(" ") === "status --porcelain=v1 -z") {
                    return { code: 0, stderr: "", stdout: "" };
                }
                if (
                    arguments_.join(" ") ===
                    "rev-parse --abbrev-ref --symbolic-full-name @{u}"
                ) {
                    return { code: 1, stderr: "no upstream", stdout: "" };
                }
                return { code: 0, stderr: "", stdout: "" };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(syncOpenClawWorkspaceSafePaths()).resolves.toEqual({
            changedPaths: [],
            pushed: false,
            skippedReason: "no safe changes",
        });
        expect(calls[0]).toEqual({
            arguments_: ["status", "--porcelain=v1", "-z"],
            cwd: path.join(homeRoot, ".openclaw"),
        });
    });

    it("commits both sides of safe OpenClaw renames", async () => {
        rememberEnvironment("MIRA_OPENCLAW_ROOT");
        process.env.MIRA_OPENCLAW_ROOT = createTemporaryRoot(
            "mira-openclaw-rename-sync-"
        );
        const calls: Array<readonly string[]> = [];
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_) => {
                calls.push(arguments_);
                const command = arguments_.join(" ");
                if (command === "status --porcelain=v1 -z") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: "R  workspace/wiki/new.md\0workspace/wiki/old.md\0",
                    };
                }
                if (
                    command ===
                    "diff --cached --quiet -- :(literal)workspace/wiki/new.md :(literal)workspace/wiki/old.md"
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
            changedPaths: ["workspace/wiki/new.md", "workspace/wiki/old.md"],
            commit: "abc1234",
            pushed: true,
        });
        expect(calls).toEqual(
            expect.arrayContaining([
                [
                    "add",
                    "--",
                    ":(literal)workspace/wiki/new.md",
                    ":(literal)workspace/wiki/old.md",
                ],
                [
                    "commit",
                    "--only",
                    "-m",
                    "chore: sync OpenClaw workspace state",
                    "--",
                    ":(literal)workspace/wiki/new.md",
                    ":(literal)workspace/wiki/old.md",
                ],
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
                    stdout: " M openclaw.json\0",
                };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(syncOpenClawWorkspaceSafePaths()).resolves.toEqual({
            changedPaths: [],
            pushed: false,
            skippedReason: "no safe changes",
        });
        expect(calls).toEqual([
            ["status", "--porcelain=v1", "-z"],
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
                if (command === "status --porcelain=v1 -z") {
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
                ["status", "--porcelain=v1", "-z"],
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
                if (command === "status --porcelain=v1 -z -- :(literal)apps") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: [
                            " M apps/jackett/compose.yaml",
                            " M apps/jackett/secrets.env",
                            "",
                        ].join("\0"),
                    };
                }
                if (
                    command ===
                    "diff --cached --quiet -- :(literal)apps/jackett/compose.yaml"
                ) {
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
                ["add", "--", ":(literal)apps/jackett/compose.yaml"],
                [
                    "commit",
                    "--only",
                    "-m",
                    "chore: update managed app images",
                    "--",
                    ":(literal)apps/jackett/compose.yaml",
                ],
                ["push"],
            ])
        );
    });

    it("escapes generated Docker pathspecs as literals", async () => {
        rememberEnvironment("MIRA_DOCKER_ROOT");
        const repoPath = createTemporaryRoot("mira-docker-literal-pathspec-");
        process.env.MIRA_DOCKER_ROOT = repoPath;
        const calls: Array<readonly string[]> = [];
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_) => {
                calls.push(arguments_);
                const command = arguments_.join(" ");
                if (
                    command ===
                    "status --porcelain=v1 -z -- :(literal)apps/foo*/compose.yaml"
                ) {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: " M apps/foo*/compose.yaml\0",
                    };
                }
                if (
                    command ===
                    "diff --cached --quiet -- :(literal)apps/foo*/compose.yaml"
                ) {
                    return { code: 1, stderr: "", stdout: "" };
                }
                if (command === "rev-parse --short HEAD") {
                    return { code: 0, stderr: "", stdout: "def5678\n" };
                }
                return { code: 0, stderr: "", stdout: "" };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(
            syncDockerUpdaterChanges([
                path.join(repoPath, "apps", "foo*", "compose.yaml"),
            ])
        ).resolves.toEqual({
            changedPaths: ["apps/foo*/compose.yaml"],
            commit: "def5678",
            pushed: true,
        });
        expect(calls).toEqual(
            expect.arrayContaining([
                ["add", "--", ":(literal)apps/foo*/compose.yaml"],
                [
                    "commit",
                    "--only",
                    "-m",
                    "chore: update managed app images",
                    "--",
                    ":(literal)apps/foo*/compose.yaml",
                ],
            ])
        );
    });

    it("resolves symlinked Docker apps roots before filtering changed paths", async () => {
        rememberEnvironment("MIRA_DOCKER_APPS_ROOT");
        const root = createTemporaryRoot("mira-docker-symlink-apps-");
        const repoPath = path.join(root, "repo");
        const realAppsRoot = path.join(repoPath, "apps");
        const symlinkAppsRoot = path.join(root, "apps-link");
        mkdirSync(realAppsRoot, { recursive: true });
        symlinkSync(realAppsRoot, symlinkAppsRoot, "dir");
        process.env.MIRA_DOCKER_APPS_ROOT = symlinkAppsRoot;
        const calls: Array<{ arguments_: readonly string[]; cwd: string }> = [];
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_, options) => {
                calls.push({ arguments_, cwd: options?.cwd ?? "" });
                const command = arguments_.join(" ");
                if (command === "rev-parse --show-toplevel") {
                    return { code: 0, stderr: "", stdout: `${repoPath}\n` };
                }
                if (
                    command ===
                    "status --porcelain=v1 -z -- :(literal)apps/jackett/compose.yaml"
                ) {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: " M apps/jackett/compose.yaml\0",
                    };
                }
                if (
                    command ===
                    "diff --cached --quiet -- :(literal)apps/jackett/compose.yaml"
                ) {
                    return { code: 1, stderr: "", stdout: "" };
                }
                if (command === "rev-parse --short HEAD") {
                    return { code: 0, stderr: "", stdout: "def5678\n" };
                }
                return { code: 0, stderr: "", stdout: "" };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(
            syncDockerUpdaterChanges([path.join(realAppsRoot, "jackett", "compose.yaml")])
        ).resolves.toEqual({
            changedPaths: ["apps/jackett/compose.yaml"],
            commit: "def5678",
            pushed: true,
        });
        expect(calls).toContainEqual(
            expect.objectContaining({
                arguments_: ["rev-parse", "--show-toplevel"],
                cwd: realAppsRoot,
            })
        );
    });

    it("refuses to push unrelated local commits with Docker automation commits", async () => {
        rememberEnvironment("MIRA_DOCKER_ROOT");
        process.env.MIRA_DOCKER_ROOT = createTemporaryRoot("mira-docker-ahead-guard-");
        const calls: Array<readonly string[]> = [];
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_) => {
                calls.push(arguments_);
                const command = arguments_.join(" ");
                if (command === "status --porcelain=v1 -z -- :(literal)apps") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: " M apps/jackett/compose.yaml\0",
                    };
                }
                if (
                    command ===
                    "diff --cached --quiet -- :(literal)apps/jackett/compose.yaml"
                ) {
                    return { code: 1, stderr: "", stdout: "" };
                }
                if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
                    return { code: 0, stderr: "", stdout: "origin/main\n" };
                }
                if (command === "log --format=%s origin/main..HEAD") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: "manual operator commit\n",
                    };
                }
                return { code: 0, stderr: "", stdout: "" };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(syncDockerUpdaterChanges()).rejects.toThrow(
            "Refusing to push unrelated local commits"
        );
        expect(calls).not.toContainEqual([
            "add",
            "--",
            ":(literal)apps/jackett/compose.yaml",
        ]);
    });

    it("refuses to commit Docker changes when the upstream cannot be inspected", async () => {
        rememberEnvironment("MIRA_DOCKER_ROOT");
        process.env.MIRA_DOCKER_ROOT = createTemporaryRoot(
            "mira-docker-no-upstream-guard-"
        );
        const calls: Array<readonly string[]> = [];
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_) => {
                calls.push(arguments_);
                const command = arguments_.join(" ");
                if (command === "status --porcelain=v1 -z -- :(literal)apps") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: " M apps/jackett/compose.yaml\0",
                    };
                }
                if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
                    return { code: 1, stderr: "no upstream configured", stdout: "" };
                }
                return { code: 0, stderr: "", stdout: "" };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(syncDockerUpdaterChanges()).rejects.toThrow(
            "Refusing to push without an inspectable upstream"
        );
        expect(calls).not.toContainEqual([
            "add",
            "--",
            ":(literal)apps/jackett/compose.yaml",
        ]);
    });

    it("retries pending Docker automation commits without scanning dirty paths", async () => {
        rememberEnvironment("MIRA_DOCKER_ROOT");
        process.env.MIRA_DOCKER_ROOT = createTemporaryRoot("mira-docker-pending-retry-");
        const calls: Array<readonly string[]> = [];
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_) => {
                calls.push(arguments_);
                const command = arguments_.join(" ");
                if (command === "rev-parse --abbrev-ref --symbolic-full-name @{u}") {
                    return { code: 0, stderr: "", stdout: "origin/main\n" };
                }
                if (command === "log --format=%s origin/main..HEAD") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: "chore: update managed app images\n",
                    };
                }
                if (command === "rev-parse --short HEAD") {
                    return { code: 0, stderr: "", stdout: "def5678\n" };
                }
                return { code: 0, stderr: "", stdout: "" };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(syncDockerUpdaterChanges([])).resolves.toEqual({
            changedPaths: [],
            commit: "def5678",
            pushed: true,
        });
        expect(calls).not.toContainEqual(["status", "--porcelain=v1", "-z", "--"]);
    });

    it("includes parent compose files under the Docker apps root", async () => {
        rememberEnvironment("MIRA_DOCKER_ROOT");
        const repoPath = createTemporaryRoot("mira-docker-parent-sync-");
        process.env.MIRA_DOCKER_ROOT = repoPath;
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_) => {
                const command = arguments_.join(" ");
                if (
                    command === "status --porcelain=v1 -z -- :(literal)apps/compose.yaml"
                ) {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: " M apps/compose.yaml\0",
                    };
                }
                if (command === "diff --cached --quiet -- :(literal)apps/compose.yaml") {
                    return { code: 1, stderr: "", stdout: "" };
                }
                if (command === "rev-parse --short HEAD") {
                    return { code: 0, stderr: "", stdout: "def5678\n" };
                }
                return { code: 0, stderr: "", stdout: "" };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(
            syncDockerUpdaterChanges([path.join(repoPath, "apps", "compose.yaml")])
        ).resolves.toEqual({
            changedPaths: ["apps/compose.yaml"],
            commit: "def5678",
            pushed: true,
        });
    });

    it("includes explicit repo-root parent compose files", async () => {
        rememberEnvironment("MIRA_DOCKER_ROOT");
        const repoPath = createTemporaryRoot("mira-docker-root-parent-sync-");
        process.env.MIRA_DOCKER_ROOT = repoPath;
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_) => {
                const command = arguments_.join(" ");
                if (command === "status --porcelain=v1 -z -- :(literal)compose.yaml") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: " M compose.yaml\0",
                    };
                }
                if (command === "diff --cached --quiet -- :(literal)compose.yaml") {
                    return { code: 1, stderr: "", stdout: "" };
                }
                if (command === "rev-parse --short HEAD") {
                    return { code: 0, stderr: "", stdout: "def5678\n" };
                }
                return { code: 0, stderr: "", stdout: "" };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(
            syncDockerUpdaterChanges([path.join(repoPath, "compose.yaml")])
        ).resolves.toEqual({
            changedPaths: ["compose.yaml"],
            commit: "def5678",
            pushed: true,
        });
    });

    it("includes explicit nested ancestor compose files", async () => {
        rememberEnvironment("MIRA_DOCKER_APPS_ROOT");
        const repoPath = createTemporaryRoot("mira-docker-nested-parent-sync-");
        const appsRoot = path.join(repoPath, "stacks", "apps");
        mkdirSync(appsRoot, { recursive: true });
        process.env.MIRA_DOCKER_APPS_ROOT = appsRoot;
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_) => {
                const command = arguments_.join(" ");
                if (command === "rev-parse --show-toplevel") {
                    return { code: 0, stderr: "", stdout: `${repoPath}\n` };
                }
                if (
                    command ===
                    "status --porcelain=v1 -z -- :(literal)stacks/compose.yaml"
                ) {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: " M stacks/compose.yaml\0",
                    };
                }
                if (
                    command === "diff --cached --quiet -- :(literal)stacks/compose.yaml"
                ) {
                    return { code: 1, stderr: "", stdout: "" };
                }
                if (command === "rev-parse --short HEAD") {
                    return { code: 0, stderr: "", stdout: "def5678\n" };
                }
                return { code: 0, stderr: "", stdout: "" };
            }) as typeof processModule.runProcess);
        cleanupCallbacks.push(() => runProcessSpy.mockRestore());

        await expect(
            syncDockerUpdaterChanges([path.join(repoPath, "stacks", "compose.yaml")])
        ).resolves.toEqual({
            changedPaths: ["stacks/compose.yaml"],
            commit: "def5678",
            pushed: true,
        });
    });

    it("surfaces Docker git push failures after staging safe paths", async () => {
        rememberEnvironment("MIRA_DOCKER_ROOT");
        process.env.MIRA_DOCKER_ROOT = createTemporaryRoot("mira-docker-push-fail-");
        const runProcessSpy = jest
            .spyOn(processModule, "runProcess")
            .mockImplementation((async (_file, arguments_) => {
                const command = arguments_.join(" ");
                if (command === "status --porcelain=v1 -z -- :(literal)apps") {
                    return {
                        code: 0,
                        stderr: "",
                        stdout: " M apps/jackett/compose.yaml\0",
                    };
                }
                if (
                    command ===
                    "diff --cached --quiet -- :(literal)apps/jackett/compose.yaml"
                ) {
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
