import { afterEach, describe, expect, it, jest } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    bootstrapProductionDashboard,
    initializeProductionBootstrapDatabase,
    type ProductionBootstrapCommandRunner,
    runProductionBootstrapCommand,
} from "../../../scripts/productionBootstrap.ts";
import { dashboardProjectPaths } from "../../src/lib/dashboardPaths.ts";
import { MANAGED_DASHBOARD_UNIT_NAMES } from "../../src/services/releases/systemdPolicy.ts";
import { captureRejection } from "../support/rejections.ts";

const COMMIT_SHA = "a".repeat(40);
const OTHER_COMMIT_SHA = "b".repeat(40);
const temporaryRoots: string[] = [];

function temporaryProjectRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), "mira-production-bootstrap-"));
    temporaryRoots.push(root);
    const paths = dashboardProjectPaths(root);
    mkdirSync(paths.productionCheckoutRoot, { recursive: true });
    return root;
}

function commandRunner(
    sourceRoot: string,
    calls: string[],
    statusOutput = ""
): ProductionBootstrapCommandRunner {
    return (command, arguments_, options) => {
        calls.push(`${command} ${arguments_.join(" ")}`);
        if (command === "git" && arguments_[1] === "--show-toplevel") {
            return Promise.resolve({ stderr: "", stdout: `${sourceRoot}\n` });
        }
        if (command === "git" && arguments_[0] === "status") {
            return Promise.resolve({ stderr: "", stdout: statusOutput });
        }
        if (command === "git" && arguments_[1] === "--verify") {
            return Promise.resolve({ stderr: "", stdout: `${COMMIT_SHA}\n` });
        }
        if (command === "/usr/bin/systemctl" && arguments_[1] === "is-enabled") {
            return Promise.resolve({ stderr: "", stdout: "enabled\n" });
        }
        if (command === "/usr/bin/systemctl" && arguments_[1] === "show") {
            return Promise.resolve({
                stderr: "",
                stdout: "ActiveState=active\nResult=success\nSubState=running\n",
            });
        }
        expect(options.cwd).toBeUndefined();
        return Promise.resolve({ stderr: "", stdout: "" });
    };
}

afterEach(() => {
    for (const root of temporaryRoots) {
        rmSync(root, { force: true, recursive: true });
    }
    temporaryRoots.length = 0;
});

describe("production bootstrap", () => {
    it("runs bounded child commands and initializes the production database", async () => {
        expect(
            await runProductionBootstrapCommand("/usr/bin/printf", ["ready"], {
                timeoutMs: 5000,
            })
        ).toEqual({ stderr: "", stdout: "ready" });
        const commandError = await captureRejection(() =>
            runProductionBootstrapCommand("/usr/bin/false", [], {
                timeoutMs: 5000,
            })
        );
        expect(commandError).toBeInstanceOf(Error);
        expect((commandError as Error).message).toContain(
            "/usr/bin/false failed with exit code 1"
        );
        expect(
            await runProductionBootstrapCommand("/usr/bin/false", [], {
                allowNonZeroExit: true,
                timeoutMs: 5000,
            })
        ).toEqual({ stderr: "", stdout: "" });

        await initializeProductionBootstrapDatabase();
    });

    it("initializes, stages, activates, enables, and verifies a blank host", async () => {
        const root = temporaryProjectRoot();
        const paths = dashboardProjectPaths(root);
        const calls: string[] = [];
        const progress: string[] = [];
        const lifecycle: string[] = [];
        let databaseInitialized = false;

        const result = await bootstrapProductionDashboard({
            activateRelease: (commitSha) => {
                expect(commitSha).toBe(COMMIT_SHA);
                lifecycle.push("activate");
                return Promise.resolve();
            },
            commandRunner: commandRunner(paths.productionCheckoutRoot, calls),
            environment: {
                MIRA_DASHBOARD_PROJECT_ROOT: root,
                NODE_ENV: "production",
            },
            initializeDatabase: () => {
                databaseInitialized = true;
                lifecycle.push("database");
                return Promise.resolve();
            },
            onProgress: (message) => {
                progress.push(message);
            },
            paths,
            readReleaseSlots: () => Promise.resolve({}),
            serviceStabilizationMs: 0,
            stageRelease: (commitSha) => {
                expect(databaseInitialized).toBe(true);
                expect(commitSha).toBe(COMMIT_SHA);
                lifecycle.push("stage");
                return Promise.resolve({
                    commitSha,
                    path: path.join(paths.productionReleasesRoot, "releases", commitSha),
                });
            },
        });

        expect(result).toMatchObject({
            commitSha: COMMIT_SHA,
            databasePath: paths.productionDatabasePath,
            services: MANAGED_DASHBOARD_UNIT_NAMES.map((name) => ({
                activeState: "active",
                enabled: true,
                name,
                subState: "running",
            })),
        });
        expect(lifecycle).toEqual(["database", "stage", "activate"]);
        expect(progress).toEqual([
            "Preparing managed production directories",
            "Verifying clean production checkout",
            "Initializing and verifying production SQLite",
            "Staging the initial managed release",
            "Activating release and reconciling managed systemd units",
            "Enabling and restarting Dashboard services",
            "Dashboard production bootstrap completed",
        ]);
        expect(calls).toContain(
            `/usr/bin/systemctl --user enable ${MANAGED_DASHBOARD_UNIT_NAMES.join(" ")}`
        );
        expect(calls).toContain(
            `/usr/bin/systemctl --user restart ${MANAGED_DASHBOARD_UNIT_NAMES.join(" ")}`
        );
        for (const unit of MANAGED_DASHBOARD_UNIT_NAMES) {
            expect(calls).toContain(`/usr/bin/systemctl --user is-enabled ${unit}`);
            expect(calls).toContain(
                `/usr/bin/systemctl --user show ${unit} --property=ActiveState --property=Result --property=SubState --no-pager`
            );
        }
        for (const directory of [
            paths.developmentWorktreeRoot,
            paths.productionReleasesRoot,
            paths.productionBunRuntimeRoot,
        ]) {
            expect(statSync(directory).mode & 0o777).toBe(0o755);
        }
        for (const directory of [
            paths.productionStateRoot,
            paths.productionOpenClawHome,
        ]) {
            expect(statSync(directory).mode & 0o777).toBe(0o700);
        }
    });

    it("rejects non-production mode and a dirty checkout", async () => {
        const root = temporaryProjectRoot();
        const paths = dashboardProjectPaths(root);

        const environmentError = await captureRejection(() =>
            bootstrapProductionDashboard({
                environment: { NODE_ENV: "development" },
                paths,
            })
        );
        expect(environmentError).toBeInstanceOf(Error);
        expect((environmentError as Error).message).toContain(
            "requires NODE_ENV=production"
        );

        const dirtyCheckoutError = await captureRejection(() =>
            bootstrapProductionDashboard({
                commandRunner: commandRunner(
                    paths.productionCheckoutRoot,
                    [],
                    " M package.json\n"
                ),
                environment: { NODE_ENV: "production" },
                paths,
            })
        );
        expect(dirtyCheckoutError).toBeInstanceOf(Error);
        expect((dirtyCheckoutError as Error).message).toContain(
            "requires a clean production checkout"
        );
    });

    it("refuses to replace an already managed different release", async () => {
        const root = temporaryProjectRoot();
        const paths = dashboardProjectPaths(root);
        const initializeDatabase = jest.fn(() => Promise.resolve());
        const stageRelease = jest.fn(() =>
            Promise.resolve({ commitSha: COMMIT_SHA, path: "unexpected" })
        );

        const existingReleaseError = await captureRejection(() =>
            bootstrapProductionDashboard({
                commandRunner: commandRunner(paths.productionCheckoutRoot, []),
                environment: { NODE_ENV: "production" },
                initializeDatabase,
                paths,
                readReleaseSlots: () => Promise.resolve({ current: OTHER_COMMIT_SHA }),
                stageRelease,
            })
        );
        expect(existingReleaseError).toBeInstanceOf(Error);
        expect((existingReleaseError as Error).message).toContain(
            "use the normal deployment path"
        );
        expect(initializeDatabase).not.toHaveBeenCalled();
        expect(stageRelease).not.toHaveBeenCalled();
    });

    it("restarts repaired units when rerunning the current release", async () => {
        const root = temporaryProjectRoot();
        const paths = dashboardProjectPaths(root);
        const calls: string[] = [];

        await bootstrapProductionDashboard({
            activateRelease: () => Promise.resolve(),
            commandRunner: commandRunner(paths.productionCheckoutRoot, calls),
            environment: { NODE_ENV: "production" },
            initializeDatabase: () => Promise.resolve(),
            paths,
            readReleaseSlots: () => Promise.resolve({ current: COMMIT_SHA }),
            serviceStabilizationMs: 0,
            stageRelease: (commitSha) => Promise.resolve({ commitSha, path: "release" }),
        });

        const enableIndex = calls.indexOf(
            `/usr/bin/systemctl --user enable ${MANAGED_DASHBOARD_UNIT_NAMES.join(" ")}`
        );
        const restartIndex = calls.indexOf(
            `/usr/bin/systemctl --user restart ${MANAGED_DASHBOARD_UNIT_NAMES.join(" ")}`
        );
        expect(enableIndex).toBeGreaterThan(-1);
        expect(restartIndex).toBeGreaterThan(enableIndex);
    });

    it("polls transient service startup state until both units are healthy", async () => {
        const root = temporaryProjectRoot();
        const paths = dashboardProjectPaths(root);
        const baseRunner = commandRunner(paths.productionCheckoutRoot, []);
        let stateChecks = 0;
        const settlingRunner: ProductionBootstrapCommandRunner = (
            command,
            arguments_,
            options
        ) => {
            if (command === "/usr/bin/systemctl" && arguments_[1] === "show") {
                stateChecks += 1;
                if (stateChecks === 1) {
                    return Promise.resolve({
                        stderr: "",
                        stdout: "ActiveState=activating\nResult=success\nSubState=start\n",
                    });
                }
            }
            return baseRunner(command, arguments_, options);
        };

        await bootstrapProductionDashboard({
            activateRelease: () => Promise.resolve(),
            commandRunner: settlingRunner,
            environment: { NODE_ENV: "production" },
            initializeDatabase: () => Promise.resolve(),
            paths,
            readReleaseSlots: () => Promise.resolve({}),
            serviceStabilizationMs: 10,
            stageRelease: (commitSha) => Promise.resolve({ commitSha, path: "release" }),
        });

        expect(stateChecks).toBe(MANAGED_DASHBOARD_UNIT_NAMES.length + 1);
    });

    it("fails closed for invalid slots, staged identity, and service state", async () => {
        const invalidDelayError = await captureRejection(() =>
            bootstrapProductionDashboard({
                environment: { NODE_ENV: "production" },
                paths: dashboardProjectPaths(temporaryProjectRoot()),
                serviceStabilizationMs: -1,
            })
        );
        expect(invalidDelayError).toBeInstanceOf(RangeError);

        const slotRoot = temporaryProjectRoot();
        const slotPaths = dashboardProjectPaths(slotRoot);
        const invalidSlotsError = await captureRejection(() =>
            bootstrapProductionDashboard({
                commandRunner: commandRunner(slotPaths.productionCheckoutRoot, []),
                environment: { NODE_ENV: "production" },
                paths: slotPaths,
                readReleaseSlots: () => Promise.resolve({ previous: OTHER_COMMIT_SHA }),
            })
        );
        expect((invalidSlotsError as Error).message).toContain(
            "previous release without current"
        );

        const stagedRoot = temporaryProjectRoot();
        const stagedPaths = dashboardProjectPaths(stagedRoot);
        const stagedIdentityError = await captureRejection(() =>
            bootstrapProductionDashboard({
                commandRunner: commandRunner(stagedPaths.productionCheckoutRoot, []),
                environment: { NODE_ENV: "production" },
                initializeDatabase: () => Promise.resolve(),
                paths: stagedPaths,
                readReleaseSlots: () => Promise.resolve({}),
                stageRelease: () =>
                    Promise.resolve({
                        commitSha: OTHER_COMMIT_SHA,
                        path: "unexpected",
                    }),
            })
        );
        expect((stagedIdentityError as Error).message).toContain(
            "staged an unexpected release"
        );

        const serviceRoot = temporaryProjectRoot();
        const servicePaths = dashboardProjectPaths(serviceRoot);
        const baseRunner = commandRunner(servicePaths.productionCheckoutRoot, []);
        const disabledServiceRunner: ProductionBootstrapCommandRunner = (
            command,
            arguments_,
            options
        ) => {
            if (command === "/usr/bin/systemctl" && arguments_[1] === "is-enabled") {
                return Promise.resolve({ stderr: "", stdout: "disabled\n" });
            }
            return baseRunner(command, arguments_, options);
        };
        const disabledServiceError = await captureRejection(() =>
            bootstrapProductionDashboard({
                activateRelease: () => Promise.resolve(),
                commandRunner: disabledServiceRunner,
                environment: { NODE_ENV: "production" },
                initializeDatabase: () => Promise.resolve(),
                paths: servicePaths,
                readReleaseSlots: () => Promise.resolve({}),
                serviceStabilizationMs: 0,
                stageRelease: (commitSha) =>
                    Promise.resolve({ commitSha, path: "release" }),
            })
        );
        expect((disabledServiceError as Error).message).toContain(
            "was not persistently enabled"
        );
    });
});
