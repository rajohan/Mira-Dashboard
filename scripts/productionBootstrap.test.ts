import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { packageProductionReleaseArtifact } from "./delivery/packageProductionReleaseArtifact.ts";
import {
    admitProductionBootstrapRelease,
    assertProductionReleaseArchiveListing,
    bootstrapProduction,
    downloadProductionBootstrapRelease,
    parseProductionBootstrapRelease,
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
            ).toThrow("Production bootstrap failed");
        }
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
        expect(commands).toHaveLength(4);
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
        const dependencies: ProductionBootstrapDependencies = {
            run: (command) => {
                commands.push(command.join(" "));
                const invocation = command.join(" ");
                let stdout = "";
                if (invocation.includes(" release view ")) {
                    stdout = '{"tagName":"v0.2.0"}\n';
                }
                if (invocation.includes(" rev-list ")) stdout = `${releaseId}\n`;
                return Promise.resolve({ exitCode: 0, stdout });
            },
        };
        expect(
            await downloadProductionBootstrapRelease(
                releaseId,
                "/tmp/artifact",
                dependencies
            )
        ).toBe("/tmp/artifact");
        expect(commands.at(-1)).toContain("release download v0.2.0");
    });

    test("binds clean-host prerequisites to root-owned runtime bytes", async () => {
        const runtimeBytes = new TextEncoder().encode("qualified-runtime");
        const dependencies: ProductionBootstrapDependencies = {
            run: () => Promise.resolve({ exitCode: 0, stdout: "ready\n" }),
        };
        const result = await verifyProductionBootstrapPrerequisites(
            dependencies,
            "/srv/dashboard",
            1000,
            {
                canonical: (target) =>
                    Promise.resolve(
                        target === "/home/ubuntu/.openclaw"
                            ? target
                            : "/usr/local/bin/bun"
                    ),
                read: () => Promise.resolve(runtimeBytes),
                status: (target) =>
                    Promise.resolve({
                        gid: target === "/usr/local/bin/bun" ? 0 : 1000,
                        isDirectory: () => target === "/home/ubuntu/.openclaw",
                        isFile: () => target === "/usr/local/bin/bun",
                        mode: target === "/usr/local/bin/bun" ? 0o755 : 0o700,
                        uid: target === "/usr/local/bin/bun" ? 0 : 1000,
                    }),
            }
        );

        expect(result.runtimeSha256).toBe(
            new Bun.CryptoHasher("sha256").update(runtimeBytes).digest("hex")
        );
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

        const admitted = await admitProductionBootstrapRelease(
            targetArtifactRoot,
            releaseId,
            realProcessDependencies,
            targetRepositoryRoot
        );

        expect(admitted.releaseRoot).toBe(
            path.join(targetRepositoryRoot, "dist/releases", releaseId)
        );
        expect(admitted.manifestSha256).toBe(receipt.releaseManifestSha256);
    });

    test("stages every fixed root authority command without shell interpretation", async () => {
        const commands: string[][] = [];
        const dependencies: ProductionBootstrapDependencies = {
            run: (command) => {
                commands.push([...command]);
                let stdout = "";
                if (command.includes("/usr/bin/sha256sum")) {
                    stdout = command.at(-1)?.endsWith("/runtime/bun")
                        ? `${"e".repeat(64)}  bun\n`
                        : `${"d".repeat(64)}  release.tar\n`;
                }
                return Promise.resolve({
                    exitCode:
                        command[0] === "/usr/bin/getent" && command[1] === "group"
                            ? 2
                            : 0,
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
            dependencies
        );

        expect(
            commands.some((command) =>
                command.some((argument) => argument.endsWith("/groupadd"))
            )
        ).toBe(true);
        expect(
            commands.some((command) =>
                command.some((argument) => argument.endsWith("/usermod"))
            )
        ).toBe(true);
        expect(
            commands.some((command) =>
                command.some((argument) =>
                    argument.endsWith("installHostOperationsProvisioning.ts")
                )
            )
        ).toBe(true);
        expect(commands.at(-1)).toContain("--mode=apply");
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
                {
                    run: (command) => {
                        commands.push([...command]);
                        const stagedRuntime = command.at(-1)?.endsWith("/runtime/bun");
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
        const targetRepositoryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-production-bootstrap-composition-")
        );
        temporaryDirectories.push(targetRepositoryRoot);
        const artifactRoot = path.join(targetRepositoryRoot, "download");
        await Promise.all([
            cp(
                path.join(sourceRepositoryRoot, "dist/production-release-artifact"),
                artifactRoot,
                { recursive: true }
            ),
            cp(
                path.join(sourceProjectRoot, ".bun-version"),
                path.join(targetRepositoryRoot, ".bun-version")
            ),
        ]);
        const commands: string[] = [];
        let prerequisitesInspected = false;
        const dependencies: ProductionBootstrapDependencies = {
            inspectPrerequisites: () => {
                prerequisitesInspected = true;
                return Promise.resolve({ runtimeSha256: "e".repeat(64) });
            },
            run: async (command, cwd) => {
                const invocation = command.join(" ");
                commands.push(invocation);
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
                if (invocation.includes(" release view ")) {
                    return { exitCode: 0, stdout: '{"tagName":"v0.2.0"}\n' };
                }
                if (invocation.includes(" rev-list ")) {
                    return { exitCode: 0, stdout: `${releaseId}\n` };
                }
                if (invocation.includes("sha256sum")) {
                    return {
                        exitCode: 0,
                        stdout: command.at(-1)?.endsWith("/runtime/bun")
                            ? `${"e".repeat(64)}  bun\n`
                            : `${receipt.archive.sha256}  release.tar\n`,
                    };
                }
                if (
                    command[0] === "/usr/bin/getent" &&
                    command.at(-1) === "mira-dashboard-log-maintenance"
                ) {
                    return { exitCode: 2, stdout: "" };
                }
                return { exitCode: 0, stdout: "" };
            },
        };

        await bootstrapProduction(dependencies, {
            createTemporaryRoot: () => Promise.resolve(artifactRoot),
            expectedCheckout: targetRepositoryRoot,
            repositoryRoot: targetRepositoryRoot,
            userId: 1000,
        });

        expect(prerequisitesInspected).toBe(true);
        expect(
            commands.some((command) => command.includes("delivery prepare-state"))
        ).toBe(true);
        expect(commands.at(-1)).toContain("delivery activate");
    });
});
