import { afterAll, describe, expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { provisionManagedContainerLogs } from "./provisioning/log-maintenance/provisionManagedContainerLogs.ts";

const temporaryDirectories: string[] = [];

async function captureFailure(operation: Promise<void>): Promise<Error> {
    try {
        await operation;
    } catch (error) {
        return error as Error;
    }
    throw new Error("Expected managed container log provisioning to fail");
}

async function fixture(): Promise<{
    readonly directoryPath: string;
    readonly filePath: string;
    readonly target: {
        readonly directoryPath: string;
        readonly fileNames: readonly string[];
        readonly ownerIds: readonly number[];
    };
}> {
    const root = await mkdtemp(path.join(os.tmpdir(), "mira-managed-container-logs-"));
    temporaryDirectories.push(root);
    const directoryPath = path.join(root, "logs");
    const filePath = path.join(directoryPath, "app.log");
    await mkdir(directoryPath, { mode: 0o777 });
    await writeFile(filePath, "entry\n", { mode: 0o644 });
    return {
        directoryPath,
        filePath,
        target: {
            directoryPath,
            fileNames: ["app.log", "optional.log"],
            ownerIds: [process.getuid?.() ?? 0],
        },
    };
}

describe("managed container log provisioning", () => {
    test("preserves owners while granting only the maintenance group access", async () => {
        const item = await fixture();
        const initial = await lstat(item.filePath);
        const groupId = process.getgid?.() ?? 0;

        await provisionManagedContainerLogs(groupId, {
            requireRoot: () => true,
            targets: [item.target],
        });

        const [directory, file, created] = await Promise.all([
            lstat(item.directoryPath),
            lstat(item.filePath),
            lstat(path.join(item.directoryPath, "optional.log")),
        ]);
        expect(directory.mode & 0o7777).toBe(0o2770);
        expect(directory.gid).toBe(groupId);
        expect(file.mode & 0o7777).toBe(0o660);
        expect(file.uid).toBe(initial.uid);
        expect(file.gid).toBe(groupId);
        expect(created.mode & 0o7777).toBe(0o660);
        expect(created.uid).toBe(directory.uid);
        expect(created.gid).toBe(groupId);
    });

    test("skips an optional container log directory that does not exist yet", async () => {
        const root = await mkdtemp(
            path.join(os.tmpdir(), "mira-managed-container-logs-missing-")
        );
        temporaryDirectories.push(root);

        const result = await provisionManagedContainerLogs(process.getgid?.() ?? 0, {
            requireRoot: () => true,
            targets: [
                {
                    directoryPath: path.join(root, "missing"),
                    fileNames: ["app.log"],
                    ownerIds: [process.getuid?.() ?? 0],
                },
            ],
        });
        expect(result).toBeUndefined();
    });

    test("rejects a symlink without changing its target", async () => {
        const item = await fixture();
        const external = path.join(path.dirname(item.directoryPath), "external.log");
        await writeFile(external, "external\n", { mode: 0o640 });
        const externalBefore = await lstat(external);
        const externalMode = externalBefore.mode & 0o7777;
        await rm(item.filePath);
        await symlink(external, item.filePath);

        const failure = await captureFailure(
            provisionManagedContainerLogs(process.getgid?.() ?? 0, {
                requireRoot: () => true,
                targets: [item.target],
            })
        );
        expect(failure.message).toBe("Managed container log provisioning failed");
        const externalAfter = await lstat(external);
        expect(externalAfter.mode & 0o7777).toBe(externalMode);
    });

    test("rejects a multiply linked file", async () => {
        const item = await fixture();
        const directoryBefore = await lstat(item.directoryPath);
        await link(item.filePath, path.join(item.directoryPath, "alias.log"));

        const failure = await captureFailure(
            provisionManagedContainerLogs(process.getgid?.() ?? 0, {
                requireRoot: () => true,
                targets: [item.target],
            })
        );
        expect(failure.message).toBe("Managed container log provisioning failed");
        const directoryAfter = await lstat(item.directoryPath);
        expect(directoryAfter.mode & 0o7777).toBe(directoryBefore.mode & 0o7777);
    });

    test("rejects an unexpected owner policy", async () => {
        const item = await fixture();

        const failure = await captureFailure(
            provisionManagedContainerLogs(process.getgid?.() ?? 0, {
                requireRoot: () => true,
                targets: [{ ...item.target, ownerIds: [] }],
            })
        );
        expect(failure.message).toBe("Managed container log provisioning failed");
    });
});

afterAll(async () => {
    for (const directory of temporaryDirectories) {
        await rm(directory, { force: true, recursive: true });
    }
});
