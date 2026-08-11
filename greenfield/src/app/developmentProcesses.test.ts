import { describe, expect, test } from "bun:test";

import { Redacted } from "effect";

import { rejectionError } from "../../scripts/testSupport/rejection.ts";
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
    createDevelopmentWebRuntime,
    runDevelopmentWebProcess,
} from "./developmentWeb.ts";
import { runDevelopmentWorkerProcess } from "./developmentWorker.ts";

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
});
