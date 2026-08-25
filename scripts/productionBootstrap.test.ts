import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { maximumProductionReleaseArchiveBytes } from "../src/shared/productionReleaseArtifactReceipt.ts";
import { packageProductionReleaseArtifact } from "./delivery/packageProductionReleaseArtifact.ts";
import {
    assertProductionReleaseArchiveListing,
    maximumProductionReleaseArchiveListingBytes,
} from "./delivery/productionReleaseArchive.ts";
import { productionHostProvisioningRoot } from "./delivery/provisioning/host-operations/policy.ts";
import {
    admitProductionBootstrapRelease,
    bootstrapProduction,
    deployProduction,
    downloadProductionBootstrapRelease,
    parseProductionBootstrapRelease,
    productionBootstrapTestSupport,
    resolveProductionBootstrapSourceIdentity,
    stageProductionBootstrapRootAuthority,
    verifyProductionBootstrapPrerequisites,
    type ProductionBootstrapDependencies,
} from "./productionBootstrap.ts";
import {
    createLocalReleaseFixture,
    removeProductionDeliveryFixtures,
} from "./testSupport/productionDeliveryFixture.ts";

const releaseId = "a".repeat(40);
const sourceProjectRoot = path.resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

afterEach(() => removeProductionDeliveryFixtures(temporaryDirectories));

const realProcessDependencies: ProductionBootstrapDependencies = {
    run: async (command, cwd) => {
        const child = Bun.spawn([...command], {
            cwd,
            stderr: "ignore",
            stdout: "pipe",
        });
        const [exitCode, stdout] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
        ]);
        return { exitCode, stdout };
    },
};

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
    try {
        await operation;
        return undefined;
    } catch (error) {
        return error;
    }
}

describe("production bootstrap admission", () => {
    test("accepts only a GitHub release for the exact clean checkout", () => {
        expect(
            parseProductionBootstrapRelease({ tagName: "v0.2.0" }, releaseId, releaseId)
        ).toBe("v0.2.0");
        expect(() =>
            parseProductionBootstrapRelease(
                { tagName: "v0.2.0" },
                "b".repeat(40),
                releaseId
            )
        ).toThrow("Production bootstrap failed");
        expect(() =>
            parseProductionBootstrapRelease({ tagName: "v0.2.0" }, "main", releaseId)
        ).toThrow();
    });

    test("accepts only archive entries below the exact release directory", () => {
        expect(maximumProductionReleaseArchiveListingBytes).toBe(
            (4096 + 512) * (41 + 4096 + 1)
        );
        expect(() =>
            assertProductionReleaseArchiveListing(
                `${releaseId}/\n${releaseId}/release-manifest.json\n`,
                releaseId
            )
        ).not.toThrow();
        for (const listing of [
            "",
            "/etc/systemd/system/escape.service\n",
            `${releaseId}/../escape\n`,
            `${"b".repeat(40)}/release-manifest.json\n`,
        ]) {
            expect(() =>
                assertProductionReleaseArchiveListing(listing, releaseId)
            ).toThrow("Production release archive is invalid");
        }
        const maximumValidListing = Array.from(
            { length: 4096 + 512 },
            (_, index) => `${releaseId}/entry-${index}`
        ).join("\n");
        expect(() =>
            assertProductionReleaseArchiveListing(maximumValidListing, releaseId)
        ).not.toThrow();
        expect(() =>
            assertProductionReleaseArchiveListing(
                `${maximumValidListing}\n${releaseId}/overflow`,
                releaseId
            )
        ).toThrow("Production release archive is invalid");
    });

    test("resolves only clean exact main from the expected checkout", async () => {
        const commands: string[] = [];
        const dependencies: ProductionBootstrapDependencies = {
            run: (command) => {
                commands.push(command.join(" "));
                const invocation = command.join(" ");
                let stdout = `${releaseId}\n`;
                if (invocation.endsWith("branch --show-current")) stdout = "main\n";
                if (invocation.endsWith("status --porcelain=v1")) stdout = "";
                if (invocation.endsWith("remote get-url origin")) {
                    stdout = "https://github.com/rajohan/Mira-Dashboard.git\n";
                }
                return Promise.resolve({ exitCode: 0, stdout });
            },
        };
        expect(
            await resolveProductionBootstrapSourceIdentity(
                dependencies,
                sourceProjectRoot,
                sourceProjectRoot,
                1000
            )
        ).toBe(releaseId);
        expect(commands).toHaveLength(6);
        expect(commands[0]).toBe("/usr/bin/git remote get-url origin");
        expect(commands[1]).toBe("/usr/bin/git fetch --quiet --no-tags origin main");
        expect(
            resolveProductionBootstrapSourceIdentity(
                dependencies,
                sourceProjectRoot,
                sourceProjectRoot,
                0
            )
        ).rejects.toThrow("managed non-root user");
    });

    test("downloads only release assets whose tag resolves to the checkout", async () => {
        const commands: string[] = [];
        const downloads: string[] = [];
        const dependencies: ProductionBootstrapDependencies = {
            download: (command, target, maximumBytes, expectedBytes, cwd) => {
                downloads.push(
                    [command.join(" "), target, maximumBytes, expectedBytes, cwd].join(
                        " | "
                    )
                );
                return Promise.resolve();
            },
            run: (command) => {
                commands.push(command.join(" "));
                const invocation = command.join(" ");
                let stdout = "";
                if (invocation.includes(" release view ")) {
                    stdout = JSON.stringify({
                        assets: [
                            {
                                apiUrl: "https://api.github.com/repos/rajohan/Mira-Dashboard/releases/assets/1",
                                name: "receipt.json",
                                size: 433,
                            },
                            {
                                apiUrl: "https://api.github.com/repos/rajohan/Mira-Dashboard/releases/assets/2",
                                name: "release.tar",
                                size: 1024,
                            },
                        ],
                        tagName: "v0.2.0",
                    });
                }
                if (invocation.includes(" rev-list ")) stdout = `${releaseId}\n`;
                return Promise.resolve({ exitCode: 0, stdout });
            },
        };
        expect(
            await downloadProductionBootstrapRelease(
                releaseId,
                "/tmp/artifact",
                dependencies,
                sourceProjectRoot,
                "v0.2.0"
            )
        ).toEqual({ artifactRoot: "/tmp/artifact", tagName: "v0.2.0" });
        expect(commands.some((command) => command.includes(" fetch --force "))).toBe(
            true
        );
        expect(commands).toContain(
            "/usr/bin/gh release view v0.2.0 --repo=rajohan/Mira-Dashboard --json=assets,tagName"
        );
        expect(downloads).toHaveLength(2);
        expect(downloads[0]).toContain("application/octet-stream");
        expect(downloads[1]).toContain(
            `release.tar | ${maximumProductionReleaseArchiveBytes} | 1024`
        );
    });

    test("bounds release bytes while writing and projects private GitHub auth", async () => {
        const targetRoot = await mkdtemp(
            path.join(tmpdir(), "mira-production-download-")
        );
        temporaryDirectories.push(targetRoot);
        const admitted = path.join(targetRoot, "admitted");
        await productionBootstrapTestSupport.download(
            ["/usr/bin/printf", "1234"],
            admitted,
            4,
            4,
            sourceProjectRoot
        );
        expect(await readFile(admitted, "utf8")).toBe("1234");
        expect(
            productionBootstrapTestSupport.download(
                ["/usr/bin/printf", "12345"],
                path.join(targetRoot, "oversized"),
                4,
                4,
                sourceProjectRoot
            )
        ).rejects.toThrow("Production bootstrap failed");

        const previous = process.env.MIRA_GITHUB_TOKEN;
        process.env.MIRA_GITHUB_TOKEN = "github-token-sentinel";
        try {
            const environment = productionBootstrapTestSupport.environment();
            expect(environment.GH_TOKEN).toBe("github-token-sentinel");
            expect(environment.GIT_CONFIG_KEY_0).toBe(
                "http.https://github.com/.extraheader"
            );
            expect(environment.GIT_CONFIG_VALUE_0).toStartWith("AUTHORIZATION: basic ");
            expect(environment.GIT_CONFIG_VALUE_0).not.toContain("github-token-sentinel");
        } finally {
            if (previous === undefined) delete process.env.MIRA_GITHUB_TOKEN;
            else process.env.MIRA_GITHUB_TOKEN = previous;
        }
    });

    test("rejects command output while it is still streaming", async () => {
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>({
            cancel: () => {
                cancelled = true;
            },
            start: (controller) => {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.enqueue(new Uint8Array([4, 5, 6]));
            },
        });

        const failure = await captureFailure(
            productionBootstrapTestSupport.readBounded(stream, 5)
        );
        expect(failure).toEqual(new Error("Production bootstrap failed"));
        expect(cancelled).toBe(true);
    });

    test("binds clean-host prerequisites to root-owned runtime bytes", async () => {
        const runtimeBytes = new TextEncoder().encode("qualified-runtime");
        const dependencies: ProductionBootstrapDependencies = {
            run: (command) =>
                Promise.resolve({
                    exitCode: 0,
                    stdout: command.includes("/usr/bin/tailscale")
                        ? '{"BackendState":"Running","Self":{"Online":true}}\n'
                        : "ready\n",
                }),
        };
        const result = await verifyProductionBootstrapPrerequisites(
            dependencies,
            "/srv/dashboard",
            1000,
            {
                canonical: (target) => {
                    if (
                        target.startsWith("/home/ubuntu/.openclaw") ||
                        target.startsWith("/home/ubuntu/.doppler")
                    ) {
                        return Promise.resolve(target);
                    }
                    return Promise.resolve("/usr/local/bin/bun");
                },
                read: () => Promise.resolve(runtimeBytes),
                status: (target) => {
                    const runtimeControlled =
                        target === "/" ||
                        target === "/usr" ||
                        target === "/usr/local" ||
                        target === "/usr/local/bin" ||
                        target === "/usr/local/bin/bun";
                    let mode = 0o700;
                    if (target === "/usr/local/bin/bun") mode = 0o755;
                    if (runtimeControlled && target !== "/usr/local/bin/bun") {
                        mode = 0o755;
                    }
                    if (target.endsWith(".doppler.yaml")) mode = 0o600;
                    return Promise.resolve({
                        gid: runtimeControlled ? 0 : 1000,
                        isDirectory: () =>
                            target === "/home/ubuntu/.openclaw" ||
                            target === "/home/ubuntu/.openclaw/workspace" ||
                            target === "/home/ubuntu/.doppler" ||
                            (runtimeControlled && target !== "/usr/local/bin/bun"),
                        isFile: () =>
                            target === "/usr/local/bin/bun" ||
                            target === "/home/ubuntu/.doppler/.doppler.yaml",
                        mode,
                        nlink: 1,
                        uid: runtimeControlled ? 0 : 1000,
                    });
                },
            },
            1000
        );

        expect(result.runtimeSha256).toBe(
            new Bun.CryptoHasher("sha256").update(runtimeBytes).digest("hex")
        );
    });

    test("rejects invalid Doppler state before root provisioning", async () => {
        const commands: string[][] = [];
        const failure = await captureFailure(
            verifyProductionBootstrapPrerequisites(
                {
                    run: (command) => {
                        commands.push([...command]);
                        return Promise.resolve({
                            exitCode: 0,
                            stdout: command.includes("/usr/bin/tailscale")
                                ? '{"BackendState":"Running","Self":{"Online":true}}\n'
                                : "ready\n",
                        });
                    },
                },
                "/srv/dashboard",
                1000,
                {
                    canonical: (target) =>
                        Promise.resolve(
                            target === process.execPath ? "/usr/local/bin/bun" : target
                        ),
                    read: () => Promise.resolve(new Uint8Array([1])),
                    status: (target) => {
                        let mode = 0o700;
                        if (target === "/usr/local/bin/bun") mode = 0o755;
                        if (target.endsWith(".doppler.yaml")) mode = 0o640;
                        return Promise.resolve({
                            gid: target === "/usr/local/bin/bun" ? 0 : 1000,
                            isDirectory: () =>
                                target === "/home/ubuntu/.openclaw" ||
                                target === "/home/ubuntu/.doppler",
                            isFile: () =>
                                target === "/usr/local/bin/bun" ||
                                target === "/home/ubuntu/.doppler/.doppler.yaml",
                            mode,
                            nlink: 1,
                            uid: target === "/usr/local/bin/bun" ? 0 : 1000,
                        });
                    },
                },
                1000
            )
        );

        expect(failure).toEqual(new Error("Production bootstrap failed"));
        expect(commands.some((command) => command[0] === "/usr/bin/sudo")).toBe(false);
    });

    test("rejects an offline Tailscale host before filesystem admission", async () => {
        const commands: string[][] = [];
        const failure = await captureFailure(
            verifyProductionBootstrapPrerequisites(
                {
                    run: (command) => {
                        commands.push([...command]);
                        return Promise.resolve({
                            exitCode: 0,
                            stdout: command.includes("/usr/bin/tailscale")
                                ? '{"BackendState":"NeedsLogin","Self":{"Online":false}}\n'
                                : "ready\n",
                        });
                    },
                },
                "/srv/dashboard",
                1000
            )
        );

        expect(failure).toBeInstanceOf(Error);
        expect(commands.some((command) => command[0] === "/usr/bin/sudo")).toBe(false);
    });

    test("admits a real packaged release and extracts it immutably", async () => {
        const runtime = { revision: "b".repeat(40), version: Bun.version };
        const releaseRoot = await createLocalReleaseFixture(
            sourceProjectRoot,
            releaseId,
            runtime,
            temporaryDirectories
        );
        const repositoryRoot = path.resolve(releaseRoot, "../../..");
        const receipt = await packageProductionReleaseArtifact({
            projectRoot: repositoryRoot,
            releaseId,
        });
        const targetRepositoryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-production-bootstrap-target-")
        );
        temporaryDirectories.push(targetRepositoryRoot);
        const targetArtifactRoot = path.join(
            targetRepositoryRoot,
            "dist/production-release-artifact"
        );
        await Promise.all([
            cp(
                path.join(repositoryRoot, "dist/production-release-artifact"),
                targetArtifactRoot,
                { recursive: true }
            ),
            cp(
                path.join(sourceProjectRoot, ".bun-version"),
                path.join(targetRepositoryRoot, ".bun-version")
            ),
        ]);

        const listingBudgets: number[] = [];
        const boundedProcessDependencies: ProductionBootstrapDependencies = {
            run: (command, cwd, stdoutMaximumBytes) => {
                if (command[0] === "/usr/bin/tar" && command[1] === "-tf") {
                    listingBudgets.push(stdoutMaximumBytes ?? 0);
                }
                return realProcessDependencies.run(command, cwd, stdoutMaximumBytes);
            },
        };
        const admitted = await admitProductionBootstrapRelease(
            targetArtifactRoot,
            releaseId,
            boundedProcessDependencies,
            targetRepositoryRoot
        );

        expect(admitted.releaseRoot).toBe(
            path.join(targetRepositoryRoot, "dist/releases", releaseId)
        );
        expect(admitted.manifestSha256).toBe(receipt.releaseManifestSha256);

        const readmitted = await admitProductionBootstrapRelease(
            targetArtifactRoot,
            releaseId,
            boundedProcessDependencies,
            targetRepositoryRoot
        );
        expect(readmitted.manifestSha256).toBe(receipt.releaseManifestSha256);
        expect(listingBudgets).toEqual([
            maximumProductionReleaseArchiveListingBytes,
            maximumProductionReleaseArchiveListingBytes,
        ]);
    });

    test("stages every fixed root authority command without shell interpretation", async () => {
        const commands: string[][] = [];
        let groupLookupCount = 0;
        let maintenanceGroupLine = "";
        const dependencies: ProductionBootstrapDependencies = {
            run: (command) => {
                commands.push([...command]);
                let stdout = "";
                if (command.includes("/usr/bin/sha256sum")) {
                    stdout = command.at(-1)?.endsWith("/bun")
                        ? `${"e".repeat(64)}  bun\n`
                        : `${"d".repeat(64)}  release.tar\n`;
                }
                const isNamedGroupLookup =
                    command[0] === "/usr/bin/getent" &&
                    command[1] === "group" &&
                    command.length === 3;
                const isGroupInventory =
                    command[0] === "/usr/bin/getent" &&
                    command[1] === "group" &&
                    command.length === 2;
                if (isNamedGroupLookup) {
                    groupLookupCount += 1;
                    if (groupLookupCount === 2) {
                        maintenanceGroupLine = "mira-dashboard-log-maintenance:x:986:\n";
                    } else if (groupLookupCount === 3) {
                        maintenanceGroupLine =
                            "mira-dashboard-log-maintenance:x:986:ubuntu\n";
                    }
                    stdout = maintenanceGroupLine;
                } else if (isGroupInventory) {
                    stdout = maintenanceGroupLine;
                }
                return Promise.resolve({
                    exitCode: isNamedGroupLookup && groupLookupCount === 1 ? 2 : 0,
                    stdout,
                });
            },
        };

        await stageProductionBootstrapRootAuthority(
            "/tmp/artifact",
            releaseId,
            "c".repeat(64),
            "d".repeat(64),
            "e".repeat(64),
            1000,
            dependencies
        );

        expect(
            commands.some((command) =>
                command.some((argument) => argument.endsWith("/groupadd"))
            )
        ).toBe(true);
        expect(
            commands.some(
                (command) =>
                    command.includes("/usr/bin/install") &&
                    command.some((argument) => argument.includes("/.pair-stage-")) &&
                    command.every((argument) => !argument.includes("/pairs/.pair-stage-"))
            )
        ).toBe(true);
        const runtimeInstallIndex = commands.findIndex(
            (command) =>
                command.includes("/usr/bin/install") &&
                command.some((argument) => argument.endsWith("/runtime/bun")) &&
                command.at(-1)?.includes("/.pair-stage-") === true
        );
        const releaseSyncIndex = commands.findIndex(
            (command) =>
                command.includes("/usr/bin/sync") &&
                command.at(-1)?.endsWith(`/releases/${releaseId}`) === true
        );
        const releasesParentSyncIndex = commands.findIndex(
            (command) =>
                command.includes("/usr/bin/sync") &&
                command.at(-1)?.endsWith("/releases") === true
        );
        const pairMoveIndex = commands.findIndex(
            (command) => command.includes("/usr/bin/mv") && command.includes("-T")
        );
        const pairSyncIndex = commands.findIndex(
            (command) =>
                command.includes("/usr/bin/sync") &&
                command.at(-1)?.endsWith(`/pairs/${releaseId}`) === true
        );
        const selectorMoveIndex = commands.findIndex(
            (command) => command.includes("/usr/bin/mv") && command.includes("-Tf")
        );
        const selectorSyncIndex = commands.findIndex(
            (command) =>
                command.includes("/usr/bin/sync") &&
                command.at(-1) === productionHostProvisioningRoot
        );
        expect(runtimeInstallIndex).toBeGreaterThanOrEqual(0);
        expect(releaseSyncIndex).toBeGreaterThanOrEqual(0);
        expect(releasesParentSyncIndex).toBeGreaterThan(releaseSyncIndex);
        expect(runtimeInstallIndex).toBeGreaterThan(releasesParentSyncIndex);
        expect(pairSyncIndex).toBeGreaterThan(pairMoveIndex);
        expect(selectorMoveIndex).toBeGreaterThan(pairSyncIndex);
        expect(selectorSyncIndex).toBeGreaterThan(selectorMoveIndex);
        const archiveRemovalIndexes = commands
            .map((command, index) =>
                command.includes("/usr/bin/rm") &&
                command.includes("-f") &&
                command.at(-1)?.endsWith("/release.tar") === true
                    ? index
                    : -1
            )
            .filter((index) => index >= 0);
        expect(archiveRemovalIndexes).toHaveLength(2);
        expect(archiveRemovalIndexes[0]).toBeLessThan(runtimeInstallIndex);
        expect(
            commands.some((command) =>
                command.some((argument) => argument.endsWith("/usermod"))
            )
        ).toBe(true);
        expect(
            commands.some(
                (command) =>
                    command.some((argument) =>
                        argument.endsWith("migrateManagedApplicationLogs.ts")
                    ) && command.includes("--user-id=1000")
            )
        ).toBe(true);
        expect(
            commands.some(
                (command) =>
                    command.includes("/usr/bin/systemd-tmpfiles") &&
                    command.includes(
                        "/usr/lib/tmpfiles.d/mira-dashboard-managed-container-logs.conf"
                    )
            )
        ).toBe(true);
        expect(
            commands.some((command) =>
                command.some((argument) =>
                    argument.endsWith("installHostOperationsProvisioning.ts")
                )
            )
        ).toBe(true);
        expect(
            commands.some(
                (command) =>
                    command.includes("/usr/bin/tar") &&
                    command.includes("--no-same-owner")
            )
        ).toBe(true);
        expect(commands.some((command) => command.includes("--mode=apply"))).toBe(true);
    });

    test("rejects unexpected maintenance-group members", async () => {
        const commands: string[][] = [];
        const failure = await captureFailure(
            stageProductionBootstrapRootAuthority(
                "/tmp/artifact",
                releaseId,
                "c".repeat(64),
                "d".repeat(64),
                "e".repeat(64),
                1000,
                {
                    run: (command) => {
                        commands.push([...command]);
                        if (command.includes("/usr/bin/sha256sum")) {
                            return Promise.resolve({
                                exitCode: 0,
                                stdout: command.at(-1)?.endsWith("/bun")
                                    ? `${"e".repeat(64)}  bun\n`
                                    : `${"d".repeat(64)}  release.tar\n`,
                            });
                        }
                        if (command[0] === "/usr/bin/getent") {
                            return Promise.resolve({
                                exitCode: 0,
                                stdout: "mira-dashboard-log-maintenance:x:986:mira-dashboard-web\n",
                            });
                        }
                        return Promise.resolve({ exitCode: 0, stdout: "" });
                    },
                }
            )
        );

        expect(failure).toEqual(new Error("Production bootstrap failed"));
        expect(
            commands.some((command) =>
                command.includes(
                    "/usr/lib/tmpfiles.d/mira-dashboard-managed-container-logs.conf"
                )
            )
        ).toBe(false);
        expect(commands.some((command) => command.includes("/usr/sbin/usermod"))).toBe(
            false
        );
    });

    test("rejects a privileged maintenance-group id", async () => {
        const commands: string[][] = [];
        const failure = await captureFailure(
            stageProductionBootstrapRootAuthority(
                "/tmp/artifact",
                releaseId,
                "c".repeat(64),
                "d".repeat(64),
                "e".repeat(64),
                1000,
                {
                    run: (command) => {
                        commands.push([...command]);
                        if (command.includes("/usr/bin/sha256sum")) {
                            return Promise.resolve({
                                exitCode: 0,
                                stdout: command.at(-1)?.endsWith("/bun")
                                    ? `${"e".repeat(64)}  bun\n`
                                    : `${"d".repeat(64)}  release.tar\n`,
                            });
                        }
                        if (command[0] === "/usr/bin/getent") {
                            return Promise.resolve({
                                exitCode: 0,
                                stdout: "mira-dashboard-log-maintenance:x:0:\n",
                            });
                        }
                        return Promise.resolve({ exitCode: 0, stdout: "" });
                    },
                }
            )
        );

        expect(failure).toEqual(new Error("Production bootstrap failed"));
        expect(commands.some((command) => command.includes("/usr/sbin/usermod"))).toBe(
            false
        );
    });

    test("rejects an aliased maintenance-group id", async () => {
        const commands: string[][] = [];
        const failure = await captureFailure(
            stageProductionBootstrapRootAuthority(
                "/tmp/artifact",
                releaseId,
                "c".repeat(64),
                "d".repeat(64),
                "e".repeat(64),
                1000,
                {
                    run: (command) => {
                        commands.push([...command]);
                        if (command.includes("/usr/bin/sha256sum")) {
                            return Promise.resolve({
                                exitCode: 0,
                                stdout: command.at(-1)?.endsWith("/bun")
                                    ? `${"e".repeat(64)}  bun\n`
                                    : `${"d".repeat(64)}  release.tar\n`,
                            });
                        }
                        if (command[0] === "/usr/bin/getent" && command.length === 3) {
                            return Promise.resolve({
                                exitCode: 0,
                                stdout: "mira-dashboard-log-maintenance:x:986:\n",
                            });
                        }
                        if (command[0] === "/usr/bin/getent") {
                            return Promise.resolve({
                                exitCode: 0,
                                stdout: "mira-dashboard-log-maintenance:x:986:\nprivileged-alias:x:986:\n",
                            });
                        }
                        return Promise.resolve({ exitCode: 0, stdout: "" });
                    },
                }
            )
        );

        expect(failure).toEqual(new Error("Production bootstrap failed"));
        expect(commands.some((command) => command.includes("/usr/sbin/usermod"))).toBe(
            false
        );
    });

    test("stops before root execution when staged bytes do not match", async () => {
        const commands: string[][] = [];
        const failure = await captureFailure(
            stageProductionBootstrapRootAuthority(
                "/tmp/artifact",
                releaseId,
                "c".repeat(64),
                "d".repeat(64),
                "e".repeat(64),
                1000,
                {
                    run: (command) => {
                        commands.push([...command]);
                        return Promise.resolve({
                            exitCode: 0,
                            stdout: command.includes("/usr/bin/sha256sum")
                                ? `${"f".repeat(64)}  staged\n`
                                : "",
                        });
                    },
                }
            )
        );
        expect(failure).toEqual(new Error("Production bootstrap failed"));
        expect(
            commands.some((command) =>
                command.some((argument) =>
                    argument.endsWith("installHostOperationsProvisioning.ts")
                )
            )
        ).toBe(false);
        expect(
            commands.some(
                (command) =>
                    command.includes("/usr/bin/rm") &&
                    command.includes("-f") &&
                    command.at(-1)?.endsWith("/release.tar") === true
            )
        ).toBe(true);
    });

    test("rejects a changed archive after the runtime handoff succeeds", async () => {
        const commands: string[][] = [];
        const failure = await captureFailure(
            stageProductionBootstrapRootAuthority(
                "/tmp/artifact",
                releaseId,
                "c".repeat(64),
                "d".repeat(64),
                "e".repeat(64),
                1000,
                {
                    run: (command) => {
                        commands.push([...command]);
                        const stagedRuntime = command.at(-1)?.endsWith("/bun");
                        return Promise.resolve({
                            exitCode: 0,
                            stdout: command.includes("/usr/bin/sha256sum")
                                ? `${(stagedRuntime ? "e" : "f").repeat(64)}  staged\n`
                                : "",
                        });
                    },
                }
            )
        );
        expect(failure).toEqual(new Error("Production bootstrap failed"));
        expect(
            commands.some((command) =>
                command.some((argument) =>
                    argument.endsWith("installHostOperationsProvisioning.ts")
                )
            )
        ).toBe(false);
    });

    test("runs the complete clean-host bootstrap sequence", async () => {
        const runtime = { revision: "d".repeat(40), version: Bun.version };
        const sourceReleaseRoot = await createLocalReleaseFixture(
            sourceProjectRoot,
            releaseId,
            runtime,
            temporaryDirectories
        );
        const sourceRepositoryRoot = path.resolve(sourceReleaseRoot, "../../..");
        const receipt = await packageProductionReleaseArtifact({
            projectRoot: sourceRepositoryRoot,
            releaseId,
        });
        const releaseRuntimeSha256 = new Bun.CryptoHasher("sha256")
            .update(await readFile(path.join(sourceReleaseRoot, "runtime/bun")))
            .digest("hex");
        const targetRepositoryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-production-bootstrap-composition-")
        );
        temporaryDirectories.push(targetRepositoryRoot);
        await cp(
            path.join(sourceProjectRoot, ".bun-version"),
            path.join(targetRepositoryRoot, ".bun-version")
        );
        let artifactSequence = 0;
        const createTemporaryRoot = async () => {
            const artifactRoot = path.join(
                targetRepositoryRoot,
                `download-${String((artifactSequence += 1))}`
            );
            await cp(
                path.join(sourceRepositoryRoot, "dist/production-release-artifact"),
                artifactRoot,
                { recursive: true }
            );
            return artifactRoot;
        };
        const commands: string[] = [];
        const prepareStateWorkingDirectories: string[] = [];
        let prerequisitesInspected = false;
        let manualDeployDelivered = false;
        let provisioningBoundaryAvailable = false;
        let preparationCapacityAdmitted = false;
        let groupLookupCount = 0;
        let maintenanceGroupLine = "";
        const dependencies: ProductionBootstrapDependencies = {
            download: () => {
                expect(preparationCapacityAdmitted).toBeTrue();
                return Promise.resolve();
            },
            deliverPublishedRelease: async (prepare) => {
                const admitted = await prepare();
                expect(admitted.releaseId).toBe(releaseId);
                expect(admitted.authority.runtime).toEqual(runtime);
                manualDeployDelivered = true;
            },
            inspectPrerequisites: () => {
                prerequisitesInspected = true;
                return Promise.resolve({ runtimeSha256: "e".repeat(64) });
            },
            preparationCapacityAdmission: (checkoutRoot, hostDirectory) => {
                expect(checkoutRoot).toBe(targetRepositoryRoot);
                expect(hostDirectory).toBe("/var/lib");
                preparationCapacityAdmitted = true;
                return Promise.resolve();
            },
            run: async (command, cwd) => {
                const invocation = command.join(" ");
                commands.push(invocation);
                if (invocation.includes("prepareProductionState.js")) {
                    prepareStateWorkingDirectories.push(cwd ?? "");
                }
                if (command[0] === "/usr/bin/tar") {
                    return realProcessDependencies.run(command, cwd);
                }
                if (invocation.includes(" branch --show-current")) {
                    return { exitCode: 0, stdout: "main\n" };
                }
                if (invocation.includes(" rev-parse ")) {
                    return { exitCode: 0, stdout: `${releaseId}\n` };
                }
                if (invocation.includes(" status --porcelain")) {
                    return { exitCode: 0, stdout: "" };
                }
                if (invocation.includes(" remote get-url origin")) {
                    return {
                        exitCode: 0,
                        stdout: "https://github.com/rajohan/Mira-Dashboard.git\n",
                    };
                }
                if (invocation.includes(" release view ")) {
                    return {
                        exitCode: 0,
                        stdout: JSON.stringify({
                            assets: [
                                {
                                    apiUrl: "https://api.github.com/repos/rajohan/Mira-Dashboard/releases/assets/1",
                                    name: "receipt.json",
                                    size: 433,
                                },
                                {
                                    apiUrl: "https://api.github.com/repos/rajohan/Mira-Dashboard/releases/assets/2",
                                    name: "release.tar",
                                    size: receipt.archive.bytes,
                                },
                            ],
                            tagName: "v0.2.0",
                        }),
                    };
                }
                if (invocation.includes(" rev-list ")) {
                    return { exitCode: 0, stdout: `${releaseId}\n` };
                }
                if (
                    invocation ===
                    "/usr/bin/systemctl cat mira-dashboard-production-provisioning@.service"
                ) {
                    return {
                        exitCode: provisioningBoundaryAvailable ? 0 : 1,
                        stdout: "",
                    };
                }
                if (invocation.includes("sha256sum")) {
                    return {
                        exitCode: 0,
                        stdout: command.at(-1)?.endsWith("/bun")
                            ? `${releaseRuntimeSha256}  bun\n`
                            : `${receipt.archive.sha256}  release.tar\n`,
                    };
                }
                if (
                    command[0] === "/usr/bin/getent" &&
                    command.at(-1) === "mira-dashboard-log-maintenance"
                ) {
                    groupLookupCount += 1;
                    if (groupLookupCount === 1) {
                        return { exitCode: 2, stdout: "" };
                    }
                    maintenanceGroupLine =
                        groupLookupCount === 2
                            ? "mira-dashboard-log-maintenance:x:986:\n"
                            : "mira-dashboard-log-maintenance:x:986:ubuntu\n";
                    return { exitCode: 0, stdout: maintenanceGroupLine };
                }
                if (
                    command[0] === "/usr/bin/getent" &&
                    command[1] === "group" &&
                    command.length === 2
                ) {
                    return { exitCode: 0, stdout: maintenanceGroupLine };
                }
                return { exitCode: 0, stdout: "" };
            },
        };

        await bootstrapProduction(dependencies, {
            createTemporaryRoot,
            expectedCheckout: targetRepositoryRoot,
            repositoryRoot: targetRepositoryRoot,
            userId: 1000,
        });

        expect(prerequisitesInspected).toBe(true);
        expect(preparationCapacityAdmitted).toBe(true);
        expect(
            commands.some((command) => command.includes("prepareProductionState.js"))
        ).toBe(true);
        const admittedReleaseRoot = path.join(
            targetRepositoryRoot,
            "dist/releases",
            releaseId
        );
        expect(prepareStateWorkingDirectories).toEqual([admittedReleaseRoot]);
        expect(
            commands.findIndex((command) =>
                command.startsWith(
                    `${admittedReleaseRoot}/runtime/bun ${admittedReleaseRoot}/server/prepareProductionState.js`
                )
            )
        ).toBeLessThan(
            commands.findIndex((command) =>
                command.includes("migrateManagedApplicationLogs.ts")
            )
        );
        expect(commands.at(-1)).toContain("delivery activate");
        expect(commands.at(-1)).toContain(
            `--runtime-source=${admittedReleaseRoot}/runtime/bun`
        );
        expect(commands.at(-1)).toContain("--activation-mode=greenfield");
        expect(
            commands.findIndex((command) =>
                command.includes("installHostOperationsProvisioning.ts")
            )
        ).toBeLessThan(
            commands.findIndex((command) => command.includes("delivery activate"))
        );

        commands.length = 0;
        expect(
            await captureFailure(
                deployProduction(dependencies, {
                    createTemporaryRoot,
                    expectedCheckout: targetRepositoryRoot,
                    repositoryRoot: targetRepositoryRoot,
                    userId: 1000,
                })
            )
        ).toBeInstanceOf(Error);
        expect(manualDeployDelivered).toBe(false);

        commands.length = 0;
        prerequisitesInspected = false;
        provisioningBoundaryAvailable = true;
        await deployProduction(dependencies, {
            createTemporaryRoot,
            expectedCheckout: targetRepositoryRoot,
            repositoryRoot: targetRepositoryRoot,
            userId: 1000,
        });
        expect(commands.some((command) => command.includes("release view"))).toBe(true);
        expect(
            commands.some((command) => command.includes("systemctl daemon-reload"))
        ).toBe(false);
        expect(commands).toContain(
            "/usr/bin/systemctl cat mira-dashboard-production-provisioning@.service"
        );
        expect(manualDeployDelivered).toBe(true);
        expect(prerequisitesInspected).toBe(false);
        expect(prepareStateWorkingDirectories).toEqual([
            admittedReleaseRoot,
            admittedReleaseRoot,
        ]);

        await writeFile(path.join(targetRepositoryRoot, ".bun-version"), "9.9.9\n");
        let runtimeUpgradeDelivered = false;
        await deployProduction(
            {
                ...dependencies,
                deliverPublishedRelease: () => {
                    runtimeUpgradeDelivered = true;
                    return Promise.resolve();
                },
            },
            {
                createTemporaryRoot,
                expectedCheckout: targetRepositoryRoot,
                repositoryRoot: targetRepositoryRoot,
                userId: 1000,
            }
        );
        expect(runtimeUpgradeDelivered).toBe(true);
    });
});
