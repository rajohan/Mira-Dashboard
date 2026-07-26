import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "bun:test";

import {
    assertManagedDashboardUnitProperties,
    type DashboardReleaseCommandRunner,
    MANAGED_DASHBOARD_PRESERVED_ENVIRONMENT,
    MANAGED_DASHBOARD_UNITS,
    managedDashboardUnitContract,
    runReleaseDeploymentCommand,
    stageDashboardRelease,
} from "../src/releaseDeployment.ts";
import { managedReleasePath } from "../src/releaseManager.ts";
import { createReleaseFixture } from "./support/releaseFixture.ts";

const COMMIT_SHA = "a".repeat(40);
const OTHER_COMMIT_SHA = "b".repeat(40);
const temporaryRoots: string[] = [];

function managedUnitProperties(unitContents: string): string {
    const lines = unitContents.split("\n");
    const environment = lines
        .filter((line) => line.startsWith("Environment="))
        .map((line) => line.slice("Environment=".length));
    const execStart = lines.find((line) => line.startsWith("ExecStart="));
    const workingDirectory = lines.find((line) => line.startsWith("WorkingDirectory="));
    if (!execStart || !workingDirectory) {
        throw new Error("Managed unit fixture is missing required service properties");
    }
    return [`Environment=${environment.join(" ")}`, execStart, workingDirectory].join(
        "\n"
    );
}

async function concurrentBuildTimeout(): Promise<never> {
    await Bun.sleep(5000);
    throw new Error("Concurrent release build barrier timed out");
}

function temporaryRoot(label: string): string {
    const root = mkdtempSync(path.join(tmpdir(), `${label}-`));
    temporaryRoots.push(root);
    return root;
}

function stagingOptions() {
    const base = temporaryRoot("mira-release-deployment-test");
    const sourceRoot = path.join(base, "source");
    const worktreeRoot = path.join(base, "worktrees");
    const releasesRoot = path.join(base, "managed");
    const databasePath = path.join(base, "state", "mira-dashboard.db");
    const openClawHome = path.join(base, "state", "openclaw-client");
    mkdirSync(sourceRoot);
    mkdirSync(worktreeRoot);
    mkdirSync(path.dirname(databasePath));
    return {
        databasePath,
        openClawHome,
        releasesRoot,
        sourceRoot,
        worktreeRoot,
    };
}

afterEach(() => {
    for (const root of temporaryRoots) {
        rmSync(root, { force: true, recursive: true });
    }
    temporaryRoots.length = 0;
});

describe("immutable release deployment", () => {
    it("keeps shipped managed units aligned with the production contract", () => {
        const releasesRoot = "/home/ubuntu/projects/mira-dashboard-releases";
        const contract = {
            databasePath: "/home/ubuntu/projects/mira-dashboard-state/mira-dashboard.db",
            logRotationLockFile:
                "/home/ubuntu/projects/mira-dashboard-state/log-rotation.lock",
            openClawHome: "/home/ubuntu/projects/mira-dashboard-state/openclaw-client",
            releaseRoot: `${releasesRoot}/current`,
            releasesRoot,
        };
        for (const unitName of Object.keys(MANAGED_DASHBOARD_UNITS) as Array<
            keyof typeof MANAGED_DASHBOARD_UNITS
        >) {
            const unit = readFileSync(
                path.resolve(import.meta.dirname, "../../systemd", unitName),
                "utf8"
            );
            expect(() =>
                assertManagedDashboardUnitProperties(
                    unitName,
                    managedUnitProperties(unit),
                    contract
                )
            ).not.toThrow();
            expect(unit).toContain(
                "WorkingDirectory=/home/ubuntu/projects/mira-dashboard-releases/current/backend"
            );
            expect(unit).toContain(
                "MIRA_DASHBOARD_DB_PATH=/home/ubuntu/projects/mira-dashboard-state/mira-dashboard.db"
            );
            expect(unit).toContain(
                "MIRA_DASHBOARD_OPENCLAW_HOME=/home/ubuntu/projects/mira-dashboard-state/openclaw-client"
            );
            expect(unit).toContain(
                "MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE=/home/ubuntu/projects/mira-dashboard-state/log-rotation.lock"
            );
            expect(unit).not.toContain(
                "/home/ubuntu/projects/mira-dashboard/backend/data"
            );
        }
    });

    it("keeps host-local password reset on the stable production database", () => {
        const backendPackage = JSON.parse(
            readFileSync(path.resolve(import.meta.dirname, "../package.json"), "utf8")
        ) as { scripts?: Record<string, string> };
        const resetCommand = backendPackage.scripts?.["auth:reset-password"];
        expect(resetCommand).toContain(
            "MIRA_DASHBOARD_DB_PATH=${MIRA_DASHBOARD_DB_PATH:-/home/ubuntu/projects/mira-dashboard-state/mira-dashboard.db}"
        );
        expect(resetCommand).toContain(
            "--preserve-env=MIRA_DASHBOARD_DB_PATH -- bun dist/resetDashboardPassword.js"
        );
    });

    it("builds in an isolated worktree and atomically publishes only artifacts", async () => {
        const options = stagingOptions();
        const calls: Array<{
            arguments_: readonly string[];
            command: string;
            cwd: string;
            releaseRoot: string | undefined;
        }> = [];
        const progress: string[] = [];
        const runner: DashboardReleaseCommandRunner = async (
            command,
            arguments_,
            commandOptions
        ) => {
            calls.push({
                arguments_,
                command,
                cwd: commandOptions.cwd,
                releaseRoot: commandOptions.environment.MIRA_DASHBOARD_RELEASE_ROOT,
            });
            if (command === "git" && arguments_[0] === "worktree") {
                if (arguments_[1] === "add") {
                    const worktreePath = String(arguments_[3]);
                    mkdirSync(worktreePath);
                    await createReleaseFixture(worktreePath, COMMIT_SHA);
                } else if (arguments_[1] === "remove") {
                    rmSync(String(arguments_[3]), { force: true, recursive: true });
                }
            }
            return {
                stderr: "",
                stdout:
                    command === "git" && arguments_[0] === "rev-parse"
                        ? `${COMMIT_SHA}\n`
                        : "",
            };
        };

        const release = await stageDashboardRelease(COMMIT_SHA, {
            ...options,
            commandRunner: runner,
            onProgress: (message) => {
                progress.push(message);
            },
        });

        expect(release.commitSha).toBe(COMMIT_SHA);
        expect(release.path).toBe(managedReleasePath(options.releasesRoot, COMMIT_SHA));
        expect(existsSync(path.join(release.path, "dist", "index.html"))).toBe(true);
        expect(
            existsSync(path.join(release.path, "backend", "config", "log-rotation.json"))
        ).toBe(true);
        expect(existsSync(path.join(release.path, "not-a-release-artifact.txt"))).toBe(
            false
        );
        expect(readdirSync(options.worktreeRoot)).toEqual([]);
        expect(calls.map(({ command, arguments_ }) => [command, ...arguments_])).toEqual([
            ["git", "worktree", "add", "--detach", expect.any(String), COMMIT_SHA],
            ["git", "rev-parse", "HEAD"],
            ["bun", "install", "--frozen-lockfile"],
            ["bun", "install", "--frozen-lockfile"],
            ["bun", "run", "deploy:prepare"],
            ["git", "worktree", "remove", "--force", expect.any(String)],
        ]);
        expect(progress).toEqual([
            "Creating isolated release worktree",
            "Installing frontend release dependencies",
            "Installing backend release dependencies",
            "Building and preflighting release",
            "Publishing verified immutable release",
        ]);
        const buildReleaseRoots = new Set(calls.map(({ releaseRoot }) => releaseRoot));
        expect(buildReleaseRoots.size).toBe(1);
        expect([...buildReleaseRoots][0]).toStartWith(`${options.worktreeRoot}/release-`);
    });

    it("reruns database preflight when reusing a verified immutable release", async () => {
        const options = stagingOptions();
        const buildRoot = path.join(options.worktreeRoot, "prepared");
        mkdirSync(buildRoot);
        await createReleaseFixture(buildRoot, COMMIT_SHA);
        const initialRunner: DashboardReleaseCommandRunner = async (
            command,
            arguments_
        ) => {
            if (command === "git" && arguments_[0] === "worktree") {
                if (arguments_[1] === "add") {
                    const worktreePath = String(arguments_[3]);
                    mkdirSync(worktreePath);
                    await createReleaseFixture(worktreePath, COMMIT_SHA);
                } else {
                    rmSync(String(arguments_[3]), { force: true, recursive: true });
                }
            }
            return {
                stderr: "",
                stdout:
                    command === "git" && arguments_[0] === "rev-parse" ? COMMIT_SHA : "",
            };
        };
        await stageDashboardRelease(COMMIT_SHA, {
            ...options,
            commandRunner: initialRunner,
        });

        const calls: Array<{
            arguments_: readonly string[];
            command: string;
            cwd: string;
            databasePath: string | undefined;
            releaseRoot: string | undefined;
        }> = [];
        const reused = await stageDashboardRelease(COMMIT_SHA, {
            ...options,
            commandRunner: async (command, arguments_, commandOptions) => {
                calls.push({
                    arguments_,
                    command,
                    cwd: commandOptions.cwd,
                    databasePath: commandOptions.environment.MIRA_DASHBOARD_DB_PATH,
                    releaseRoot: commandOptions.environment.MIRA_DASHBOARD_RELEASE_ROOT,
                });
                return { stderr: "", stdout: "" };
            },
        });

        expect(reused.commitSha).toBe(COMMIT_SHA);
        expect(calls).toEqual([
            {
                arguments_: ["dist/databasePreflight.js"],
                command: "bun",
                cwd: path.join(reused.path, "backend"),
                databasePath: options.databasePath,
                releaseRoot: reused.path,
            },
        ]);
        await expect(
            stageDashboardRelease(COMMIT_SHA, {
                ...options,
                commandRunner: async () => {
                    throw Object.assign(
                        new Error("database preflight executable missing"),
                        {
                            code: "ENOENT",
                        }
                    );
                },
            })
        ).rejects.toThrow("database preflight executable missing");
    });

    it("accepts a concurrently published copy of the same verified release", async () => {
        const options = stagingOptions();
        let buildsReady = 0;
        const { promise: buildsReleased, resolve: releaseBuilds } =
            Promise.withResolvers<void>();
        const runner: DashboardReleaseCommandRunner = async (command, arguments_) => {
            if (command === "git" && arguments_[0] === "worktree") {
                if (arguments_[1] === "add") {
                    const worktreePath = String(arguments_[3]);
                    mkdirSync(worktreePath);
                    await createReleaseFixture(worktreePath, COMMIT_SHA);
                } else {
                    rmSync(String(arguments_[3]), { force: true, recursive: true });
                }
            }
            if (
                command === "bun" &&
                arguments_[0] === "run" &&
                arguments_[1] === "deploy:prepare"
            ) {
                buildsReady += 1;
                if (buildsReady === 2) {
                    releaseBuilds();
                }
                await Promise.race([buildsReleased, concurrentBuildTimeout()]);
            }
            return {
                stderr: "",
                stdout:
                    command === "git" && arguments_[0] === "rev-parse" ? COMMIT_SHA : "",
            };
        };

        const [left, right] = await Promise.all([
            stageDashboardRelease(COMMIT_SHA, {
                ...options,
                commandRunner: runner,
            }),
            stageDashboardRelease(COMMIT_SHA, {
                ...options,
                commandRunner: runner,
            }),
        ]);

        expect(left.commitSha).toBe(COMMIT_SHA);
        expect(right.commitSha).toBe(COMMIT_SHA);
        expect(left.path).toBe(right.path);
        expect(readdirSync(options.worktreeRoot)).toEqual([]);
        expect(
            readdirSync(path.join(options.releasesRoot, "releases")).filter((entry) =>
                entry.startsWith(".staging-")
            )
        ).toEqual([]);
    });

    it("removes the temporary worktree when commit verification fails", async () => {
        const options = stagingOptions();
        const calls: string[] = [];
        const runner: DashboardReleaseCommandRunner = async (command, arguments_) => {
            calls.push(`${command} ${arguments_.slice(0, 2).join(" ")}`);
            if (command === "git" && arguments_[0] === "worktree") {
                if (arguments_[1] === "add") {
                    mkdirSync(String(arguments_[3]));
                } else {
                    rmSync(String(arguments_[3]), { force: true, recursive: true });
                }
            }
            return {
                stderr: "",
                stdout:
                    command === "git" && arguments_[0] === "rev-parse"
                        ? OTHER_COMMIT_SHA
                        : "",
            };
        };

        await expect(
            stageDashboardRelease(COMMIT_SHA, {
                ...options,
                commandRunner: runner,
            })
        ).rejects.toThrow("unexpected commit");
        expect(readdirSync(options.worktreeRoot)).toEqual([]);
        expect(calls.at(-1)).toBe("git worktree remove");
        expect(existsSync(managedReleasePath(options.releasesRoot, COMMIT_SHA))).toBe(
            false
        );
    });

    it("cleans a partially-created worktree when git worktree add fails", async () => {
        const options = stagingOptions();
        const calls: string[] = [];
        const runner: DashboardReleaseCommandRunner = async (command, arguments_) => {
            calls.push(`${command} ${arguments_.slice(0, 2).join(" ")}`);
            if (
                command === "git" &&
                arguments_[0] === "worktree" &&
                arguments_[1] === "add"
            ) {
                mkdirSync(String(arguments_[3]));
                throw new Error("worktree add failed");
            }
            if (
                command === "git" &&
                arguments_[0] === "worktree" &&
                arguments_[1] === "remove"
            ) {
                rmSync(String(arguments_[3]), { force: true, recursive: true });
            }
            return { stderr: "", stdout: "" };
        };

        await expect(
            stageDashboardRelease(COMMIT_SHA, {
                ...options,
                commandRunner: runner,
            })
        ).rejects.toThrow("worktree add failed");
        expect(readdirSync(options.worktreeRoot)).toEqual([]);
        expect(calls).toEqual(["git worktree add", "git worktree remove"]);
    });

    it("falls back to filesystem cleanup and prunes stale worktree metadata", async () => {
        const options = stagingOptions();
        const calls: string[] = [];
        const runner: DashboardReleaseCommandRunner = async (command, arguments_) => {
            calls.push(`${command} ${arguments_.slice(0, 2).join(" ")}`);
            if (command === "git" && arguments_[0] === "worktree") {
                if (arguments_[1] === "add") {
                    const worktreePath = String(arguments_[3]);
                    mkdirSync(worktreePath);
                    await createReleaseFixture(worktreePath, COMMIT_SHA);
                } else if (arguments_[1] === "remove") {
                    throw new Error("registered worktree removal failed");
                }
            }
            return {
                stderr: "",
                stdout:
                    command === "git" && arguments_[0] === "rev-parse" ? COMMIT_SHA : "",
            };
        };

        await expect(
            stageDashboardRelease(COMMIT_SHA, {
                ...options,
                commandRunner: runner,
            })
        ).resolves.toMatchObject({ commitSha: COMMIT_SHA });
        expect(readdirSync(options.worktreeRoot)).toEqual([]);
        expect(calls.at(-2)).toBe("git worktree remove");
        expect(calls.at(-1)).toBe("git worktree prune");
    });

    it("rejects mismatched build identity and cleans the worktree", async () => {
        const options = stagingOptions();
        const runner: DashboardReleaseCommandRunner = async (command, arguments_) => {
            if (command === "git" && arguments_[0] === "worktree") {
                if (arguments_[1] === "add") {
                    const worktreePath = String(arguments_[3]);
                    mkdirSync(worktreePath);
                    await createReleaseFixture(worktreePath, OTHER_COMMIT_SHA);
                } else {
                    rmSync(String(arguments_[3]), { force: true, recursive: true });
                }
            }
            return {
                stderr: "",
                stdout:
                    command === "git" && arguments_[0] === "rev-parse" ? COMMIT_SHA : "",
            };
        };

        await expect(
            stageDashboardRelease(COMMIT_SHA, {
                ...options,
                commandRunner: runner,
            })
        ).rejects.toThrow(`does not match ${COMMIT_SHA}`);
        expect(readdirSync(options.worktreeRoot)).toEqual([]);
    });

    it("validates paths, commits, and CLI commands", async () => {
        const options = stagingOptions();
        expect(() =>
            managedDashboardUnitContract(
                options.releasesRoot,
                options.databasePath,
                options.openClawHome
            )
        ).not.toThrow();
        expect(() =>
            managedDashboardUnitContract(
                options.releasesRoot,
                "relative.db",
                options.openClawHome
            )
        ).toThrow("database path must be an absolute non-root path");
        expect(() =>
            managedDashboardUnitContract("/", options.databasePath, options.openClawHome)
        ).toThrow("releases root must be an absolute non-root path");
        const contract = managedDashboardUnitContract(
            options.releasesRoot,
            options.databasePath,
            options.openClawHome
        );
        const properties = [
            `WorkingDirectory=${contract.releaseRoot}/backend`,
            `Environment=NODE_ENV=production MIRA_DASHBOARD_DB_PATH=${contract.databasePath} MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE=${contract.logRotationLockFile} MIRA_DASHBOARD_OPENCLAW_HOME=${contract.openClawHome} MIRA_DASHBOARD_RELEASE_ROOT=${contract.releaseRoot} MIRA_DASHBOARD_RELEASES_ROOT=${contract.releasesRoot}`,
            `ExecStart={ path=/usr/local/bin/doppler ; argv[]=/usr/local/bin/doppler run --preserve-env=${MANAGED_DASHBOARD_PRESERVED_ENVIRONMENT.join(",")} -- bun dist/serverStart.js ; }`,
        ].join("\n");
        expect(() =>
            assertManagedDashboardUnitProperties(
                "mira-dashboard.service",
                properties,
                contract
            )
        ).not.toThrow();
        expect(() =>
            assertManagedDashboardUnitProperties(
                "mira-dashboard.service",
                properties.replace(
                    ` --preserve-env=${MANAGED_DASHBOARD_PRESERVED_ENVIRONMENT.join(",")}`,
                    ""
                ),
                contract
            )
        ).toThrow("must preserve managed release environment");
        expect(() =>
            assertManagedDashboardUnitProperties(
                "mira-dashboard-worker.service",
                properties,
                contract
            )
        ).toThrow("unexpected managed release entrypoint");
        expect(() =>
            assertManagedDashboardUnitProperties(
                "mira-dashboard.service",
                properties.replace(
                    "bun dist/serverStart.js",
                    "bun not-dist/serverStart.js"
                ),
                contract
            )
        ).toThrow("unexpected managed release entrypoint");
        expect(() =>
            assertManagedDashboardUnitProperties(
                "mira-dashboard.service",
                properties.replace(
                    `WorkingDirectory=${contract.releaseRoot}/backend`,
                    () => `WorkingDirectory=${options.sourceRoot}/backend`
                ),
                contract
            )
        ).toThrow("must run from managed current/backend");
        expect(() =>
            assertManagedDashboardUnitProperties(
                "mira-dashboard.service",
                properties.replace(
                    ` MIRA_DASHBOARD_OPENCLAW_HOME=${contract.openClawHome}`,
                    ""
                ),
                contract
            )
        ).toThrow("MIRA_DASHBOARD_OPENCLAW_HOME");
        expect(() =>
            assertManagedDashboardUnitProperties(
                "mira-dashboard.service",
                properties.replace(
                    ` MIRA_DASHBOARD_OPENCLAW_HOME=${contract.openClawHome}`,
                    () => ` NOT_MIRA_DASHBOARD_OPENCLAW_HOME=${contract.openClawHome}`
                ),
                contract
            )
        ).toThrow("MIRA_DASHBOARD_OPENCLAW_HOME");
        await expect(
            stageDashboardRelease("short", {
                ...options,
                commandRunner: async () => ({ stderr: "", stdout: "" }),
            })
        ).rejects.toThrow("full lowercase Git SHA");
        await expect(
            runReleaseDeploymentCommand(["unknown"], options.releasesRoot)
        ).rejects.toThrow("Usage");
        await expect(
            runReleaseDeploymentCommand(["stage"], options.releasesRoot)
        ).rejects.toThrow("stage requires a commit SHA");
        await expect(
            runReleaseDeploymentCommand(["prune", "1"], options.releasesRoot)
        ).rejects.toThrow("retention must be between 2 and 20");
        await expect(
            runReleaseDeploymentCommand(["prune", "3", "extra"], options.releasesRoot)
        ).rejects.toThrow("unexpected arguments");
        expect(
            await runReleaseDeploymentCommand(["prune"], options.releasesRoot)
        ).toEqual({ removed: [], retained: [], warnings: [] });
    });
});
