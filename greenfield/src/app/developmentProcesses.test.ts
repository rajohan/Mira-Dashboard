import { describe, expect, test } from "bun:test";

import { Redacted } from "effect";

import { rejectionError } from "../../scripts/testSupport/rejection.ts";
import {
    dockerFreeJobActionDefinitions,
    dockerOverviewCacheJobActionKey,
    dockerUpdaterJobActionKey,
    managedPreviewJobActionDefinitions,
} from "../server/domains/jobs/actionRegistry.ts";
import { deriveDashboardProjectLayout } from "../server/platform/filesystem/projectLayout.ts";
import type {
    PersistentGatewayTransport,
    PersistentGatewayTransportOptions,
} from "../server/platform/gateway/persistentGatewayTransport.ts";
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
    withoutDevelopmentDockerScheduleDefinitions,
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
        const source = createDevelopmentRuntimeRelease(projectRoot, sourceCommit);
        const layout = deriveDashboardProjectLayout(projectRoot);
        const logger = createTestStructuredLogger();
        const configuration = Object.freeze({
            gatewayToken: Redacted.make("development-gateway-token"),
            gatewayUrl: "ws://127.0.0.1:18789",
        });
        const gatewayTransport = Object.freeze({}) as PersistentGatewayTransport;
        const runtime = Object.freeze({}) as DashboardApplicationRuntime;
        let gatewayOptions: PersistentGatewayTransportOptions | undefined;
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
                createGatewayTransport(options) {
                    gatewayOptions = options;
                    return gatewayTransport;
                },
            }
        );

        expect(result).toBe(runtime);
        expect(gatewayOptions).toEqual({
            clientVersion: sourceCommit,
            token: configuration.gatewayToken,
            url: configuration.gatewayUrl,
        });
        expect(runtimeOptions).toEqual({
            database: {
                migrationsDirectory: `${projectRoot}/migrations`,
                releaseId: sourceCommit,
                startupMode: "initialize-empty",
                stateDirectory: layout.production.state.root,
            },
            logger,
            persistentGatewayTransport: gatewayTransport,
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

    test("does not expose production Docker capabilities to development", () => {
        const dependencies = withoutDevelopmentDockerCapabilities(
            createDefaultDashboardWorkerProcessDependencies()
        );

        expect("createDocker" in dependencies).toBe(false);
        expect("startDockerBroker" in dependencies).toBe(false);
    });

    test("injects the Docker-free schedule registry only into development web", async () => {
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
            withoutDevelopmentDockerScheduleDefinitions(productionDependencies);
        const serverOptions = Object.freeze({}) as DashboardServerOptions;

        await productionDependencies.createServer(serverOptions);
        expect(observedDefinitions).toBeUndefined();

        await developmentDependencies.createServer(serverOptions);
        expect(observedDefinitions).toBe(dockerFreeJobActionDefinitions);
        expect(observedDefinitions?.map(({ actionKey }) => actionKey)).not.toContain(
            dockerOverviewCacheJobActionKey
        );
        expect(observedDefinitions?.map(({ actionKey }) => actionKey)).not.toContain(
            dockerUpdaterJobActionKey
        );
    });

    test("limits both managed-preview processes to the worker smoke action", async () => {
        let observedDefinitions: DashboardServerOptions["jobActionDefinitions"];
        const applicationServer = Object.freeze({
            port: 0,
            stop: () => Promise.resolve(),
            url: new URL("http://127.0.0.1:3100/"),
        } satisfies ApplicationServer);
        const dependencies = withoutDevelopmentDockerScheduleDefinitions(
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
        expect(developmentWorkerActionDefinitions(false)).toBeUndefined();
        expect(
            managedPreviewJobActionDefinitions.map(({ actionKey }) => actionKey)
        ).toEqual(["system.worker-smoke"]);
    });
});
