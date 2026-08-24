import { describe, expect, test } from "bun:test";

import { Redacted } from "effect";

import { rejectionError } from "../../scripts/testSupport/rejection.ts";
import {
    jobActionDefinitions,
    managedPreviewJobActionDefinitions,
} from "../server/domains/jobs/actionRegistry.ts";
import {
    sourceDevelopmentExecutableJobActionDefinitions,
    sourceDevelopmentScheduledJobActionDefinitions,
} from "../server/domains/jobs/sourceDevelopmentActionComposition.ts";
import { deriveDashboardProjectLayout } from "../server/platform/filesystem/projectLayout.ts";
import type {
    PersistentGatewayTransport,
    PersistentGatewayTransportOptions,
} from "../server/platform/gateway/persistentGatewayTransport.ts";
import type { SourceDevelopmentGatewayTransportOptions } from "../server/platform/gateway/sourceDevelopmentGatewayTransport.ts";
import { createDevelopmentRuntimeRelease } from "../server/platform/release/developmentRuntimeRelease.ts";
import type {
    DashboardApplicationRuntime,
    DashboardApplicationRuntimeOptions,
} from "../server/platform/runtime/applicationRuntime.ts";
import { createTestStructuredLogger } from "../server/test/support/requestContext.ts";
import {
    type DashboardServerOptions,
    type DashboardWebProcessDependencies,
    createDefaultDashboardWebProcessDependencies,
} from "./dashboardServer.ts";
import {
    createDevelopmentWebRuntime,
    runDevelopmentWebProcess,
    withSourceDevelopmentScheduleDefinitions,
} from "./developmentWeb.ts";
import {
    developmentWorkerActionDefinitions,
    runDevelopmentWorkerProcess,
    withoutDevelopmentDockerCapabilities,
} from "./developmentWorker.ts";
import type { ApplicationServer } from "./server.ts";
import { createDefaultDashboardWorkerProcessDependencies } from "./worker.ts";

describe("development process entrypoints", () => {
    test("composes the web runtime from isolated source-backed state", () => {
        const projectRoot = "/srv/mira-dashboard";
        const sourceCommit = "d".repeat(40);
        const source = createDevelopmentRuntimeRelease(
            projectRoot,
            sourceCommit,
            Bun.version
        );
        const layout = deriveDashboardProjectLayout(projectRoot);
        const logger = createTestStructuredLogger();
        const configuration = Object.freeze({
            gatewayToken: Redacted.make("development-gateway-token"),
            gatewayUrl: "ws://127.0.0.1:18789",
        });
        const gatewayTransport = Object.freeze({}) as PersistentGatewayTransport;
        const sourceDevelopmentTransport = Object.freeze(
            {}
        ) as PersistentGatewayTransport;
        const runtime = Object.freeze({}) as DashboardApplicationRuntime;
        let gatewayOptions: PersistentGatewayTransportOptions | undefined;
        let sourceDevelopmentOptions:
            | SourceDevelopmentGatewayTransportOptions
            | undefined;
        let runtimeOptions: DashboardApplicationRuntimeOptions | undefined;

        const result = createDevelopmentWebRuntime(
            configuration,
            layout,
            source,
            logger,
            {
                createApplicationRuntime(options) {
                    runtimeOptions = options;
                    return runtime;
                },
                createReadGatewayTransport(options) {
                    gatewayOptions = options;
                    return gatewayTransport;
                },
                createSourceDevelopmentGatewayTransport(options) {
                    sourceDevelopmentOptions = options;
                    return sourceDevelopmentTransport;
                },
            }
        );

        expect(result).toBe(runtime);
        expect(gatewayOptions).toEqual({
            clientVersion: sourceCommit,
            token: configuration.gatewayToken,
            url: configuration.gatewayUrl,
        });
        expect(sourceDevelopmentOptions).toEqual({
            readTransport: gatewayTransport,
            stateRoot: projectRoot,
        });
        expect(runtimeOptions).toEqual({
            database: {
                migrationsDirectory: `${projectRoot}/migrations`,
                releaseId: sourceCommit,
                startupMode: "initialize-empty",
                stateDirectory: layout.production.state.root,
            },
            logger,
            persistentGatewayTransport: sourceDevelopmentTransport,
        });
    });

    test("rejects a missing web source commit before composition", async () => {
        const failure = await rejectionError(runDevelopmentWebProcess([]));

        expect(failure.message).toBe("Development web requires one exact source commit");
    });

    test("rejects a missing worker source commit before composition", async () => {
        const failure = await rejectionError(runDevelopmentWorkerProcess([]));

        expect(failure.message).toBe(
            "Development worker requires one exact source commit"
        );
    });

    test("removes production Docker and cutover authority while retaining fixed brokers", async () => {
        const productionDependencies = createDefaultDashboardWorkerProcessDependencies();
        const dependencies = withoutDevelopmentDockerCapabilities(productionDependencies);
        const createCutoverRuntime = dependencies.createCutoverRuntime;
        const detectCutoverValidation = dependencies.detectCutoverValidation;
        const reconcileCutoverValidation = dependencies.reconcileCutoverValidation;
        if (
            createCutoverRuntime === undefined ||
            detectCutoverValidation === undefined ||
            reconcileCutoverValidation === undefined
        ) {
            throw new Error("Development cutover guards are missing");
        }

        expect("createDocker" in dependencies).toBe(false);
        expect(dependencies.startDockerBroker).toBeFunction();
        expect(createCutoverRuntime).not.toBe(
            productionDependencies.createCutoverRuntime
        );
        expect(reconcileCutoverValidation).not.toBe(
            productionDependencies.reconcileCutoverValidation
        );
        expect(await detectCutoverValidation("/isolated/dev/state")).toBeFalse();
        expect(() =>
            createCutoverRuntime(
                undefined as never,
                undefined as never,
                undefined as never,
                undefined as never
            )
        ).toThrow("Production cutover runtime is unavailable in development");
        const recoveryFailure = await rejectionError(
            reconcileCutoverValidation(undefined as never, undefined as never, 3206)
        );
        expect(recoveryFailure.message).toBe(
            "Production cutover recovery is unavailable in development"
        );
    });

    test("injects the complete production-shaped schedule inventory", async () => {
        let observedDefinitions: DashboardServerOptions["jobActionDefinitions"];
        const applicationServer = Object.freeze({
            port: 0,
            stop: () => Promise.resolve(),
            url: new URL("http://127.0.0.1:3100/"),
        } satisfies ApplicationServer);
        const productionDependencies = Object.freeze({
            ...createDefaultDashboardWebProcessDependencies(),
            createServer(options) {
                observedDefinitions = options.jobActionDefinitions;
                return Promise.resolve(applicationServer);
            },
        } satisfies DashboardWebProcessDependencies);
        const developmentDependencies =
            withSourceDevelopmentScheduleDefinitions(productionDependencies);
        const serverOptions = Object.freeze({}) as DashboardServerOptions;

        await productionDependencies.createServer(serverOptions);
        expect(observedDefinitions).toBeUndefined();

        await developmentDependencies.createServer(serverOptions);
        expect(observedDefinitions).toBe(sourceDevelopmentScheduledJobActionDefinitions);
        expect(observedDefinitions?.map(({ actionKey }) => actionKey)).toEqual(
            jobActionDefinitions.map(({ actionKey }) => actionKey)
        );
        const executableKeys = new Set(
            developmentWorkerActionDefinitions(false).map(({ actionKey }) => actionKey)
        );
        expect(
            observedDefinitions?.every(({ actionKey }) => executableKeys.has(actionKey))
        ).toBeTrue();
        expect(developmentWorkerActionDefinitions(false)).toBe(
            sourceDevelopmentExecutableJobActionDefinitions
        );
    });

    test("limits both managed-preview processes to the worker smoke action", async () => {
        let observedDefinitions: DashboardServerOptions["jobActionDefinitions"];
        const applicationServer = Object.freeze({
            port: 0,
            stop: () => Promise.resolve(),
            url: new URL("http://127.0.0.1:3100/"),
        } satisfies ApplicationServer);
        const dependencies = withSourceDevelopmentScheduleDefinitions(
            Object.freeze({
                ...createDefaultDashboardWebProcessDependencies(),
                createServer(options: DashboardServerOptions) {
                    observedDefinitions = options.jobActionDefinitions;
                    return Promise.resolve(applicationServer);
                },
            }),
            managedPreviewJobActionDefinitions
        );

        await dependencies.createServer(Object.freeze({}) as DashboardServerOptions);

        expect(observedDefinitions).toBe(managedPreviewJobActionDefinitions);
        expect(developmentWorkerActionDefinitions(true)).toBe(
            managedPreviewJobActionDefinitions
        );
        expect(developmentWorkerActionDefinitions(false)).toBe(
            sourceDevelopmentExecutableJobActionDefinitions
        );
        expect(
            managedPreviewJobActionDefinitions.map(({ actionKey }) => actionKey)
        ).toEqual(["system.worker-smoke"]);
    });

    for (const profile of [
        { managedPreview: false, name: "ordinary" },
        { managedPreview: true, name: "managed-preview" },
    ] as const) {
        for (const startupOrder of [
            ["web", "worker"],
            ["worker", "web"],
        ] as const) {
            test(`disables cutover reconciliation for ${profile.name} ${startupOrder.join("-first-")} startup`, async () => {
                const webDependencies = withSourceDevelopmentScheduleDefinitions(
                    createDefaultDashboardWebProcessDependencies(),
                    profile.managedPreview
                        ? managedPreviewJobActionDefinitions
                        : sourceDevelopmentScheduledJobActionDefinitions
                );
                const workerDependencies = withoutDevelopmentDockerCapabilities(
                    createDefaultDashboardWorkerProcessDependencies()
                );
                const dependenciesByRole = Object.freeze({
                    web: webDependencies,
                    worker: workerDependencies,
                });

                for (const role of startupOrder) {
                    const detectCutoverValidation =
                        dependenciesByRole[role].detectCutoverValidation;
                    if (detectCutoverValidation === undefined) {
                        throw new Error("Development cutover detector is missing");
                    }
                    expect(
                        await detectCutoverValidation("/isolated/development/state")
                    ).toBeFalse();
                }

                expect(developmentWorkerActionDefinitions(profile.managedPreview)).toBe(
                    profile.managedPreview
                        ? managedPreviewJobActionDefinitions
                        : sourceDevelopmentExecutableJobActionDefinitions
                );
            });
        }
    }
});
