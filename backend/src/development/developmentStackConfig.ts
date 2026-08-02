import { lstatSync } from "node:fs";
import { isIP } from "node:net";
import os from "node:os";
import path from "node:path";

import { dashboardProjectPaths } from "../lib/dashboardPaths.ts";

const DEVELOPMENT_SECRET_FILE = ".secret-encryption-key";
const RP_ID_PATTERN =
    /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*)$/u;
const MANAGED_STATE_BASENAME_PATTERN = /^pr-\d+$/u;
const DEFAULT_FRONTEND_PORT = 5173;
const DEFAULT_BACKEND_PORT = 3101;
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const HOST_OPENCLAW_LOGS_ROOT = "/tmp/openclaw";

function isRealDirectory(directoryPath: string): boolean {
    try {
        const stat = lstatSync(directoryPath);
        return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

export interface DevelopmentStackConfig {
    apiTarget: string;
    backendHost: string;
    backendPort: number;
    databasePath: string;
    databaseSource?: string;
    frontendHost: string;
    frontendPort: number;
    gatewayTokenFile?: string;
    gatewayUrl: string;
    hotReload: boolean;
    openClawClientHome: string;
    openClawConfigSource?: string;
    openClawHome: string;
    openClawLogMode: "host-read-only" | "synthetic";
    publicOrigin: string;
    releaseRoot: string;
    releaseSource?: string;
    repositoryRoot: string;
    rpId: string;
    secretEncryptionKeyPath: string;
    sourceWebAuthnRpId?: string;
    stateOwner: string;
    stateRoot: string;
    workspaceSource?: string;
}
function configuredPort(
    name: string,
    value: string | undefined,
    fallback: number
): number {
    const rawValue = value?.trim();
    if (!rawValue) {
        return fallback;
    }
    if (!/^\d+$/u.test(rawValue)) {
        throw new TypeError(`${name} must be an integer between 1 and 65535`);
    }
    const port = Number(rawValue);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        throw new TypeError(`${name} must be an integer between 1 and 65535`);
    }
    return port;
}

function isEnvironmentFlagEnabled(
    name: string,
    value: string | undefined,
    isEnabledByDefault: boolean
): boolean {
    const configured = value?.trim();
    if (!configured) return isEnabledByDefault;
    if (configured === "1") return true;
    if (configured === "0") return false;
    throw new TypeError(`${name} must be 0 or 1`);
}

function absoluteNonRootPath(
    name: string,
    value: string | undefined,
    fallback?: string
): string | undefined {
    const configured = value?.trim() || fallback;
    if (!configured) {
        return undefined;
    }
    if (!path.isAbsolute(configured)) {
        throw new TypeError(`${name} must be an absolute path`);
    }
    const resolved = path.resolve(configured);
    if (resolved === path.parse(resolved).root) {
        throw new TypeError(`${name} must not be a filesystem root`);
    }
    return resolved;
}

function normalizedPublicOrigin(value: string | undefined, frontendPort: number): URL {
    let origin: URL;
    try {
        origin = new URL(value?.trim() || `http://localhost:${frontendPort}`);
    } catch {
        throw new TypeError("MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN must be a valid URL");
    }
    const isLocalhost =
        origin.hostname === "localhost" || origin.hostname.endsWith(".localhost");
    const hasValidProtocol =
        origin.protocol === "https:" || (origin.protocol === "http:" && isLocalhost);
    if (
        !hasValidProtocol ||
        origin.username ||
        origin.password ||
        (origin.pathname !== "/" && origin.pathname !== "") ||
        origin.search ||
        origin.hash
    ) {
        throw new TypeError(
            "Development public origin must be HTTPS or local HTTP without credentials, path, query, or fragment"
        );
    }
    if (isIP(origin.hostname)) {
        throw new TypeError(
            "Development public origin must use localhost or a stable DNS hostname for WebAuthn"
        );
    }
    return origin;
}

function normalizedGatewayUrl(value: string | undefined): string | undefined {
    const configured = value?.trim();
    if (!configured) return undefined;
    let gatewayUrl: URL;
    try {
        gatewayUrl = new URL(configured);
    } catch {
        throw new TypeError("MIRA_DASHBOARD_DEV_GATEWAY_URL must be a valid URL");
    }
    if (
        !["ws:", "wss:"].includes(gatewayUrl.protocol) ||
        gatewayUrl.username ||
        gatewayUrl.password ||
        gatewayUrl.hash
    ) {
        throw new TypeError(
            "MIRA_DASHBOARD_DEV_GATEWAY_URL must be a ws:// or wss:// URL without credentials or a fragment"
        );
    }
    return gatewayUrl.href;
}

function normalizedOptionalRpId(
    name: string,
    value: string | undefined
): string | undefined {
    const rpId = value?.trim().toLowerCase();
    if (!rpId) return undefined;
    if (rpId.length > 253 || !RP_ID_PATTERN.test(rpId) || isIP(rpId)) {
        throw new TypeError(`${name} must be a stable DNS relying-party id`);
    }
    return rpId;
}

/**
 * Resolves one isolated frontend/backend development stack.
 * @returns Resolved one isolated frontend/backend development stack.
 */
export function resolveDevelopmentStackConfig(
    environment: Record<string, string | undefined>,
    root: string
): DevelopmentStackConfig {
    const resolvedRepoRoot = path.resolve(root);
    const frontendPort = configuredPort(
        "MIRA_DASHBOARD_DEV_FRONTEND_PORT",
        environment.MIRA_DASHBOARD_DEV_FRONTEND_PORT,
        DEFAULT_FRONTEND_PORT
    );
    const backendPort = configuredPort(
        "MIRA_DASHBOARD_DEV_BACKEND_PORT",
        environment.MIRA_DASHBOARD_DEV_BACKEND_PORT,
        DEFAULT_BACKEND_PORT
    );
    if (frontendPort === backendPort) {
        throw new TypeError("Frontend and backend development ports must be distinct");
    }
    const hostHome = absoluteNonRootPath(
        "HOME",
        environment.HOME,
        environment.HOME?.trim() || os.homedir()
    );
    if (!hostHome) {
        throw new Error("Could not resolve the host home for development snapshots");
    }
    const hostDashboardPaths = dashboardProjectPaths(
        environment.MIRA_DASHBOARD_PROJECT_ROOT?.trim() ||
            path.join(hostHome, "projects", "mira-dashboard")
    );
    const stateRoot = absoluteNonRootPath(
        "MIRA_DASHBOARD_DEV_STATE_ROOT",
        environment.MIRA_DASHBOARD_DEV_STATE_ROOT,
        hostDashboardPaths.developmentLocalStateRoot
    );
    if (!stateRoot) {
        throw new Error("Development state root could not be resolved");
    }
    const stateBasename = path.basename(stateRoot);
    const isManagedPreviewState =
        path.dirname(stateRoot) ===
            path.join(hostDashboardPaths.developmentPreviewStateRoot, "states") &&
        MANAGED_STATE_BASENAME_PATTERN.test(stateBasename);
    const publicOrigin = normalizedPublicOrigin(
        environment.MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN,
        frontendPort
    );
    const gatewayTokenFile = absoluteNonRootPath(
        "MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE",
        environment.MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE
    );
    const gatewayUrl = normalizedGatewayUrl(environment.MIRA_DASHBOARD_DEV_GATEWAY_URL);
    const openClawSourceRoot = absoluteNonRootPath(
        "OPENCLAW_HOME",
        environment.OPENCLAW_HOME,
        path.join(hostHome, ".openclaw")
    );

    return {
        apiTarget: `http://127.0.0.1:${backendPort}`,
        backendHost: "127.0.0.1",
        backendPort,
        databasePath: path.join(stateRoot, "mira-dashboard.db"),
        databaseSource: absoluteNonRootPath(
            "MIRA_DASHBOARD_DEV_DB_SOURCE",
            environment.MIRA_DASHBOARD_DEV_DB_SOURCE,
            hostDashboardPaths.productionDatabasePath
        ),
        frontendHost: "127.0.0.1",
        frontendPort,
        gatewayTokenFile,
        gatewayUrl: gatewayUrl || DEFAULT_GATEWAY_URL,
        hotReload: isEnvironmentFlagEnabled(
            "MIRA_DASHBOARD_DEV_HOT_RELOAD",
            environment.MIRA_DASHBOARD_DEV_HOT_RELOAD,
            true
        ),
        openClawClientHome: path.join(stateRoot, "openclaw-client"),
        openClawConfigSource: absoluteNonRootPath(
            "MIRA_DASHBOARD_DEV_OPENCLAW_CONFIG_SOURCE",
            environment.MIRA_DASHBOARD_DEV_OPENCLAW_CONFIG_SOURCE,
            openClawSourceRoot
                ? path.join(openClawSourceRoot, "openclaw.json")
                : undefined
        ),
        openClawHome: path.join(stateRoot, "openclaw-home"),
        openClawLogMode:
            !isManagedPreviewState && isRealDirectory(HOST_OPENCLAW_LOGS_ROOT)
                ? "host-read-only"
                : "synthetic",
        publicOrigin: publicOrigin.origin,
        releaseRoot: path.join(stateRoot, "releases-root"),
        releaseSource: absoluteNonRootPath(
            "MIRA_DASHBOARD_DEV_RELEASES_SOURCE",
            environment.MIRA_DASHBOARD_DEV_RELEASES_SOURCE,
            hostDashboardPaths.productionReleasesRoot
        ),
        repositoryRoot: resolvedRepoRoot,
        rpId: publicOrigin.hostname.toLowerCase(),
        secretEncryptionKeyPath: path.join(stateRoot, DEVELOPMENT_SECRET_FILE),
        sourceWebAuthnRpId: normalizedOptionalRpId(
            "MIRA_DASHBOARD_WEBAUTHN_RP_ID",
            environment.MIRA_DASHBOARD_WEBAUTHN_RP_ID
        ),
        stateOwner: isManagedPreviewState
            ? `managed-${stateBasename}`
            : "local-dashboard-dev",
        stateRoot,
        workspaceSource: absoluteNonRootPath(
            "MIRA_DASHBOARD_DEV_WORKSPACE_SOURCE",
            environment.MIRA_DASHBOARD_DEV_WORKSPACE_SOURCE,
            openClawSourceRoot ? path.join(openClawSourceRoot, "workspace") : undefined
        ),
    };
}
