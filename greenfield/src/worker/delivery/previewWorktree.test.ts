import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Redacted } from "effect";

import {
    assertManagedPreviewWorktree,
    preparePreviewWorktree,
    readBoundedPreviewProcessOutput,
    type PreviewProcessRequest,
} from "./previewWorktree.ts";

const operationId = "018f1f0e-7c52-7d63-8f22-b5f776933127";
const head = "b".repeat(40);

async function materializeManagedWorktree(
    checkoutRoot: string,
    worktreePath: string
): Promise<void> {
    const admin = path.join(checkoutRoot, ".git", "worktrees", "preview");
    await mkdir(admin, { recursive: true });
    await mkdir(worktreePath, { recursive: true });
    await writeFile(path.join(worktreePath, ".git"), `gitdir: ${admin}\n`);
    await writeFile(path.join(admin, "gitdir"), `${path.join(worktreePath, ".git")}\n`);
}

describe("preview exact worktree", () => {
    test("uses fixed authenticated Git and frozen script-free Bun installation", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "mira-preview-worktree-"));
        const checkoutRoot = path.join(root, "checkout");
        const worktreePath = path.join(root, "worktree");
        await mkdir(path.join(checkoutRoot, ".git", "worktrees"), {
            recursive: true,
        });
        const requests: PreviewProcessRequest[] = [];
        try {
            await preparePreviewWorktree(
                {
                    expectedHeads: [{ headSha: head, number: 42 }],
                    number: 42,
                    operationId,
                    previewRevision: "a".repeat(64),
                    title: "Preview",
                },
                {
                    bunExecutable: "/opt/mira/runtime/bun",
                    checkoutRoot,
                    credentials: {
                        token: Redacted.make("worker-only-token", {
                            label: "test-preview-token",
                        }),
                    },
                    processRunner: async (request) => {
                        requests.push(request);
                        if (
                            request.arguments.includes("worktree") &&
                            request.arguments.includes("add")
                        ) {
                            await materializeManagedWorktree(checkoutRoot, worktreePath);
                        }
                        if (request.arguments.includes("rev-parse")) {
                            return { exitCode: 0, stderr: "", stdout: `${head}\n` };
                        }
                        return { exitCode: 0, stderr: "", stdout: "" };
                    },
                    worktreePath,
                }
            );

            const fetch = requests.find(({ arguments: arguments_ }) =>
                arguments_.includes("fetch")
            );
            expect(fetch?.executable).toBe("/usr/bin/git");
            expect(fetch?.arguments).not.toContain("-c");
            expect(fetch?.arguments.join(" ")).not.toContain("Authorization");
            expect(fetch?.environment.GIT_CONFIG_KEY_3).toBe(
                "http.https://github.com/.extraHeader"
            );
            expect(fetch?.environment.GIT_CONFIG_VALUE_3).toStartWith(
                "Authorization: Basic "
            );
            expect(fetch?.arguments.join(" ")).not.toContain("worker-only-token");
            expect(JSON.stringify(requests)).not.toContain("worker-only-token");
            const install = requests.at(-1)!;
            expect(install.executable).toBe("/opt/mira/runtime/bun");
            expect(install.arguments).toEqual([
                "install",
                "--frozen-lockfile",
                "--ignore-scripts",
                "--no-save",
            ]);
            expect(install.environment).not.toHaveProperty("GITHUB_TOKEN");
            expect(install.environment).not.toHaveProperty("DOPPLER_TOKEN");
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    test("aborts while streaming output immediately after the one MiB cap", () => {
        const abort = new AbortController();
        let pulls = 0;
        const stream = new ReadableStream<Uint8Array>({
            pull(controller) {
                pulls += 1;
                controller.enqueue(new Uint8Array(512 * 1024));
                if (pulls === 3) controller.close();
            },
        });
        expect(readBoundedPreviewProcessOutput(stream, abort)).rejects.toMatchObject({
            reason: "operation-failed",
        });
        expect(abort.signal.aborted).toBeTrue();
        expect(pulls).toBe(3);
    });

    test("fails before worktree creation when fetched SHA drifts", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "mira-preview-drift-"));
        const checkoutRoot = path.join(root, "checkout");
        await mkdir(checkoutRoot);
        try {
            expect(
                preparePreviewWorktree(
                    {
                        expectedHeads: [{ headSha: head, number: 42 }],
                        number: 42,
                        operationId,
                        previewRevision: "a".repeat(64),
                        title: "Preview",
                    },
                    {
                        bunExecutable: "/opt/mira/runtime/bun",
                        checkoutRoot,
                        credentials: {
                            token: Redacted.make("token", {
                                label: "test-preview-token",
                            }),
                        },
                        processRunner: (request) =>
                            Promise.resolve({
                                exitCode: 0,
                                stderr: "",
                                stdout: request.arguments.includes("rev-parse")
                                    ? `${"c".repeat(40)}\n`
                                    : "",
                            }),
                        worktreePath: path.join(root, "worktree"),
                    }
                )
            ).rejects.toMatchObject({ reason: "scope-changed" });
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    test("rejects an absolute Git admin pointer outside the managed checkout", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "mira-preview-admin-"));
        const checkoutRoot = path.join(root, "checkout");
        const worktreePath = path.join(root, "worktree");
        const outside = path.join(root, "outside-admin");
        try {
            await mkdir(path.join(checkoutRoot, ".git", "worktrees"), {
                recursive: true,
            });
            await mkdir(worktreePath);
            await mkdir(outside);
            await writeFile(path.join(worktreePath, ".git"), `gitdir: ${outside}\n`);
            await writeFile(
                path.join(outside, "gitdir"),
                `${path.join(worktreePath, ".git")}\n`
            );
            expect(
                assertManagedPreviewWorktree(checkoutRoot, worktreePath)
            ).rejects.toMatchObject({ reason: "path-unsafe" });
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    test("rejects a forged back-pointer before any worktree removal", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "mira-preview-back-"));
        const checkoutRoot = path.join(root, "checkout");
        const worktreePath = path.join(root, "worktree");
        try {
            await materializeManagedWorktree(checkoutRoot, worktreePath);
            await writeFile(
                path.join(checkoutRoot, ".git", "worktrees", "preview", "gitdir"),
                `${path.join(root, "other", ".git")}\n`
            );
            expect(
                assertManagedPreviewWorktree(checkoutRoot, worktreePath)
            ).rejects.toMatchObject({ reason: "path-unsafe" });
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });

    test("never removes an unregistered directory at the managed worktree path", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "mira-preview-forged-"));
        const checkoutRoot = path.join(root, "checkout");
        const worktreePath = path.join(root, "worktree");
        const requests: PreviewProcessRequest[] = [];
        try {
            await mkdir(path.join(checkoutRoot, ".git", "worktrees"), {
                recursive: true,
            });
            await mkdir(worktreePath);
            await writeFile(path.join(worktreePath, "valuable"), "preserve\n");
            expect(
                preparePreviewWorktree(
                    {
                        expectedHeads: [{ headSha: head, number: 42 }],
                        number: 42,
                        operationId,
                        previewRevision: "a".repeat(64),
                        title: "Preview",
                    },
                    {
                        bunExecutable: "/opt/mira/runtime/bun",
                        checkoutRoot,
                        credentials: {
                            token: Redacted.make("token", {
                                label: "test-preview-token",
                            }),
                        },
                        processRunner: (request) => {
                            requests.push(request);
                            return Promise.resolve({
                                exitCode: 0,
                                stderr: "",
                                stdout: request.arguments.includes("rev-parse")
                                    ? `${head}\n`
                                    : "",
                            });
                        },
                        worktreePath,
                    }
                )
            ).rejects.toMatchObject({ reason: "path-unsafe" });
            expect(await Bun.file(path.join(worktreePath, "valuable")).text()).toBe(
                "preserve\n"
            );
            expect(
                requests.some(
                    ({ arguments: arguments_ }) =>
                        arguments_.includes("worktree") && arguments_.includes("remove")
                )
            ).toBeFalse();
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });
});
