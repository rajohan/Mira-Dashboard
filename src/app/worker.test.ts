import { describe, expect, test } from "bun:test";
import path from "node:path";

import { Redacted } from "effect";

import type {
    DeliveryWorkerCompositionAuthority,
    DeliveryWorkerCompositionFactory,
} from "../server/domains/jobs/workerRuntime.ts";
import { deriveDashboardProjectLayout } from "../server/platform/filesystem/projectLayout.ts";
import type { PersistentGatewayTaskNotificationTransport } from "../server/platform/gateway/persistentGatewayTransport.ts";
import type { ProjectFileLogDestination } from "../server/platform/observability/projectFileLogSink.ts";
import type { RuntimeRelease } from "../server/platform/release/runtimeRelease.ts";
import type { ProcessTerminationController } from "../server/platform/runtime/processSignals.ts";
import type { ManagedLogManifest } from "../shared/managedLogManifest.ts";
import {
    parseReleaseManifest,
    releaseBuildCommands,
    releaseDeliveryProtocols,
    releaseProcessRoles,
} from "../shared/releaseManifest.ts";
import type {
    DeliveryPreviewExecutionPort,
    DeliveryProductionExecutionPort,
} from "../worker/delivery/runtime.ts";
import type { DashboardWorkerRuntime } from "../worker/runtime.ts";
import {
    createDefaultDashboardWorkerProcessDependencies,
    createWorkerDeliveryComposition,
    createWorkerDeliveryProcessComposition,
    createWorkerDockerComposition,
    createWorkerLogMaintenanceExecutor,
    type DashboardWorkerProcessDependencies,
    type WorkerDeliveryProcessCompositionOptions,
    type WorkerDockerCompositionOptions,
    runDashboardWorkerProcess,
} from "./worker.ts";

const projectRoot = "/srv/mira-dashboard";
const openClawRoot = "/srv/openclaw";
const workspaceRoot = "/srv/mira-workspace";
const releaseId = "b".repeat(40);
const revision = "a".repeat(40);
const checksum = "c".repeat(64);
const bootIdentity = "00000000-0000-0000-0000-000000000001";
const layout = deriveDashboardProjectLayout(projectRoot);
const release: RuntimeRelease = Object.freeze({
    manifest: parseReleaseManifest({
        artifacts: [{ bytes: 3, path: "server/worker.js", sha256: checksum }],
        buildCommands: [...releaseBuildCommands],
        deliveryProtocols: [...releaseDeliveryProtocols],
        display: { builtAtMs: 1, commitTitle: "Test release", schemaTarget: 1 },
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

const unusedDeliveryPreview = Object.freeze({
    start: () => Promise.reject(new Error("Unused preview start")),
    status: () => Promise.reject(new Error("Unused preview status")),
    stop: () => Promise.reject(new Error("Unused preview stop")),
}) satisfies DeliveryPreviewExecutionPort;

const unusedDeliveryProduction = Object.freeze({
    execute: () => Promise.reject(new Error("Unused production execution")),
}) satisfies DeliveryProductionExecutionPort;

const deliveryCompositionAuthority = Object.freeze({
    readActionActive: () => Promise.resolve(false),
    readActivePreviewOperation: () => Promise.resolve(undefined),
    readPrevious() {
        return;
    },
}) satisfies DeliveryWorkerCompositionAuthority;

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
        requestOpenClawServiceAction: () =>
            Promise.reject(new Error("OpenClaw operations are unavailable in fixture")),
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
        run: () => Promise.resolve(undefined),
    });
    const openClawGateway = Object.freeze({
        restart: () => Promise.resolve(),
    });
    const openClawServiceActions = Object.freeze({
        cleanupSessions: () => Promise.reject(new Error("fixture cleanup unavailable")),
        updateInstallation: () => Promise.reject(new Error("fixture update unavailable")),
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
        createDatabaseObservabilityConnectionResolver(options) {
            events.push("database-observability-discovery-create");
            expect(Object.keys(options.credentials)).toEqual(["password"]);
            expect(Redacted.value(options.credentials.password)).toBe(
                "database-observer-password"
            );
            return Object.freeze({
                resolve: () =>
                    Promise.reject(
                        new Error("Database discovery is not used by this fixture")
                    ),
            });
        },
        createDatabaseObservabilityReconciler(options) {
            events.push("database-observability-reconciler-create");
            expect(options).toEqual({
                bunExecutable: path.join(
                    layout.production.runtimes,
                    "bun",
                    revision,
                    "bun"
                ),
                releaseRoot: release.releaseRoot,
            });
            return Object.freeze({
                async withApprovedCollection<T>(
                    operation: (status: "unchanged", signal: AbortSignal) => Promise<T>
                ) {
                    const value = await operation(
                        "unchanged",
                        new AbortController().signal
                    );
                    return { reconciliationStatus: "unchanged" as const, value };
                },
            });
        },
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
        createWorkspaceGitSync(observedOpenClawRoot) {
            expect(observedOpenClawRoot).toBe(openClawRoot);
            return () => Promise.resolve({ changedFileCount: 0, pushed: false });
        },
        createOpenClawGatewayLifecycle(observedOpenClawRoot) {
            expect(observedOpenClawRoot).toBe(openClawRoot);
            return openClawGateway;
        },
        createOpenClawServiceActions(observedGatewayTransport) {
            expect(observedGatewayTransport).toBe(gatewayTransport);
            return openClawServiceActions;
        },
        createRuntime(
            observedLayout,
            observedRelease,
            logger,
            observedGatewayTransport,
            observedOpenClawGateway,
            observedOpenClawServiceActions,
            observedWorkspaceRoot,
            observedOpenClawRoot,
            observedLogMaintenance,
            _observedMoltbook,
            observedOverviewProviders,
            observedDatabaseObservability,
            observedDatabaseObservabilityReconciler,
            observedHostOperations,
            observedBootIdentity,
            _observedDocker,
            observedCreateDelivery
        ) {
            expect(observedLayout).toBe(layout);
            expect(observedRelease).toBe(release);
            expect(logger).toBeDefined();
            expect(observedGatewayTransport).toBe(gatewayTransport);
            expect(observedOpenClawGateway).toBe(openClawGateway);
            expect(observedOpenClawServiceActions).toBe(openClawServiceActions);
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
                        backupPolicy: "sibling-dot-bak",
                        maximumSizeBytes: 2_097_152,
                        segments: ["openclaw.json"],
                    },
                    {
                        backupPolicy: "sibling-dot-bak",
                        maximumSizeBytes: 2_097_152,
                        segments: ["hooks", "transforms", "agentmail.ts"],
                    },
                ],
                writable: true,
            });
            expect(observedLogMaintenance).toBe(logMaintenance);
            expect(observedOverviewProviders.git).toBeFunction();
            expect(observedOverviewProviders.quota).toBeFunction();
            expect(observedOverviewProviders.weather).toBeFunction();
            expect(observedDatabaseObservability.collect).toBeFunction();
            if (observedDatabaseObservabilityReconciler !== undefined) {
                expect(
                    observedDatabaseObservabilityReconciler.withApprovedCollection
                ).toBeFunction();
            }
            expect(observedHostOperations).toBeUndefined();
            expect(observedBootIdentity).toBe(bootIdentity);
            if (observedCreateDelivery !== undefined) {
                events.push("delivery-factory-passed");
            }
            expect(Object.keys(observedGatewayTransport).toSorted()).toEqual([
                "requestOpenClawServiceAction",
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
                            backupPolicy: "sibling-dot-bak",
                            maximumSizeBytes: 2_097_152,
                            segments: Object.freeze(["openclaw.json"]),
                        }),
                        Object.freeze({
                            backupPolicy: "sibling-dot-bak",
                            maximumSizeBytes: 2_097_152,
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
        readBootIdentity() {
            return Promise.resolve(bootIdentity);
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
        MOLTBOOK_API_KEY: "worker-moltbook-key-test-value",
        NODE_ENV: "production",
        OPENCLAW_GATEWAY_TOKEN: "worker-gateway-token-test-value",
        OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
    },
    releaseRoot: release.releaseRoot,
});

function deliveryGitHubCredentials(includeReviewer = false) {
    return Object.freeze({
        ordinary: Object.freeze({
            token: Redacted.make("mira-token-long-enough-for-composition"),
            username: Redacted.make("mira-2026"),
        }),
        ...(includeReviewer
            ? {
                  reviewerToken: Redacted.make(
                      "raymond-token-long-enough-for-composition"
                  ),
              }
            : {}),
    });
}

describe("Delivery worker composition", () => {
    test("stays unavailable when only reviewer authority is configured", () => {
        expect(
            createWorkerDeliveryComposition({
                checkoutRoot: layout.production.checkout,
                githubCredentials: {
                    reviewerToken: Redacted.make(
                        "raymond-token-long-enough-for-composition"
                    ),
                },
                preview: unusedDeliveryPreview,
                releasesDirectory: layout.production.releases,
                stateDirectory: layout.production.state.root,
            })
        ).toBeUndefined();
    });

    test("fails closed when no preview mutation authority is supplied", () => {
        const factory = createWorkerDeliveryComposition({
            checkoutRoot: layout.production.checkout,
            githubCredentials: deliveryGitHubCredentials(),
            releasesDirectory: layout.production.releases,
            stateDirectory: layout.production.state.root,
        });

        expect(factory).toBeFunction();
        expect(() => factory!(deliveryCompositionAuthority)).toThrow(
            "Delivery preview authority is unavailable"
        );
    });

    test("binds explicit preview, production, and separated reviewer capabilities", () => {
        let observedProduction:
            | Parameters<
                  NonNullable<
                      Parameters<
                          typeof createWorkerDeliveryComposition
                      >[0]["createProduction"]
                  >
              >[0]
            | undefined;
        const factory = createWorkerDeliveryComposition({
            checkoutRoot: layout.production.checkout,
            createPreview: () => {
                throw new Error("Explicit preview authority must win");
            },
            createProduction(input) {
                observedProduction = input;
                return unusedDeliveryProduction;
            },
            githubCredentials: deliveryGitHubCredentials(true),
            preview: unusedDeliveryPreview,
            previewControlsAvailable: false,
            releasesDirectory: layout.production.releases,
            stateDirectory: layout.production.state.root,
        });

        const runtime = factory!(deliveryCompositionAuthority);

        expect(Object.keys(runtime).toSorted()).toEqual([
            "execute",
            "readPrevious",
            "refresh",
        ]);
        expect(observedProduction?.preview).toBe(unusedDeliveryPreview);
        expect(observedProduction?.authority.readExact).toBeFunction();
        expect(observedProduction?.authority.readForOperation).toBeFunction();
        expect(observedProduction?.github.listOpenPullRequests).toBeFunction();
        expect(observedProduction?.mainGit.inspect).toBeFunction();
        expect(observedProduction?.mainGit.syncMainToExactRef).toBeFunction();
        expect(runtime.readPrevious("pull-requests")).toBeUndefined();
    });

    test("creates preview authority from the ordinary GitHub port when requested", () => {
        let previewCreated = false;
        const factory = createWorkerDeliveryComposition({
            checkoutRoot: layout.production.checkout,
            createPreview(github) {
                previewCreated = true;
                expect(github.getPullRequest).toBeFunction();
                return unusedDeliveryPreview;
            },
            githubCredentials: deliveryGitHubCredentials(),
            releasesDirectory: layout.production.releases,
            stateDirectory: layout.production.state.root,
        });

        const runtime = factory!(deliveryCompositionAuthority);

        expect(previewCreated).toBe(true);
        expect(runtime.execute).toBeFunction();
    });

    test("keeps the production process composition unavailable without Mira", () => {
        expect(
            createWorkerDeliveryProcessComposition({
                gatewayTransport: {} as never,
                githubCredentials: {
                    reviewerToken: Redacted.make(
                        "raymond-token-long-enough-for-composition"
                    ),
                },
                layout,
                port: 3100,
                release,
            })
        ).toBeUndefined();
    });

    test("builds immutable preview and cutover capabilities without executing them", () => {
        const factory = createWorkerDeliveryProcessComposition({
            gatewayTransport: {} as never,
            githubCredentials: deliveryGitHubCredentials(true),
            layout,
            port: 3100,
            release,
        });

        expect(factory).toBeFunction();
        const runtime = factory!(deliveryCompositionAuthority);

        expect(Object.keys(runtime).toSorted()).toEqual([
            "execute",
            "readPrevious",
            "refresh",
        ]);
        expect(runtime.execute).toBeFunction();
        expect(runtime.refresh).toBeFunction();
    });
});

describe("Dashboard worker process", () => {
    test("composes the fixed host-operation broker only in production defaults", () => {
        expect(
            createDefaultDashboardWorkerProcessDependencies().createHostOperations
        ).toBeFunction();
    });

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

    test("composes dynamic database discovery from the observer password only", async () => {
        const fixture = processFixture();

        await runDashboardWorkerProcess(
            {
                ...processOptions,
                configurationSource: {
                    ...processOptions.configurationSource,
                    MIRA_DASHBOARD_DATABASE_OBSERVABILITY_PASSWORD:
                        "database-observer-password",
                },
            },
            fixture.dependencies
        );

        expect(fixture.events).toContain("database-observability-discovery-create");
        expect(fixture.events).toContain("database-observability-reconciler-create");
    });

    test("passes optional registry and Git credentials only to Docker updater boundaries", async () => {
        const fixture = processFixture();
        let observedOptions: WorkerDockerCompositionOptions | undefined;
        const dependencies = Object.freeze({
            ...fixture.dependencies,
            createDocker(options: WorkerDockerCompositionOptions) {
                observedOptions = options;
                return createWorkerDockerComposition(options);
            },
        }) satisfies DashboardWorkerProcessDependencies;
        const registrySecrets = Object.freeze({
            DOCKER_LOGIN: "docker-user-sentinel",
            DOCKER_TOKEN: "docker-token-sentinel",
            MIRA_GITHUB_USERNAME: "github-user-sentinel",
            MIRA_GITHUB_TOKEN: "github-token-sentinel",
        });

        await runDashboardWorkerProcess(
            {
                ...processOptions,
                configurationSource: {
                    ...processOptions.configurationSource,
                    ...registrySecrets,
                },
            },
            dependencies
        );

        expect(Object.keys(observedOptions ?? {})).toEqual([
            "gitCredentials",
            "registryCredentials",
        ]);
        const credentials = observedOptions?.registryCredentials;
        expect(Object.keys(credentials ?? {})).toEqual([
            "docker.io",
            "ghcr.io",
            "lscr.io",
        ]);
        expect(Redacted.value(credentials!["docker.io"]!.username)).toBe(
            registrySecrets.DOCKER_LOGIN
        );
        expect(Redacted.value(credentials!["docker.io"]!.password)).toBe(
            registrySecrets.DOCKER_TOKEN
        );
        expect(credentials!["ghcr.io"]).toBe(credentials!["lscr.io"]);
        expect(observedOptions?.gitCredentials).toBe(credentials!["ghcr.io"]);
        expect(Redacted.value(credentials!["ghcr.io"]!.username)).toBe(
            registrySecrets.MIRA_GITHUB_USERNAME
        );
        expect(Redacted.value(credentials!["ghcr.io"]!.password)).toBe(
            registrySecrets.MIRA_GITHUB_TOKEN
        );
        expect(Object.isFrozen(credentials)).toBe(true);
        expect(Object.isFrozen(credentials!["docker.io"])).toBe(true);
        expect(Object.isFrozen(credentials!["ghcr.io"])).toBe(true);
        for (const secret of Object.values(registrySecrets)) {
            expect(JSON.stringify(observedOptions)).not.toContain(secret);
            expect(Bun.inspect(observedOptions)).not.toContain(secret);
            expect(fixture.logLines.join("\n")).not.toContain(secret);
        }
    });

    test("passes configured GitHub authority through the late Delivery factory seam", async () => {
        const fixture = processFixture();
        const deliveryFactory = (() => {
            throw new Error(
                "Late Delivery factory is not invoked by this process fixture"
            );
        }) satisfies DeliveryWorkerCompositionFactory;
        const dependencies = Object.freeze({
            ...fixture.dependencies,
            createDelivery(options: WorkerDeliveryProcessCompositionOptions) {
                expect(options.layout).toBe(layout);
                expect(options.release).toBe(release);
                const ordinary = options.githubCredentials.ordinary;
                if (ordinary === undefined) {
                    throw new Error("Fixture ordinary GitHub credentials are missing");
                }
                expect(Redacted.value(ordinary.username)).toBe("mira-2026");
                expect(Redacted.value(ordinary.token)).toBe(
                    "mira-token-long-enough-for-composition"
                );
                const reviewerToken = options.githubCredentials.reviewerToken;
                if (reviewerToken === undefined) {
                    throw new Error("Fixture reviewer GitHub credential is missing");
                }
                expect(Redacted.value(reviewerToken)).toBe(
                    "raymond-token-long-enough-for-composition"
                );
                return deliveryFactory;
            },
        }) satisfies DashboardWorkerProcessDependencies;

        await runDashboardWorkerProcess(
            {
                ...processOptions,
                configurationSource: {
                    ...processOptions.configurationSource,
                    MIRA_GITHUB_TOKEN: "mira-token-long-enough-for-composition",
                    MIRA_GITHUB_USERNAME: "mira-2026",
                    RAJOHAN_GITHUB_TOKEN: "raymond-token-long-enough-for-composition",
                },
            },
            dependencies
        );

        expect(fixture.events).toContain("delivery-factory-passed");
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
