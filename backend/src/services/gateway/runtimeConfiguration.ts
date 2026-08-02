import os from "node:os";
import Path from "node:path";

import {
    resolveDashboardProjectPathsForRuntime,
    resolveDashboardRuntimePath,
} from "../../lib/dashboardPaths.ts";
import {
    type DeviceIdentity,
    loadOrCreateDeviceIdentity,
    OpenClawGatewayClient,
    type OpenClawGatewayClientInstance,
    type OpenClawGatewayClientOptions,
} from "../../lib/openclawGatewayClient/client.ts";
import { nonEmptyEnvironmentFallback } from "../../lib/values.ts";

export type GatewayClientConstructor = new (
    options: OpenClawGatewayClientOptions
) => OpenClawGatewayClientInstance;

function validateOpenClawRoot(rootPath: string, environmentName: string): string {
    const resolved = Path.resolve(rootPath);
    if (!Path.isAbsolute(rootPath) || resolved === Path.parse(resolved).root) {
        throw new Error(`${environmentName} must be an absolute non-root path`);
    }
    return resolved;
}

function defaultOpenClawHome(): string {
    const homeDirectory = os.homedir();
    return homeDirectory
        ? Path.join(homeDirectory, ".openclaw")
        : Path.join(process.cwd(), "data", "openclaw");
}

const DEFAULT_DASHBOARD_OPENCLAW_HOME =
    resolveDashboardProjectPathsForRuntime()?.productionOpenClawHome ??
    Path.join(process.cwd(), "data", "openclaw-client");

/** Owns the mutable Gateway constructor and filesystem roots used by tests. */
export class GatewayRuntimeConfiguration {
    clientConstructor: GatewayClientConstructor = OpenClawGatewayClient;
    dashboardOpenClawHome = validateOpenClawRoot(
        resolveDashboardRuntimePath(
            resolveDashboardProjectPathsForRuntime()?.productionOpenClawHome,
            process.env.MIRA_DASHBOARD_OPENCLAW_HOME
        ) ?? DEFAULT_DASHBOARD_OPENCLAW_HOME,
        "MIRA_DASHBOARD_OPENCLAW_HOME"
    );
    openClawHome = validateOpenClawRoot(
        nonEmptyEnvironmentFallback("OPENCLAW_HOME", defaultOpenClawHome()).trim(),
        "OPENCLAW_HOME"
    );

    loadDashboardDeviceIdentity(
        onFailure: (error: unknown) => void,
        identityPath = Path.join(
            this.dashboardOpenClawHome,
            ".openclaw",
            "identity",
            "device.json"
        ),
        loader = loadOrCreateDeviceIdentity
    ): DeviceIdentity | undefined {
        try {
            return loader(identityPath);
        } catch (error) {
            onFailure(error);
            return undefined;
        }
    }

    setClientConstructorForTests(constructor: GatewayClientConstructor): () => void {
        const previousConstructor = this.clientConstructor;
        this.clientConstructor = constructor;
        return () => {
            this.clientConstructor = previousConstructor;
        };
    }

    setRootsForTests(roots: {
        dashboardOpenClawHome: string;
        openClawHome: string;
    }): () => void {
        const previousDashboardOpenClawHome = this.dashboardOpenClawHome;
        const previousOpenClawHome = this.openClawHome;
        this.dashboardOpenClawHome = validateOpenClawRoot(
            roots.dashboardOpenClawHome,
            "MIRA_DASHBOARD_OPENCLAW_HOME"
        );
        this.openClawHome = validateOpenClawRoot(roots.openClawHome, "OPENCLAW_HOME");
        return () => {
            this.dashboardOpenClawHome = previousDashboardOpenClawHome;
            this.openClawHome = previousOpenClawHome;
        };
    }
}
