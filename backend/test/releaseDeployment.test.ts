import { afterEach, describe, expect, it } from "bun:test";
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

import {
    resolveDashboardProjectPaths,
    resolveDashboardProjectPathsForRuntime,
    resolveDashboardRuntimePath,
} from "../src/lib/dashboardPaths.ts";
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
const PRODUCTION_PATHS = resolveDashboardProjectPaths({});
const temporaryRoots: string[] = [];

function managedUnitProperties(unitContents: string): string {
    const lines = unitContents.split("\n");
    const environment = lines
        .filter((line) => line.startsWith("Environment="))
        .map((line) => line.slice("Environment=".length));
    const execStart = lines.find((line) => line.startsWith("ExecStart="));
    const workingDirectory = lines
        .find((line) => line.startsWith("WorkingDirectory="))
        ?.replaceAll("%h", "/home/ubuntu");
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
    mkdirSync(sourceRoot);
    mkdirSync(worktreeRoot);
    return {
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
    it("derives the complete host layout from one project-root environment value", () => {
        const paths = resolveDashboardProjectPaths({
            MIRA_DASHBOARD_PROJECT_ROOT: "/srv/dashboard",
        });
        expect(paths).toMatchObject({
            developmentLocalStateRoot: "/srv/dashboard/development/state/local",
            developmentPreviewRoot: "/srv/dashboard/development/preview",
            developmentPreviewStateRoot: "/srv/dashboard/development/state/preview",
            developmentWorktreeRoot: "/srv/dashboard/development/worktrees",
            productionCheckoutRoot: "/srv/dashboard/production/checkout",
            productionDatabasePath: "/srv/dashboard/production/state/mira-dashboard.db",
            productionReleasesRoot: "/srv/dashboard/production/releases",
            projectRoot: "/srv/dashboard",
        });
        expect(() =>
            resolveDashboardProjectPaths({
                MIRA_DASHBOARD_PROJECT_ROOT: "/",
            })
        ).toThrow("Dashboard project root must be an absolute non-root path");
        expect(
            resolveDashboardProjectPathsForRuntime({
                MIRA_DASHBOARD_PROJECT_ROOT: "/srv/runtime-dashboard",
                NODE_ENV: "development",
            })?.projectRoot
        ).toBe("/srv/runtime-dashboard");
        expect(
            resolveDashboardProjectPathsForRuntime({
                NODE_ENV: "development",
            })
        ).toBeUndefined();
        expect(
            resolveDashboardProjectPathsForRuntime({
                NODE_ENV: "production",
            })?.projectRoot
        ).toBe(PRODUCTION_PATHS.projectRoot);
        expect(
            resolveDashboardRuntimePath("/derived", "/internal", {
                NODE_ENV: "production",
            })
        ).toBe("/derived");
        expect(
            resolveDashboardRuntimePath("/derived", "/internal", {
                NODE_ENV: "development",
            })
        ).toBe("/internal");
    });

    it("keeps shipped managed units aligned with the production contract", () => {
        const releasesRoot = PRODUCTION_PATHS.productionReleasesRoot;
        const contract = {
            databasePath: PRODUCTION_PATHS.productionDatabasePath,
            logRotationLockFile: PRODUCTION_PATHS.productionLogRotationLockFile,
            openClawHome: PRODUCTION_PATHS.productionOpenClawHome,
            previewRoot: PRODUCTION_PATHS.developmentPreviewStateRoot,
            previewWorktreePath: PRODUCTION_PATHS.developmentPreviewRoot,
            projectRoot: PRODUCTION_PATHS.projectRoot,
            releaseRoot: `${releasesRoot}/current`,
            releasesRoot,
            sourceRoot: PRODUCTION_PATHS.productionCheckoutRoot,
            worktreeRoot: PRODUCTION_PATHS.developmentWorktreeRoot,
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
                "WorkingDirectory=%h/projects/mira-dashboard/production/releases/current/backend"
            );
            expect(unit).toContain(
                `Environment=MIRA_DASHBOARD_PROJECT_ROOT=${PRODUCTION_PATHS.projectRoot}`
            );
            for (const obsoleteEnvironment of [
                "MIRA_DASHBOARD_DB_PATH",
                "MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE",
                "MIRA_DASHBOARD_OPENCLAW_HOME",
                "MIRA_DASHBOARD_PREVIEW_ROOT",
                "MIRA_DASHBOARD_PREVIEW_WORKTREE_PATH",
                "MIRA_DASHBOARD_RELEASE_ROOT",
                "MIRA_DASHBOARD_RELEASES_ROOT",
                "MIRA_DASHBOARD_ROOT",
                "MIRA_DASHBOARD_WORKTREE_ROOT",
            ]) {
                expect(unit).not.toMatch(
                    new RegExp(
                        String.raw`(?:^Environment=|\s)${obsoleteEnvironment}=`,
                        "m"
                    )
                );
            }
        }
    });

    it("keeps host-local password reset on the stable production database", () => {
        const rootPackage = JSON.parse(
            readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8")
        ) as { scripts?: Record<string, string> };
        const resetCommand = rootPackage.scripts?.["auth:reset-password"];
        expect(resetCommand).toContain(
            "NODE_ENV=production doppler run --config prd --project rajohan"
        );
        expect(resetCommand).toContain(
            "--preserve-env=NODE_ENV,MIRA_DASHBOARD_PROJECT_ROOT -- bun --cwd backend dist/resetDashboardPassword.js"
        );
        expect(resetCommand).not.toContain("/home/ubuntu/projects");
    });

    it("builds in an isolated worktree and atomically publishes only artifacts", async () => {
        const options = stagingOptions();
        const calls: Array<{
            arguments_: readonly string[];
            command: string;
            cwd: string;
            dashboardEnvironment: Record<string, string | undefined>;
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
                dashboardEnvironment: Object.fromEntries(
                    Object.entries(commandOptions.environment).filter(([key]) =>
                        key.startsWith("MIRA_DASHBOARD_")
                    )
                ),
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
            [process.execPath, "install", "--frozen-lockfile"],
            [process.execPath, "run", "deploy:prepare"],
            ["git", "worktree", "remove", "--force", expect.any(String)],
        ]);
        expect(progress).toEqual([
            "Creating isolated release worktree",
            "Installing release dependencies",
            "Building and preflighting release",
            "Publishing verified immutable release",
        ]);
        for (const call of calls) {
            expect(call.dashboardEnvironment).toEqual({
                MIRA_DASHBOARD_PROJECT_ROOT: resolveDashboardProjectPaths().projectRoot,
            });
        }
    });

    it("exposes the selected Bun executable to nested release scripts", async () => {
        const options = stagingOptions();
        const bunExecutable = path.join(options.sourceRoot, "bun-runtime", "bin", "bun");
        let deployPath = "";
        const runner: DashboardReleaseCommandRunner = async (
            command,
            arguments_,
            commandOptions
        ) => {
            if (command === "git" && arguments_[0] === "worktree") {
                if (arguments_[1] === "add") {
                    const worktreePath = String(arguments_[3]);
                    mkdirSync(worktreePath);
                    await createReleaseFixture(worktreePath, COMMIT_SHA);
                } else if (arguments_[1] === "remove") {
                    rmSync(String(arguments_[3]), { force: true, recursive: true });
                }
            }
            if (
                command === bunExecutable &&
                arguments_[0] === "run" &&
                arguments_[1] === "deploy:prepare"
            ) {
                deployPath = commandOptions.environment.PATH ?? "";
            }
            return {
                stderr: "",
                stdout:
                    command === "git" && arguments_[0] === "rev-parse"
                        ? `${COMMIT_SHA}\n`
                        : "",
            };
        };

        await stageDashboardRelease(COMMIT_SHA, {
            ...options,
            bunExecutable,
            commandRunner: runner,
        });

        expect(deployPath.split(path.delimiter)[0]).toBe(path.dirname(bunExecutable));
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
            dashboardEnvironment: Record<string, string | undefined>;
        }> = [];
        const reused = await stageDashboardRelease(COMMIT_SHA, {
            ...options,
            commandRunner: (command, arguments_, commandOptions) => {
                return Promise.try(() => {
                    calls.push({
                        arguments_,
                        command,
                        cwd: commandOptions.cwd,
                        dashboardEnvironment: Object.fromEntries(
                            Object.entries(commandOptions.environment).filter(([key]) =>
                                key.startsWith("MIRA_DASHBOARD_")
                            )
                        ),
                    });
                    return { stderr: "", stdout: "" };
                });
            },
        });

        expect(reused.commitSha).toBe(COMMIT_SHA);
        expect(calls).toEqual([
            {
                arguments_: ["dist/databasePreflight.js"],
                command: process.execPath,
                cwd: path.join(reused.path, "backend"),
                dashboardEnvironment: {
                    MIRA_DASHBOARD_PROJECT_ROOT:
                        resolveDashboardProjectPaths().projectRoot,
                },
            },
        ]);
        expect(
            stageDashboardRelease(COMMIT_SHA, {
                ...options,
                commandRunner: () => {
                    return Promise.try(() => {
                        throw Object.assign(
                            new Error("database preflight executable missing"),
                            {
                                code: "ENOENT",
                            }
                        );
                    });
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
                command === process.execPath &&
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

    it("removes the temporary worktree when commit verification fails", () => {
        const options = stagingOptions();
        const calls: string[] = [];
        const runner: DashboardReleaseCommandRunner = (command, arguments_) => {
            return Promise.try(() => {
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
            });
        };

        expect(
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

    it("cleans a partially-created worktree when git worktree add fails", () => {
        const options = stagingOptions();
        const calls: string[] = [];
        const runner: DashboardReleaseCommandRunner = (command, arguments_) => {
            return Promise.try(() => {
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
            });
        };

        expect(
            stageDashboardRelease(COMMIT_SHA, {
                ...options,
                commandRunner: runner,
            })
        ).rejects.toThrow("worktree add failed");
        expect(readdirSync(options.worktreeRoot)).toEqual([]);
        expect(calls).toEqual(["git worktree add", "git worktree remove"]);
    });

    it("falls back to filesystem cleanup and prunes stale worktree metadata", () => {
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

        expect(
            stageDashboardRelease(COMMIT_SHA, {
                ...options,
                commandRunner: runner,
            })
        ).resolves.toMatchObject({ commitSha: COMMIT_SHA });
        expect(readdirSync(options.worktreeRoot)).toEqual([]);
        expect(calls.at(-2)).toBe("git worktree remove");
        expect(calls.at(-1)).toBe("git worktree prune");
    });

    it("rejects mismatched build identity and cleans the worktree", () => {
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

        expect(
            stageDashboardRelease(COMMIT_SHA, {
                ...options,
                commandRunner: runner,
            })
        ).rejects.toThrow(`does not match ${COMMIT_SHA}`);
        expect(readdirSync(options.worktreeRoot)).toEqual([]);
    });

    it("validates paths, commits, and CLI commands", async () => {
        const options = stagingOptions();
        expect(() => managedDashboardUnitContract(options.releasesRoot)).not.toThrow();
        expect(() => managedDashboardUnitContract("/")).toThrow(
            "releases root must be an absolute non-root path"
        );
        const contract = managedDashboardUnitContract(options.releasesRoot);
        const properties = [
            `WorkingDirectory=${contract.releaseRoot}/backend`,
            `Environment=NODE_ENV=production MIRA_DASHBOARD_PROJECT_ROOT=${contract.projectRoot}`,
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
                properties.replace("NODE_ENV=production", "NODE_ENV=development"),
                contract
            )
        ).toThrow("missing stable managed release environment");
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
                    ` MIRA_DASHBOARD_PROJECT_ROOT=${contract.projectRoot}`,
                    ""
                ),
                contract
            )
        ).toThrow("MIRA_DASHBOARD_PROJECT_ROOT");
        expect(() =>
            assertManagedDashboardUnitProperties(
                "mira-dashboard.service",
                properties.replace(
                    ` MIRA_DASHBOARD_PROJECT_ROOT=${contract.projectRoot}`,
                    () => ` NOT_MIRA_DASHBOARD_PROJECT_ROOT=${contract.projectRoot}`
                ),
                contract
            )
        ).toThrow("MIRA_DASHBOARD_PROJECT_ROOT");
        expect(
            stageDashboardRelease("short", {
                ...options,
                commandRunner: () => Promise.try(() => ({ stderr: "", stdout: "" })),
            })
        ).rejects.toThrow("full lowercase Git SHA");
        expect(
            runReleaseDeploymentCommand(["unknown"], options.releasesRoot)
        ).rejects.toThrow("Usage");
        expect(
            runReleaseDeploymentCommand(["stage"], options.releasesRoot)
        ).rejects.toThrow("stage requires a commit SHA");
        expect(
            runReleaseDeploymentCommand(["prune", "2"], options.releasesRoot)
        ).rejects.toThrow("retention must be between 3 and 20");
        expect(
            runReleaseDeploymentCommand(["prune", "3", "extra"], options.releasesRoot)
        ).rejects.toThrow("unexpected arguments");
        expect(
            await runReleaseDeploymentCommand(["prune"], options.releasesRoot)
        ).toEqual({ removed: [], retained: [], warnings: [] });
    });
});
