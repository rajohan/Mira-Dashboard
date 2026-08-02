import path from "node:path";

import {
    prepareDevelopmentState,
    resolveDevelopmentStackConfig,
} from "../../development/developmentStack.ts";
import { safeInstallEnvironment } from "./commands.ts";
import { managedStateRoot } from "./state.ts";
import type { PullRequestPreviewConfig } from "./types.ts";

export function previewGatewayProxyUrl(config: PullRequestPreviewConfig): string {
    return `ws://127.0.0.1:${config.gatewayProxyPort}/gateway`;
}

export function preparePreviewState(
    config: PullRequestPreviewConfig,
    number: number,
    publicOrigin: string
): string {
    const stateRoot = managedStateRoot(config, number);
    const environment = {
        ...safeInstallEnvironment(config),
        MIRA_DASHBOARD_DEV_BACKEND_PORT: String(config.backendPort),
        MIRA_DASHBOARD_DEV_FRONTEND_PORT: String(config.frontendPort),
        MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE: config.gatewayTokenFile,
        MIRA_DASHBOARD_DEV_GATEWAY_URL: previewGatewayProxyUrl(config),
        MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN: publicOrigin,
        MIRA_DASHBOARD_DEV_STATE_ROOT: stateRoot,
        ...(config.sourceWebAuthnRpId && {
            MIRA_DASHBOARD_WEBAUTHN_RP_ID: config.sourceWebAuthnRpId,
        }),
        ...(config.openClawConfigSource && {
            MIRA_DASHBOARD_DEV_OPENCLAW_CONFIG_SOURCE: config.openClawConfigSource,
        }),
        ...(config.recentAuthMinutes && {
            MIRA_DASHBOARD_RECENT_AUTH_MINUTES: config.recentAuthMinutes,
        }),
        ...(config.databaseTemplate && {
            MIRA_DASHBOARD_DEV_DB_SOURCE: config.databaseTemplate,
        }),
        ...(config.releaseSource && {
            MIRA_DASHBOARD_DEV_RELEASES_SOURCE: config.releaseSource,
        }),
        ...(config.sessionIdleMinutes && {
            MIRA_DASHBOARD_SESSION_IDLE_MINUTES: config.sessionIdleMinutes,
        }),
        ...(config.workspaceSource && {
            MIRA_DASHBOARD_DEV_WORKSPACE_SOURCE: config.workspaceSource,
        }),
    };
    const developmentConfig = resolveDevelopmentStackConfig(
        environment,
        config.dashboardRoot
    );
    prepareDevelopmentState(developmentConfig);
    return stateRoot;
}

function sandboxDirectories(...targets: string[]): string[] {
    const directories = new Set<string>();
    for (const target of targets) {
        let current = path.dirname(target);
        const ancestors: string[] = [];
        while (current !== path.parse(current).root) {
            ancestors.push(current);
            current = path.dirname(current);
        }
        for (const ancestor of ancestors.toReversed()) directories.add(ancestor);
    }
    return [...directories];
}

/** Builds the filesystem-isolated process used by the transient preview unit. */
export function buildPullRequestPreviewSandboxCommand(input: {
    config: PullRequestPreviewConfig;
    publicOrigin: string;
    stateRoot: string;
    worktreePath: string;
}): string[] {
    const { config, publicOrigin, stateRoot, worktreePath } = input;
    const arguments_ = [
        "bwrap",
        "--unshare-all",
        "--share-net",
        "--die-with-parent",
        "--new-session",
        "--cap-drop",
        "ALL",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind-try",
        "/lib64",
        "/lib64",
        "--ro-bind",
        config.bunExecutable,
        "/bun",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/etc",
        "--ro-bind",
        "/etc/resolv.conf",
        "/etc/resolv.conf",
        "--dir",
        "/home",
        "--dir",
        "/home/dev",
        "--dir",
        "/run",
        "--dir",
        "/run/mira-dashboard-preview",
    ];
    for (const directory of sandboxDirectories(
        worktreePath,
        config.dashboardRoot,
        stateRoot
    )) {
        arguments_.push("--dir", directory);
    }
    const sandboxGatewayTokenFile = "/run/mira-dashboard-preview/gateway.token";
    arguments_.push(
        "--ro-bind",
        worktreePath,
        worktreePath,
        "--dir",
        config.dashboardRoot,
        "--ro-bind",
        config.gitCommonDirectory,
        config.gitCommonDirectory,
        "--bind",
        stateRoot,
        stateRoot,
        "--ro-bind",
        config.gatewayTokenFile,
        sandboxGatewayTokenFile,
        "--clearenv",
        "--setenv",
        "HOME",
        "/home/dev",
        "--setenv",
        "PATH",
        "/usr/bin:/bin",
        "--setenv",
        "MIRA_DASHBOARD_PROJECT_ROOT",
        config.projectRoot,
        "--setenv",
        "MIRA_DASHBOARD_DEV_BACKEND_PORT",
        String(config.backendPort),
        "--setenv",
        "MIRA_DASHBOARD_DEV_FRONTEND_PORT",
        String(config.frontendPort),
        "--setenv",
        "MIRA_DASHBOARD_DEV_GATEWAY_TOKEN_FILE",
        sandboxGatewayTokenFile,
        "--setenv",
        "MIRA_DASHBOARD_DEV_GATEWAY_URL",
        previewGatewayProxyUrl(config),
        "--setenv",
        "MIRA_DASHBOARD_DEV_HOT_RELOAD",
        "0",
        "--setenv",
        "MIRA_DASHBOARD_DEV_PUBLIC_ORIGIN",
        publicOrigin,
        "--setenv",
        "MIRA_DASHBOARD_DEV_STATE_ROOT",
        stateRoot
    );
    if (config.recentAuthMinutes) {
        arguments_.push(
            "--setenv",
            "MIRA_DASHBOARD_RECENT_AUTH_MINUTES",
            config.recentAuthMinutes
        );
    }
    if (config.sourceWebAuthnRpId) {
        arguments_.push(
            "--setenv",
            "MIRA_DASHBOARD_WEBAUTHN_RP_ID",
            config.sourceWebAuthnRpId
        );
    }
    if (config.sessionIdleMinutes) {
        arguments_.push(
            "--setenv",
            "MIRA_DASHBOARD_SESSION_IDLE_MINUTES",
            config.sessionIdleMinutes
        );
    }
    arguments_.push(
        "--chdir",
        worktreePath,
        "--",
        "/bun",
        path.join(worktreePath, "scripts", "developmentStack.ts")
    );
    return arguments_;
}
