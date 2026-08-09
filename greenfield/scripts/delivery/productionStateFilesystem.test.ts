import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    prepareProtectedProductionStatePath,
    ProductionStateFilesystemError,
} from "./productionStateFilesystem.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map(async (directory) => {
            await chmod(directory, 0o700).catch(() => {});
            await rm(directory, { force: true, recursive: true });
        })
    );
});

async function createProjectRoot(): Promise<{ parent: string; root: string }> {
    const parent = await mkdtemp(path.join(tmpdir(), "mira-production-state-"));
    temporaryDirectories.push(parent);
    const root = path.join(parent, "dashboard");
    await mkdir(root, { mode: 0o755 });
    await chmod(root, 0o755);
    return { parent, root };
}

async function permissionMode(directory: string): Promise<number> {
    const status = await lstat(directory, { bigint: true });
    return Number(status.mode & 0o7777n);
}

async function expectFilesystemRejection(operation: Promise<unknown>): Promise<void> {
    try {
        await operation;
    } catch (error) {
        expect(error).toBeInstanceOf(ProductionStateFilesystemError);
        return;
    }
    throw new Error("Expected protected filesystem preparation to reject");
}

describe("production state filesystem", () => {
    test("creates only private project-local state and narrows writable ancestors", async () => {
        const { parent, root } = await createProjectRoot();
        await chmod(parent, 0o775);

        const prepared = await prepareProtectedProductionStatePath(root);

        expect(prepared).toEqual({
            backupsDirectory: path.join(root, "production/state/backups"),
            jobOutputDirectory: path.join(root, "production/state/job-output"),
            logMaintenanceDirectory: path.join(root, "production/state/log-maintenance"),
            logsDirectory: path.join(root, "production/state/logs"),
            productionDirectory: path.join(root, "production"),
            projectRoot: root,
            stateDirectory: path.join(root, "production/state"),
            terminalBrokerDirectory: path.join(root, "production/state/terminal-broker"),
            workspaceFileUploadsDirectory: path.join(
                root,
                "production/state/workspace-file-uploads"
            ),
        });
        expect(await permissionMode(parent)).toBe(0o755);
        expect(await permissionMode(root)).toBe(0o755);
        expect(await permissionMode(prepared.productionDirectory)).toBe(0o700);
        expect(await permissionMode(prepared.stateDirectory)).toBe(0o700);
        expect(await permissionMode(prepared.backupsDirectory)).toBe(0o700);
        expect(await permissionMode(prepared.jobOutputDirectory)).toBe(0o700);
        expect(await permissionMode(prepared.logMaintenanceDirectory)).toBe(0o700);
        expect(await permissionMode(prepared.logsDirectory)).toBe(0o700);
        expect(await permissionMode(prepared.terminalBrokerDirectory)).toBe(0o700);
        expect(await permissionMode(prepared.workspaceFileUploadsDirectory)).toBe(0o700);
    });

    test("narrows existing managed directories without broadening permissions", async () => {
        const { root } = await createProjectRoot();
        const production = path.join(root, "production");
        await mkdir(production, { mode: 0o755 });
        await chmod(production, 0o755);

        const prepared = await prepareProtectedProductionStatePath(root);

        expect(await permissionMode(prepared.productionDirectory)).toBe(0o700);
        expect(await prepareProtectedProductionStatePath(root)).toEqual(prepared);
    });

    test("rejects a managed directory that private-mode repair would broaden", async () => {
        const { root } = await createProjectRoot();
        const production = path.join(root, "production");
        await mkdir(production, { mode: 0o600 });
        await chmod(production, 0o600);

        await expectFilesystemRejection(prepareProtectedProductionStatePath(root));
        expect(await permissionMode(production)).toBe(0o600);
    });

    test("rejects noncanonical and symlinked project roots", async () => {
        const { parent, root } = await createProjectRoot();
        const link = path.join(parent, "dashboard-link");
        await symlink(root, link, "dir");

        await expectFilesystemRejection(prepareProtectedProductionStatePath(`${root}/.`));
        await expectFilesystemRejection(prepareProtectedProductionStatePath(link));
    });

    test("rejects a symlinked managed directory", async () => {
        const { parent, root } = await createProjectRoot();
        const target = path.join(parent, "outside");
        await mkdir(target, { mode: 0o700 });
        await symlink(target, path.join(root, "production"), "dir");

        await expectFilesystemRejection(prepareProtectedProductionStatePath(root));
    });

    test("rejects a managed path swap after descriptor validation", async () => {
        const { root } = await createProjectRoot();
        const production = path.join(root, "production");
        const displacedProduction = path.join(root, "displaced-production");
        let replaced = false;

        await expectFilesystemRejection(
            prepareProtectedProductionStatePath(root, {
                afterStage: async (stage, directory) => {
                    if (
                        !replaced &&
                        stage === "managed-directory-prepared" &&
                        directory === production
                    ) {
                        replaced = true;
                        await rename(production, displacedProduction);
                        await mkdir(production, { mode: 0o700 });
                        await chmod(production, 0o700);
                    }
                },
            })
        );
        expect(replaced).toBe(true);
    });

    test("rejects a final managed-child swap before returning its path", async () => {
        const { root } = await createProjectRoot();
        const logs = path.join(root, "production/state/logs");
        const displacedLogs = path.join(root, "production/state/displaced-logs");
        let replaced = false;

        await expectFilesystemRejection(
            prepareProtectedProductionStatePath(root, {
                afterStage: async (stage, directory) => {
                    if (
                        !replaced &&
                        stage === "managed-directory-prepared" &&
                        directory === logs
                    ) {
                        replaced = true;
                        await rename(logs, displacedLogs);
                        await mkdir(logs, { mode: 0o700 });
                        await chmod(logs, 0o700);
                    }
                },
            })
        );
        expect(replaced).toBe(true);
    });

    test("rejects an ancestor identity swap before state creation", async () => {
        const { parent, root } = await createProjectRoot();
        const displacedRoot = path.join(parent, "displaced-dashboard");
        let replaced = false;

        await expectFilesystemRejection(
            prepareProtectedProductionStatePath(root, {
                afterStage: async (stage, directory) => {
                    if (
                        !replaced &&
                        stage === "ancestor-protected" &&
                        directory === root
                    ) {
                        replaced = true;
                        await rename(root, displacedRoot);
                        await mkdir(root, { mode: 0o700 });
                        await chmod(root, 0o700);
                    }
                },
            })
        );
        expect(replaced).toBe(true);
    });
});
