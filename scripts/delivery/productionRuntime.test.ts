import { afterEach, describe, expect, test } from "bun:test";
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionError } from "../testSupport/rejection.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import { productionArtifactCapacityReserveBytes } from "./productionArtifactCapacity.ts";
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
import { installProductionRuntime } from "./productionRuntime.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";
import type { ReleaseRuntimeIdentity } from "./releaseIdentity.ts";

const temporaryDirectories: string[] = [];
const runtimeIdentity: ReleaseRuntimeIdentity = Object.freeze({
    revision: "a".repeat(40),
    version: "1.4.0",
});

function filesystemCapacity(availableBytes: bigint) {
    return Object.freeze({
        availableBytes,
        availableInodes: 1_000_000n,
        blockSize: 4096n,
    });
}

async function restoreOwnerWrite(directory: string): Promise<void> {
    const status = await stat(directory).catch(() => null);
    if (!status?.isDirectory()) return;
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            await restoreOwnerWrite(entryPath);
        } else if (entry.isFile()) {
            await chmod(entryPath, 0o600);
        }
    }
}

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await restoreOwnerWrite(directory);
        await rm(directory, { force: true, recursive: true });
    }
});

async function fixture(): Promise<{
    projectRoot: string;
    sourceExecutable: string;
}> {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "mira-production-runtime-"));
    const sourceRoot = await mkdtemp(
        path.join(tmpdir(), "mira-production-runtime-source-")
    );
    temporaryDirectories.push(projectRoot, sourceRoot);
    const sourceExecutable = path.join(sourceRoot, "bun");
    await writeFile(sourceExecutable, "test-bun-runtime-bytes");
    await chmod(sourceExecutable, 0o500);
    return { projectRoot, sourceExecutable };
}

describe("production Bun runtime", () => {
    test("installs a root-owned runtime from a root-controlled source path", async () => {
        const { projectRoot } = await fixture();
        const sourceExecutable = "/usr/bin/true";
        const sourceStatus = await stat(sourceExecutable);
        expect(sourceStatus.uid).toBe(0);
        const state = await prepareProtectedProductionStatePath(projectRoot);

        const installed = await withDeploymentLease(
            state.stateDirectory,
            async (lease) => {
                const paths = await prepareProductionDeliveryDirectories(state);
                return installProductionRuntime(lease, paths, runtimeIdentity, {
                    probeRuntime: () => Promise.resolve(runtimeIdentity),
                    sourceExecutable,
                });
            }
        );

        const installedStatus = await stat(installed.executable);
        if (typeof process.getuid !== "function") {
            throw new TypeError("POSIX uid support is required by this test");
        }
        expect(installedStatus.uid).toBe(process.getuid());
        expect(installedStatus.mode & 0o777).toBe(0o500);
    });

    test("installs one immutable exact runtime idempotently inside production", async () => {
        const { projectRoot, sourceExecutable } = await fixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        const probes: string[] = [];
        const dependencies = {
            probeRuntime(executable: string) {
                probes.push(executable);
                return Promise.resolve(runtimeIdentity);
            },
            sourceExecutable,
        };
        const first = await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const runtime = await installProductionRuntime(
                lease,
                paths,
                runtimeIdentity,
                dependencies
            );
            return { paths, runtime };
        });
        const second = await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            return installProductionRuntime(lease, paths, runtimeIdentity, dependencies);
        });

        expect(first.runtime.executable).toBe(
            path.join(
                first.paths.runtimesDirectory,
                "bun",
                runtimeIdentity.revision,
                "bun"
            )
        );
        expect(second).toEqual(first.runtime);
        const executableStatus = await stat(first.runtime.executable);
        const revisionStatus = await stat(path.dirname(first.runtime.executable));
        expect(executableStatus.mode & 0o777).toBe(0o500);
        expect(revisionStatus.mode & 0o777).toBe(0o500);
        expect(probes).toContain(sourceExecutable);
        expect(probes).toContain(first.runtime.executable);
    });

    test("rejects copied-byte tampering and removes its owned stage", async () => {
        const { projectRoot, sourceExecutable } = await fixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        const result = await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const failure = await rejectionError(
                installProductionRuntime(lease, paths, runtimeIdentity, {
                    afterCopy: (destination) => writeFile(destination, "tampered"),
                    probeRuntime: () => Promise.resolve(runtimeIdentity),
                    sourceExecutable,
                })
            );
            return { failure, paths };
        });

        expect(result.failure.message).toBe("Production Bun runtime installation failed");
        const bunRoot = path.join(result.paths.runtimesDirectory, "bun");
        expect(await readdir(bunRoot)).toEqual([]);
    });

    test("re-admits a replacement source size after probing and before copying", async () => {
        const { projectRoot, sourceExecutable } = await fixture();
        const originalBytes = BigInt("test-bun-runtime-bytes".length);
        const movedSource = `${sourceExecutable}.admitted`;
        const state = await prepareProtectedProductionStatePath(projectRoot);
        const result = await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            let capacityChecks = 0;
            const failure = await rejectionError(
                installProductionRuntime(lease, paths, runtimeIdentity, {
                    availableCapacity: () => {
                        capacityChecks += 1;
                        return Promise.resolve(
                            filesystemCapacity(
                                productionArtifactCapacityReserveBytes + originalBytes
                            )
                        );
                    },
                    beforeCopy: async () => {
                        await rename(sourceExecutable, movedSource);
                        await writeFile(
                            sourceExecutable,
                            Buffer.alloc(Number(originalBytes + 1n), 1),
                            { mode: 0o500 }
                        );
                        await chmod(sourceExecutable, 0o500);
                    },
                    probeRuntime: () => Promise.resolve(runtimeIdentity),
                    sourceExecutable,
                })
            );
            return { capacityChecks, failure, paths };
        });

        expect(result.failure.message).toBe("Production Bun runtime installation failed");
        expect(result.capacityChecks).toBe(1);
        expect(await readdir(path.join(result.paths.runtimesDirectory, "bun"))).toEqual(
            []
        );
    });

    test("never replaces a pre-existing runtime revision directory", async () => {
        const { projectRoot, sourceExecutable } = await fixture();
        const state = await prepareProtectedProductionStatePath(projectRoot);
        const result = await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            const bunRoot = path.join(paths.runtimesDirectory, "bun");
            const existing = path.join(bunRoot, runtimeIdentity.revision);
            await mkdir(bunRoot, { mode: 0o700 });
            await mkdir(existing, { mode: 0o500 });
            const failure = await rejectionError(
                installProductionRuntime(lease, paths, runtimeIdentity, {
                    probeRuntime: () => Promise.resolve(runtimeIdentity),
                    sourceExecutable,
                })
            );
            return { existing, failure };
        });

        expect(result.failure.message).toBe("Production Bun runtime installation failed");
        const existingStatus = await stat(result.existing);
        expect(existingStatus.isDirectory()).toBeTrue();
    });
});
