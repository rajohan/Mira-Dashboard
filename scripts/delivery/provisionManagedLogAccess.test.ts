import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ManagedLogManifest } from "../../src/shared/managedLogManifest.ts";
import { provisionManagedLogAccess } from "./provisioning/log-maintenance/provisionManagedLogAccess.ts";

let root: string | undefined;

afterEach(async () => {
    if (root !== undefined) await rm(root, { force: true, recursive: true });
    root = undefined;
});

function manifest(
    filePath: string,
    userId: number,
    groupId: number,
    provisionMissingDirectory = false
): ManagedLogManifest {
    const directoryPath = path.dirname(filePath);
    const anchorPath = provisionMissingDirectory
        ? path.dirname(path.dirname(directoryPath))
        : path.dirname(directoryPath);
    return {
        archiveTargets: [],
        fileTargets: [
            {
                cadenceMs: 1,
                compress: true,
                filePath,
                id: "shared.test",
                maximumSizeBytes: 1024,
                maximumSourceBytes: 2048,
                ...(provisionMissingDirectory
                    ? {
                          provisionedDirectories: path
                              .relative(anchorPath, directoryPath)
                              .split(path.sep)
                              .map((_segment, index, segments) => ({
                                  directoryPath: path.join(
                                      anchorPath,
                                      ...segments.slice(0, index + 1)
                                  ),
                                  groupId,
                                  inheritGroupAccess: index === segments.length - 1,
                                  mode: index === segments.length - 1 ? 0o2770 : 0o750,
                                  ownerId: userId,
                              })),
                          provisioningAnchor: {
                              directoryPath: anchorPath,
                              groupId,
                              mode: 0o700,
                              ownerId: userId,
                          },
                      }
                    : {}),
                retentionAgeMs: 0,
                retentionCount: 1,
                strategy: "copytruncate",
                trustedOwnerIds: [userId],
                trustedWritableGroupId: groupId,
            },
        ],
        lockPath: path.join(path.dirname(filePath), "managed.lock"),
        statePath: path.join(path.dirname(filePath), "managed-state.json"),
    };
}

describe("managed log access provisioning", () => {
    test("preserves source uid and grants manifest-selected group access", async () => {
        root = await mkdtemp(path.join(os.tmpdir(), "managed-log-access-"));
        const directory = path.join(root, "logs");
        const file = path.join(directory, "application.log");
        await mkdir(directory, { mode: 0o755 });
        await writeFile(file, "log\n", { mode: 0o644 });
        const userId = process.getuid?.() ?? 0;
        const groupId = process.getgid?.() ?? 0;
        const defaultAccess: Array<readonly [string, number]> = [];

        await provisionManagedLogAccess(groupId, userId, {
            applyDefaultAccess: (directoryPath, selectedGroupId) => {
                defaultAccess.push([directoryPath, selectedGroupId]);
                return Promise.resolve();
            },
            manifest: manifest(file, userId, groupId),
            requireRoot: () => true,
        });

        const [directoryStatus, fileStatus] = await Promise.all([
            lstat(directory),
            lstat(file),
        ]);
        expect(directoryStatus.uid).toBe(userId);
        expect(directoryStatus.gid).toBe(groupId);
        expect(directoryStatus.mode & 0o7777).toBe(0o2770);
        expect(fileStatus.uid).toBe(userId);
        expect(fileStatus.gid).toBe(groupId);
        expect(fileStatus.mode & 0o7777).toBe(0o660);
        expect(defaultAccess).toHaveLength(1);
        expect(defaultAccess[0]?.[0]).toMatch(/^\/proc\/\d+\/fd\/\d+$/u);
        expect(defaultAccess[0]?.[1]).toBe(groupId);
    });

    test("rejects a manifest target reached through a symlink", async () => {
        root = await mkdtemp(path.join(os.tmpdir(), "managed-log-access-"));
        const actual = path.join(root, "actual");
        const linked = path.join(root, "linked");
        await mkdir(actual, { mode: 0o755 });
        await chmod(actual, 0o755);
        await symlink(actual, linked, "dir");
        const file = path.join(linked, "application.log");
        await writeFile(path.join(actual, "application.log"), "log\n");
        const userId = process.getuid?.() ?? 0;
        const groupId = process.getgid?.() ?? 0;

        expect(
            provisionManagedLogAccess(groupId, userId, {
                applyDefaultAccess: () => Promise.resolve(),
                manifest: manifest(file, userId, groupId),
                requireRoot: () => true,
            })
        ).rejects.toThrow("Managed log access provisioning failed");
    });

    test("creates the complete admitted hierarchy under a trusted anchor", async () => {
        root = await mkdtemp(path.join(os.tmpdir(), "managed-log-access-"));
        const directory = path.join(root, "source", "logs");
        const file = path.join(directory, "application.log");
        const userId = process.getuid?.() ?? 0;
        const groupId = process.getgid?.() ?? 0;
        const defaultAccess: Array<readonly [string, number]> = [];

        await provisionManagedLogAccess(groupId, userId, {
            applyDefaultAccess: (directoryPath, selectedGroupId) => {
                defaultAccess.push([directoryPath, selectedGroupId]);
                return Promise.resolve();
            },
            manifest: manifest(file, userId, groupId, true),
            requireRoot: () => true,
        });

        const directoryStatus = await lstat(directory);
        expect(directoryStatus.uid).toBe(userId);
        expect(directoryStatus.gid).toBe(groupId);
        expect(directoryStatus.mode & 0o7777).toBe(0o2770);
        expect(defaultAccess).toHaveLength(1);
        expect(defaultAccess[0]?.[0]).toMatch(/^\/proc\/\d+\/fd\/\d+$/u);
        expect(defaultAccess[0]?.[1]).toBe(groupId);
        expect(await lstat(file).catch(() => null)).toBeNull();
    });
});
