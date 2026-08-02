import os from "node:os";
import path from "node:path";

import { resolveDashboardProjectPaths } from "../../lib/dashboardPaths.ts";
import { hasLineBreakOrNullByte } from "../../lib/values.ts";
import { isRealRegularFile } from "./fileSystem.ts";
import { resolvePullRequestPreviewAllowedAuthors } from "./policy.ts";
import type { PullRequestPreviewConfig } from "./types.ts";

const PREVIEW_UNIT = "mira-dashboard-pr-preview.service";
const PREVIEW_GATEWAY_PROXY_UNIT = "mira-dashboard-pr-preview-gateway.service";
const PREVIEW_RECORD_FILE = "active-preview.json";
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const DEFAULT_GATEWAY_PROXY_PORT = 18_790;
const DEFAULT_PREVIEW_BACKEND_PORT = 3101;
const DEFAULT_PREVIEW_FRONTEND_PORT = 5173;
const PREVIEW_GATEWAY_PROXY_ENTRYPOINT = "pullRequestPreviewGatewayProxy.js";

function absoluteNonRootPath(name: string, value: string): string {
    if (!path.isAbsolute(value)) {
        throw new TypeError(`${name} must be an absolute non-root path`);
    }
    const resolved = path.resolve(value);
    if (resolved === path.parse(resolved).root) {
        throw new TypeError(`${name} must be an absolute non-root path`);
    }
    return resolved;
}

function configuredGatewayUrl(value: string | undefined): string | undefined {
    const configured = value?.trim();
    if (!configured) return undefined;
    let url: URL;
    try {
        url = new URL(configured);
    } catch {
        throw new TypeError("OPENCLAW_GATEWAY_URL must be a valid URL");
    }
    if (
        !["ws:", "wss:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.hash
    ) {
        throw new TypeError(
            "OPENCLAW_GATEWAY_URL must be ws:// or wss:// without credentials or a fragment"
        );
    }
    return url.href;
}

function optionalEnvironmentValue(
    name: string,
    value: string | undefined
): string | undefined {
    const configured = value?.trim();
    if (!configured) return undefined;
    if (hasLineBreakOrNullByte(configured)) {
        throw new TypeError(`${name} must be a single environment value`);
    }
    return configured;
}

function defaultGatewayProxyEntrypoint(): string {
    const runtimeEntrypoint = process.argv[1];
    if (runtimeEntrypoint && path.isAbsolute(runtimeEntrypoint)) {
        const builtEntrypoint = path.join(
            path.dirname(runtimeEntrypoint),
            PREVIEW_GATEWAY_PROXY_ENTRYPOINT
        );
        if (isRealRegularFile(builtEntrypoint)) {
            return builtEntrypoint;
        }
    }
    return path.resolve(
        import.meta.dirname,
        "../..",
        "pullRequestPreviewGatewayProxy.ts"
    );
}

/**
 * Resolves the single-slot managed PR preview host contract.
 * @param environment Environment used to resolve host paths and ports.
 * @returns Validated pull request preview configuration.
 */
export function resolvePullRequestPreviewConfig(
    environment: Record<string, string | undefined> = process.env
): PullRequestPreviewConfig {
    const projectPaths = resolveDashboardProjectPaths(environment);
    const dashboardRoot = projectPaths.productionCheckoutRoot;
    const previewRoot = projectPaths.developmentPreviewStateRoot;
    const managedWorktreePath = projectPaths.developmentPreviewRoot;
    const openClawSourceRoot = absoluteNonRootPath(
        "OPENCLAW_HOME",
        environment.OPENCLAW_HOME?.trim() ||
            path.join(environment.HOME?.trim() || os.homedir(), ".openclaw")
    );
    const allowedAuthors = resolvePullRequestPreviewAllowedAuthors();
    return {
        allowedAuthors,
        backendPort: DEFAULT_PREVIEW_BACKEND_PORT,
        bunExecutable: absoluteNonRootPath("Bun executable", process.execPath),
        dashboardRoot,
        databaseTemplate: projectPaths.productionDatabasePath,
        frontendPort: DEFAULT_PREVIEW_FRONTEND_PORT,
        gatewayProxyEntrypoint: defaultGatewayProxyEntrypoint(),
        gatewayProxyIdentityFile: path.join(previewRoot, "gateway-proxy-identity.json"),
        gatewayProxyPort: DEFAULT_GATEWAY_PROXY_PORT,
        gatewayProxyUnitName: PREVIEW_GATEWAY_PROXY_UNIT,
        gatewayTokenFile: path.join(previewRoot, "gateway.token"),
        gatewayUpstreamTokenFile: path.join(previewRoot, "gateway-upstream.token"),
        gatewayUrl:
            configuredGatewayUrl(environment.OPENCLAW_GATEWAY_URL) || DEFAULT_GATEWAY_URL,
        gitCommonDirectory: path.join(dashboardRoot, ".git"),
        managedWorktreePath,
        openClawConfigSource: path.join(openClawSourceRoot, "openclaw.json"),
        previewRoot,
        projectRoot: projectPaths.projectRoot,
        recentAuthMinutes: optionalEnvironmentValue(
            "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
            environment.MIRA_DASHBOARD_RECENT_AUTH_MINUTES
        ),
        releaseSource: projectPaths.productionReleasesRoot,
        sessionIdleMinutes: optionalEnvironmentValue(
            "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
            environment.MIRA_DASHBOARD_SESSION_IDLE_MINUTES
        ),
        sourceWebAuthnRpId: optionalEnvironmentValue(
            "MIRA_DASHBOARD_WEBAUTHN_RP_ID",
            environment.MIRA_DASHBOARD_WEBAUTHN_RP_ID
        ),
        stateFile: path.join(previewRoot, PREVIEW_RECORD_FILE),
        unitName: PREVIEW_UNIT,
        workspaceSource: path.join(openClawSourceRoot, "workspace"),
    };
}
