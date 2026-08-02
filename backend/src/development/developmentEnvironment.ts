import { readFileSync } from "node:fs";
import path from "node:path";

import { hasLineBreakOrNullByte } from "../lib/values.ts";
import { developmentAppLogPath, developmentOpenClawLogsRoot } from "./developmentLogs.ts";
import type { DevelopmentStackConfig } from "./developmentStackConfig.ts";
import { developmentSecretEncryptionKey, isRealRegularFile } from "./developmentState.ts";

const INHERITED_ENVIRONMENT_KEYS = [
    "COLORTERM",
    "DBUS_SESSION_BUS_ADDRESS",
    "FORCE_COLOR",
    "LANG",
    "LC_ALL",
    "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
    "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
    "NO_COLOR",
    "PATH",
    "TERM",
    "TMPDIR",
    "TZ",
    "XDG_RUNTIME_DIR",
] as const;

function inheritedChildEnvironment(): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const key of INHERITED_ENVIRONMENT_KEYS) {
        const value = process.env[key];
        if (value !== undefined) {
            environment[key] = value;
        }
    }
    return environment;
}

function developmentGatewayToken(
    config: DevelopmentStackConfig,
    environment: Record<string, string | undefined> = process.env
): string {
    let token: string | undefined;
    if (config.gatewayTokenFile) {
        if (!isRealRegularFile(config.gatewayTokenFile)) {
            throw new Error(
                `MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE must be a real regular file: ${config.gatewayTokenFile}`
            );
        }
        token = readFileSync(config.gatewayTokenFile, "utf8").trim();
    } else {
        token = environment.OPENCLAW_GATEWAY_TOKEN?.trim();
    }
    if (!token || token.length > 16_384 || hasLineBreakOrNullByte(token)) {
        throw new Error(
            "Dashboard dev requires OPENCLAW_GATEWAY_TOKEN or MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE"
        );
    }
    return token;
}

/**
 * Produces the explicit, secret-minimized backend development environment.
 * @returns Development backend environment result.
 */
export function developmentBackendEnvironment(
    config: DevelopmentStackConfig
): Record<string, string> {
    const gatewayToken = developmentGatewayToken(config);
    return {
        ...inheritedChildEnvironment(),
        HOME: config.openClawHome,
        MIRA_DASHBOARD_ALLOWED_ORIGINS: config.publicOrigin,
        MIRA_DASHBOARD_APPLICATION_LOG_PATH: developmentAppLogPath(config),
        MIRA_DASHBOARD_DB_PATH: config.databasePath,
        MIRA_DASHBOARD_DEV_COOKIE_NAMESPACE: `mira_dashboard_dev_${config.frontendPort}`,
        MIRA_DASHBOARD_DEV_SAFE_MODE: "1",
        MIRA_DASHBOARD_FRONTEND_PATH: path.join(config.repositoryRoot, "frontend"),
        MIRA_DASHBOARD_HOST: config.backendHost,
        MIRA_DASHBOARD_LOG_ROTATION_LOCK_FILE: path.join(
            config.stateRoot,
            "log-rotation.lock"
        ),
        MIRA_DASHBOARD_LOGS_ROOT: developmentOpenClawLogsRoot(config),
        MIRA_DASHBOARD_OPENCLAW_HOME: config.openClawClientHome,
        MIRA_DASHBOARD_RELEASES_ROOT: config.releaseRoot,
        MIRA_DASHBOARD_ROOT: config.repositoryRoot,
        MIRA_DASHBOARD_SECRET_ENCRYPTION_KEY: developmentSecretEncryptionKey(config),
        MIRA_DASHBOARD_WEBAUTHN_ORIGINS: config.publicOrigin,
        MIRA_DASHBOARD_WEBAUTHN_RP_ID: config.rpId,
        MIRA_DASHBOARD_WORKTREE_ROOT: path.dirname(config.repositoryRoot),
        NODE_ENV: "development",
        OPENCLAW_HOME: config.openClawHome,
        PORT: String(config.backendPort),
        OPENCLAW_GATEWAY_URL: config.gatewayUrl,
        OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    };
}

export function frontendEnvironment(
    config: DevelopmentStackConfig
): Record<string, string> {
    return {
        ...inheritedChildEnvironment(),
        DASHBOARD_API_TARGET: config.apiTarget,
        HOST: config.frontendHost,
        MIRA_DASHBOARD_DEV_COOKIE_NAMESPACE: `mira_dashboard_dev_${config.frontendPort}`,
        MIRA_DASHBOARD_DEV_HOT_RELOAD: config.hotReload ? "1" : "0",
        MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: config.publicOrigin,
        PORT: String(config.frontendPort),
    };
}
