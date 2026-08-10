import { describe, expect, test } from "bun:test";
import path from "node:path";

import { Redacted } from "effect";

import { deriveDashboardProjectLayout } from "../server/platform/filesystem/projectLayout.ts";
import type { PersistentGatewayTaskNotificationTransport } from "../server/platform/gateway/persistentGatewayTransport.ts";
import type { ProjectFileLogDestination } from "../server/platform/observability/projectFileLogSink.ts";
import type { RuntimeRelease } from "../server/platform/release/runtimeRelease.ts";
import type { ProcessTerminationController } from "../server/platform/runtime/processSignals.ts";
import {
    parseReleaseManifest,
    releaseBuildCommands,
    releaseProcessRoles,
} from "../shared/releaseManifest.ts";
import type { ManagedLogManifest } from "../worker/logs/managedLogManifest.ts";
import type { DashboardWorkerRuntime } from "../worker/runtime.ts";
import {
    createWorkerLogMaintenanceExecutor,
    type DashboardWorkerProcessDependencies,
    runDashboardWorkerProcess,
} from "./worker.ts";

const projectRoot = "/srv/mira-dashboard";
const openClawRoot = "/srv/openclaw";
const workspaceRoot = "/srv/mira-workspace";
const releaseId = "b".repeat(40);
const revision = "a".repeat(40);
const checksum = "c".repeat(64);
const layout = deriveDashboardProjectLayout(projectRoot);
const release: RuntimeRelease = Object.freeze({
    manifest: parseReleaseManifest({
        artifacts: [{ bytes: 3, path: "server/worker.js", sha256: checksum }],
        buildCommands: [...releaseBuildCommands],
        documentationSha256: checksum,
        formatVersion: 1,
        lockfileSha256: checksum,
        migrations: [
            {
                id: "20260804022252_dashboard-foundation",
                migrationSha256: checksum,
                snapshotSha256: checksum,
            },
        ],
        packages: [{ name: "effect", scope: "dependency", version: "4.0.0-beta.106" }],
        processRoles: [...releaseProcessRoles],
        runtime: { revision, version: "1.4.0" },
        source: { commitSha: releaseId, treeState: "clean" },
    }),
    releaseRoot: `${layout.production.releases}/${releaseId}`,
});

function processFixture(
    initializationFailure?: Error,
    runtimeFailure?: Error,
    runtimeStopsUnexpectedly = false,
    waitForForceDuringDisposal = false,
    runtimeCreationFailure?: Error,
    availabilityFailure?: Error,
    availabilityStartFailure?: Error
) {
    const events: string[] = [];
    const logLines: string[] = [];
    const forceSignals: Array<AbortSignal | undefined> = [];
    const forceController = new AbortController();
    let resolveDisposalStarted: (() => void) | undefined;
    const disposalStarted = new Promise<void>((resolve) => {
        resolveDisposalStarted = resolve;
    });
    let resolveCompletion: (() => void) | undefined;
    let rejectCompletion: ((error: unknown) => void) | undefined;
    const completion = new Promise<void>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
    });
    const destination = Object.freeze({
        fallbackWrite() {
            events.push("log-fallback");
        },
        sink: Object.freeze({
            flush(): undefined {
                events.push("log-flush");
                return;
            },
            write(line: string): undefined {
                logLines.push(line);
                events.push(
                    `log:${String((JSON.parse(line) as { event?: unknown }).event)}`
                );
                return;
            },
        }),
    } satisfies ProjectFileLogDestination);
    const gatewayTransport = Object.freeze({
        start() {
            events.push("gateway-start");
        },
        stop() {
            events.push("gateway-stop");
            return Promise.resolve();
        },
        taskNotificationSender: Object.freeze({
            send() {
                return Promise.resolve();
            },
        }),
    } satisfies PersistentGatewayTaskNotificationTransport);
    const termination: ProcessTerminationController = Object.freeze({
        dispose() {
            events.push("signals-dispose");
        },
        forceSignal: forceController.signal,
        termination:
            runtimeFailure !== undefined ||
            runtimeStopsUnexpectedly ||
            availabilityFailure !== undefined
                ? new Promise<"SIGTERM">(() => {})
                : Promise.resolve("SIGTERM" as const),
    });
    const logMaintenance = Object.freeze({
        availablePolicies: () => Promise.resolve(["docker-managed" as const]),
        run: () => Promise.resolve(),
    });
    const runtime: DashboardWorkerRuntime = Object.freeze({
        completion,
        dispose(forceSignal?: AbortSignal) {
            events.push("runtime-dispose");
            forceSignals.push(forceSignal);
            resolveDisposalStarted?.();
            if (waitForForceDuringDisposal) {
                if (forceSignal === undefined) {
                    return Promise.reject(
                        new Error("Runtime cleanup did not receive the force signal")
                    );
                }
                if (!forceSignal.aborted) {
                    return new Promise<void>((resolve) => {
                        forceSignal.addEventListener("abort", () => resolve(), {
                            once: true,
                        });
                    });
                }
            }
            resolveCompletion?.();
            return Promise.resolve();
        },
        initialize() {
            events.push("runtime-initialize");
            if (initializationFailure) {
                rejectCompletion?.(initializationFailure);
                return Promise.reject(initializationFailure);
            }
            if (runtimeFailure) {
                queueMicrotask(() => rejectCompletion?.(runtimeFailure));
            } else if (runtimeStopsUnexpectedly) {
                queueMicrotask(() => resolveCompletion?.());
            }
            return Promise.resolve();
        },
    });
    let terminalBrokerStopped = false;
    let availabilityStopped = false;
    let resolveAvailabilityCompletion!: () => void;
    let rejectAvailabilityCompletion!: (error: unknown) => void;
    const availabilityCompletion = new Promise<void>((resolve, reject) => {
        resolveAvailabilityCompletion = resolve;
        rejectAvailabilityCompletion = reject;
    });
    const dependencies = Object.freeze({
        createGatewayTransport(options) {
            events.push("gateway-create");
            expect(options.clientVersion).toBe(releaseId);
            expect(options.url).toBe("ws://127.0.0.1:18789/");
            expect(Redacted.value(options.token)).toBe("worker-gateway-token-test-value");
            return gatewayTransport;
        },
        createLogDestination(logsDirectory, processRole) {
            events.push(`logs:${processRole}:${logsDirectory}`);
            return destination;
        },
        createLogMaintenanceExecutor(observedLayout) {
            expect(observedLayout).toBe(layout);
            events.push("log-maintenance-create");
            return logMaintenance;
        },
        createRuntime(
            observedLayout,
            observedRelease,
            logger,
            observedGatewayTransport,
            observedWorkspaceRoot,
            observedOpenClawRoot,
            observedLogMaintenance
        ) {
            expect(observedLayout).toBe(layout);
            expect(observedRelease).toBe(release);
            expect(logger).toBeDefined();
            expect(observedGatewayTransport).toBe(gatewayTransport);
            expect(observedWorkspaceRoot).toEqual({
                id: "workspace",
                path: workspaceRoot,
                writable: true,
            });
            expect(observedOpenClawRoot).toEqual({
                id: "openclaw-config",
                path: openClawRoot,
                replacementManifest: [
                    {
                        maximumSizeBytes: 1_048_576,
                        segments: ["openclaw.json"],
                    },
                    {
                        maximumSizeBytes: 1_048_576,
                        segments: ["hooks", "transforms", "agentmail.ts"],
                    },
                ],
                writable: true,
            });
            expect(observedLogMaintenance).toBe(logMaintenance);
            expect(Object.keys(observedGatewayTransport).toSorted()).toEqual([
                "start",
                "stop",
                "taskNotificationSender",
            ]);
            events.push("runtime-create");
            if (runtimeCreationFailure !== undefined) {
                throw runtimeCreationFailure;
            }
            return runtime;
        },
        createTerminationController() {
            events.push("signals-create");
            return termination;
        },
        loadRelease(releasesDirectory, releaseRoot, processRole) {
            events.push(`release:${processRole}:${releasesDirectory}:${releaseRoot}`);
            return Promise.resolve(release);
        },
        resolveProjectLayout(observedProjectRoot) {
            events.push(`layout:${observedProjectRoot}`);
            return Promise.resolve(layout);
        },
        resolveOpenClawFileRoot(observedOpenClawRoot, observedProductionRoot) {
            expect(observedOpenClawRoot).toBe(openClawRoot);
            expect(observedProductionRoot).toBe(layout.production.root);
            events.push(`openclaw:${observedOpenClawRoot}`);
            return Promise.resolve(
                Object.freeze({
                    id: "openclaw-config",
                    path: openClawRoot,
                    replacementManifest: Object.freeze([
                        Object.freeze({
                            maximumSizeBytes: 1_048_576,
                            segments: Object.freeze(["openclaw.json"]),
                        }),
                        Object.freeze({
                            maximumSizeBytes: 1_048_576,
                            segments: Object.freeze([
                                "hooks",
                                "transforms",
                                "agentmail.ts",
                            ]),
                        }),
                    ]),
                    writable: true,
                })
            );
        },
        resolveWorkspaceFileRoot(observedWorkspaceRoot, observedProductionRoot) {
            expect(observedWorkspaceRoot).toBe(workspaceRoot);
            expect(observedProductionRoot).toBe(layout.production.root);
            events.push(`workspace:${observedWorkspaceRoot}`);
            return Promise.resolve(
                Object.freeze({
                    id: "workspace",
                    path: workspaceRoot,
                    writable: true,
                })
            );
        },
        startLogMaintenanceAvailability(options) {
            expect(options.availablePolicies).toBe(logMaintenance.availablePolicies);
            expect(options.logMaintenanceRoot).toBe(
                layout.production.state.logMaintenance
            );
            events.push("log-maintenance-availability-start");
            if (availabilityStartFailure !== undefined) {
                return Promise.reject(availabilityStartFailure);
            }
            if (availabilityFailure !== undefined) {
                queueMicrotask(() => rejectAvailabilityCompletion(availabilityFailure));
            }
            return Promise.resolve(
                Object.freeze({
                    completion: availabilityCompletion,
                    stop() {
                        if (!availabilityStopped) {
                            availabilityStopped = true;
                            events.push("log-maintenance-availability-stop");
                            resolveAvailabilityCompletion();
                        }
                        return Promise.resolve();
                    },
                })
            );
        },
        startTerminalBroker(options) {
            expect(options.projectRoot).toBe(layout.root);
            events.push("terminal-broker-start");
            return Promise.resolve(
                Object.freeze({
                    broker: {} as never,
                    socketPath: layout.production.state.terminalBrokerSocket,
                    stop() {
                        if (!terminalBrokerStopped) {
                            terminalBrokerStopped = true;
                            events.push("terminal-broker-stop");
                        }
                        return Promise.resolve();
                    },
                })
            );
        },
    } satisfies DashboardWorkerProcessDependencies);
    return {
        dependencies,
        disposalStarted,
        events,
        forceController,
        forceSignals,
        logLines,
    };
}

const processOptions = Object.freeze({
    configurationSource: {
        MIRA_DASHBOARD_LOG_LEVEL: "debug",
        MIRA_DASHBOARD_PROJECT_ROOT: projectRoot,
        MIRA_DASHBOARD_OPENCLAW_ROOT: openClawRoot,
        MIRA_DASHBOARD_WORKSPACE_ROOT: workspaceRoot,
        NODE_ENV: "production",
        OPENCLAW_GATEWAY_TOKEN: "worker-gateway-token-test-value",
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
    },
    releaseRoot: release.releaseRoot,
});

describe("Dashboard worker process", () => {
    test("binds managed rotation state to protected project-local paths", () => {
        let observedManifest: ManagedLogManifest | undefined;
        const executor = createWorkerLogMaintenanceExecutor(layout, {
            createManaged(manifest) {
                observedManifest = manifest;
                return {
                    run: () =>
                        Promise.resolve({
                            checkedTargets: 0,
                            dryRun: false,
                            finishedAtMs: 1,
                            ok: true,
                            results: [],
                            startedAtMs: 0,
                        }),
                    status: () =>
                        Promise.resolve({
                            observedAtMs: 1,
                            policyId: "docker-managed",
                            targetCount: 0,
                        }),
                };
            },
            createSystem: () => ({
                availablePolicies: () => Promise.resolve([]),
                run: () => Promise.resolve(),
            }),
        });

        expect(executor).toBeDefined();
        expect(observedManifest?.lockPath).toBe(
            path.join(layout.production.state.logMaintenance, "managed.lock")
        );
        expect(observedManifest?.statePath).toBe(
            path.join(layout.production.state.logMaintenance, "managed-state.json")
        );
        expect(
            observedManifest?.fileTargets
                .filter(({ id }) => id.startsWith("dashboard."))
                .every(({ filePath }) =>
                    filePath.startsWith(`${layout.production.state.logs}/`)
                )
        ).toBe(true);
    });

    test("validates its release and database before waiting for shutdown", async () => {
        const fixture = processFixture();

        await runDashboardWorkerProcess(processOptions, fixture.dependencies);

        expect(fixture.events).toEqual([
            `layout:${projectRoot}`,
            `release:worker:${layout.production.releases}:${release.releaseRoot}`,
            `workspace:${workspaceRoot}`,
            `openclaw:${openClawRoot}`,
            `logs:worker:${layout.production.state.logs}`,
            "signals-create",
            "terminal-broker-start",
            "gateway-create",
            "log-maintenance-create",
            "runtime-create",
            "runtime-initialize",
            "log-maintenance-availability-start",
            "log:runtime.started",
            "log-maintenance-availability-stop",
            "terminal-broker-stop",
            "runtime-dispose",
            "log:runtime.stopped",
            "signals-dispose",
            "log-flush",
        ]);
        expect(
            fixture.logLines.map((line) => (JSON.parse(line) as { event: string }).event)
        ).toEqual(["runtime.started", "runtime.stopped"]);
        expect(fixture.forceSignals).toEqual([
            expect.objectContaining({ aborted: false }),
        ]);
        expect(fixture.events.filter((event) => event === "gateway-create")).toHaveLength(
            1
        );
        expect(fixture.logLines.join("\n")).not.toContain(
            "worker-gateway-token-test-value"
        );
    });

    test("disposes partial ownership and reports a redacted startup failure", () => {
        const failure = new Error("private worker failure");
        const fixture = processFixture(failure);

        expect(
            runDashboardWorkerProcess(processOptions, fixture.dependencies)
        ).rejects.toBe(failure);

        expect(fixture.events).toContain("runtime-dispose");
        expect(fixture.events.slice(-2)).toEqual(["signals-dispose", "log-flush"]);
        const fatal = JSON.parse(fixture.logLines.at(-1) ?? "null") as {
            event: string;
            failure?: unknown;
        };
        expect(fatal.event).toBe("runtime.start_failed");
        expect(JSON.stringify(fatal)).not.toContain("private worker failure");
    });

    test("disposes and fails when the durable coordinator exits unexpectedly", async () => {
        const failure = new Error("private coordinator failure");
        const fixture = processFixture(undefined, failure);

        expect(
            await runDashboardWorkerProcess(processOptions, fixture.dependencies).catch(
                (error: unknown) => error
            )
        ).toBe(failure);

        expect(fixture.events).toContain("runtime-dispose");
        const fatal = JSON.parse(fixture.logLines.at(-1) ?? "null") as {
            event: string;
            failure?: unknown;
        };
        expect(fatal.event).toBe("runtime.start_failed");
        expect(JSON.stringify(fatal)).not.toContain("private coordinator failure");
    });

    test("fails and clears availability before disposing after a publisher defect", async () => {
        const failure = new Error("private availability publication failure");
        const fixture = processFixture(
            undefined,
            undefined,
            false,
            false,
            undefined,
            failure
        );

        expect(
            await runDashboardWorkerProcess(processOptions, fixture.dependencies).catch(
                (error: unknown) => error
            )
        ).toBe(failure);
        expect(fixture.events.indexOf("log-maintenance-availability-stop")).toBeLessThan(
            fixture.events.indexOf("terminal-broker-stop")
        );
        expect(fixture.events.indexOf("terminal-broker-stop")).toBeLessThan(
            fixture.events.indexOf("runtime-dispose")
        );
        expect(fixture.logLines.join("\n")).not.toContain(
            "private availability publication failure"
        );
    });

    test("disposes initialized ownership when the initial availability publish fails", async () => {
        const failure = new Error("private initial publication failure");
        const fixture = processFixture(
            undefined,
            undefined,
            false,
            false,
            undefined,
            undefined,
            failure
        );

        expect(
            await runDashboardWorkerProcess(processOptions, fixture.dependencies).catch(
                (error: unknown) => error
            )
        ).toBe(failure);
        expect(fixture.events).toContain("runtime-initialize");
        expect(fixture.events).not.toContain("log-maintenance-availability-stop");
        expect(fixture.events.indexOf("terminal-broker-stop")).toBeLessThan(
            fixture.events.indexOf("runtime-dispose")
        );
    });

    test("allows a second signal to force runtime-failure cleanup", async () => {
        const failure = new Error("private coordinator failure");
        const fixture = processFixture(undefined, failure, false, true);
        const execution = runDashboardWorkerProcess(processOptions, fixture.dependencies);

        await fixture.disposalStarted;
        expect(
            await Promise.race([
                execution.then(
                    () => "settled" as const,
                    () => "settled" as const
                ),
                Bun.sleep(10).then(() => "waiting" as const),
            ])
        ).toBe("waiting");

        fixture.forceController.abort(
            new DOMException("Forced process shutdown requested", "AbortError")
        );

        expect(await execution.catch((error: unknown) => error)).toBe(failure);
        expect(fixture.forceSignals).toEqual([fixture.forceController.signal]);
    });

    test("fails closed when the durable runtime resolves before a signal", async () => {
        const fixture = processFixture(undefined, undefined, true);

        expect(
            await runDashboardWorkerProcess(processOptions, fixture.dependencies).catch(
                (error: unknown) => error
            )
        ).toEqual(new Error("Dashboard worker runtime stopped unexpectedly"));

        expect(fixture.events).toContain("runtime-dispose");
        const fatal = JSON.parse(fixture.logLines.at(-1) ?? "null") as {
            event: string;
        };
        expect(fatal.event).toBe("runtime.start_failed");
    });

    test("stops an unowned Gateway transport when runtime construction fails", async () => {
        const failure = new Error("private runtime construction failure");
        const fixture = processFixture(undefined, undefined, false, false, failure);

        expect(
            await runDashboardWorkerProcess(processOptions, fixture.dependencies).catch(
                (error: unknown) => error
            )
        ).toBe(failure);
        expect(fixture.events).toContain("gateway-stop");
        expect(fixture.events).not.toContain("runtime-initialize");
        expect(fixture.logLines.join("\n")).not.toContain(
            "worker-gateway-token-test-value"
        );
    });
});
