import path from "node:path";

import type {
    PullRequestPreviewLifecycle,
    PullRequestPreviewStatus,
} from "../../../../contracts/delivery.ts";
import { errorMessage } from "../../lib/errors.ts";
import { runProcess } from "../../lib/processes.ts";
import { parseSystemdProperties } from "../../lib/systemdProperties.ts";
import { runCommand } from "./commands.ts";
import { resolvePullRequestPreviewConfig } from "./config.ts";
import { removeMaterializedGatewayCredentials } from "./credentials.ts";
import {
    ensurePrivateSingleLinkFile,
    ensureRealDirectory,
    isRealRegularFile,
} from "./fileSystem.ts";
import { readPreviewRecord, writePreviewRecord } from "./record.ts";
import { disableOwnedTailscaleServe } from "./tailscale.ts";
import type { PullRequestPreviewConfig, PullRequestPreviewRecord } from "./types.ts";

const PREVIEW_READY_TIMEOUT_MS = 90_000;
const PREVIEW_READY_POLL_MS = 500;
const PREVIEW_GATEWAY_PROXY_READY_TIMEOUT_MS = 45_000;
const PREVIEW_GATEWAY_PROXY_READY_POLL_MS = 250;
const PREVIEW_START_RECONCILIATION_GRACE_MS =
    PREVIEW_GATEWAY_PROXY_READY_TIMEOUT_MS + 30_000;
const PREVIEW_STOP_RECONCILIATION_GRACE_MS = 60_000;

interface SystemdUnitState {
    activeState?: string;
    result?: string;
    subState?: string;
}

export async function startPreviewUnit(
    config: PullRequestPreviewConfig,
    sandboxCommand: string[],
    signal?: AbortSignal
): Promise<void> {
    await runCommand(
        "systemd-run",
        [
            "--user",
            `--unit=${config.unitName}`,
            "--collect",
            "--quiet",
            "--property=CPUWeight=30",
            "--property=IOWeight=30",
            "--property=MemoryHigh=2G",
            "--property=MemoryMax=3G",
            "--property=TasksMax=256",
            "--property=KillMode=control-group",
            // This host uses setuid bubblewrap because unprivileged user
            // namespaces are disabled. bwrap drops all child capabilities.
            "--property=RuntimeMaxSec=4h",
            "--property=TimeoutStopSec=20s",
            "--",
            ...sandboxCommand,
        ],
        { env: process.env, signal, timeoutMs: 30_000 }
    );
}

export async function startPreviewGatewayProxyUnit(
    config: PullRequestPreviewConfig,
    signal?: AbortSignal
): Promise<void> {
    if (!isRealRegularFile(config.gatewayProxyEntrypoint)) {
        throw new Error(
            `Trusted PR dev Gateway proxy entrypoint is unavailable: ${config.gatewayProxyEntrypoint}`
        );
    }
    ensureRealDirectory(path.dirname(config.gatewayProxyIdentityFile));
    ensurePrivateSingleLinkFile(
        config.gatewayProxyIdentityFile,
        "PR dev Gateway proxy identity"
    );
    await runCommand(
        "systemd-run",
        [
            "--user",
            `--unit=${config.gatewayProxyUnitName}`,
            "--collect",
            "--quiet",
            "--property=CPUWeight=20",
            "--property=IOWeight=20",
            "--property=MemoryHigh=256M",
            "--property=MemoryMax=512M",
            "--property=TasksMax=64",
            "--property=KillMode=control-group",
            "--property=NoNewPrivileges=yes",
            "--property=RuntimeMaxSec=4h",
            "--property=TimeoutStopSec=10s",
            `--setenv=MIRA_DASHBOARD_PREVIEW_GATEWAY_CLIENT_TOKEN_FILE=${config.gatewayTokenFile}`,
            `--setenv=MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_IDENTITY_FILE=${config.gatewayProxyIdentityFile}`,
            `--setenv=MIRA_DASHBOARD_PREVIEW_GATEWAY_PROXY_PORT=${config.gatewayProxyPort}`,
            `--setenv=MIRA_DASHBOARD_PREVIEW_GATEWAY_UPSTREAM_TOKEN_FILE=${config.gatewayUpstreamTokenFile}`,
            `--setenv=MIRA_DASHBOARD_PREVIEW_GATEWAY_UPSTREAM_URL=${config.gatewayUrl}`,
            "--setenv=NODE_ENV=production",
            "--",
            config.bunExecutable,
            config.gatewayProxyEntrypoint,
        ],
        { env: process.env, signal, timeoutMs: 30_000 }
    );
}

export function parsePreviewUnitState(output: string): SystemdUnitState {
    const properties = parseSystemdProperties(output);
    return {
        activeState: properties.get("ActiveState") || undefined,
        result: properties.get("Result") || undefined,
        subState: properties.get("SubState") || undefined,
    };
}

async function systemdUnitState(unitName: string): Promise<SystemdUnitState | undefined> {
    const result = await runProcess(
        "systemctl",
        [
            "--user",
            "show",
            unitName,
            "--property=ActiveState",
            "--property=SubState",
            "--property=Result",
            "--no-pager",
        ],
        { env: process.env, maxBuffer: 64 * 1024, timeoutMs: 10_000 }
    );
    return result.code === 0 ? parsePreviewUnitState(result.stdout) : undefined;
}

export async function previewUnitState(
    config: PullRequestPreviewConfig
): Promise<SystemdUnitState | undefined> {
    return systemdUnitState(config.unitName);
}

function lifecycleFromUnit(
    state: SystemdUnitState | undefined,
    fallback: PullRequestPreviewLifecycle
): PullRequestPreviewLifecycle {
    if (fallback === "failed") return "failed";
    switch (state?.activeState) {
        case "active": {
            return fallback === "starting" ? "starting" : "running";
        }
        case "activating": {
            return "starting";
        }
        case "deactivating": {
            return "stopping";
        }
        case "failed": {
            return "failed";
        }
        case "inactive": {
            return state.result && state.result !== "success" ? "failed" : "stopped";
        }
        default: {
            return fallback === "running" || fallback === "starting"
                ? "failed"
                : fallback;
        }
    }
}

export function publicPreviewStatus(
    record: PullRequestPreviewRecord,
    unitState?: SystemdUnitState
): PullRequestPreviewStatus {
    const status = lifecycleFromUnit(unitState, record.status);
    const unitMessage =
        status === "failed" && unitState?.result && unitState.result !== "success"
            ? `Preview service result: ${unitState.result}`
            : undefined;
    return {
        backendPort: record.backendPort,
        commitSha: record.commitSha,
        frontendPort: record.frontendPort,
        message: unitMessage || record.message,
        number: record.number,
        startedAt: record.startedAt,
        status,
        title: record.title,
        updatedAt: record.updatedAt,
        url: record.url,
    };
}

export async function readPullRequestPreviewStatus(
    config = resolvePullRequestPreviewConfig()
): Promise<PullRequestPreviewStatus> {
    const record = readPreviewRecord(config);
    if (!record) return { status: "stopped" };
    const unitState = await previewUnitState(config);
    const isManagedLifecycle =
        record.status === "running" || record.status === "starting";
    const proxyUnitState = isManagedLifecycle
        ? await systemdUnitState(config.gatewayProxyUnitName)
        : undefined;
    const isUnitTerminal =
        !unitState || ["failed", "inactive"].includes(unitState.activeState || "");
    const isProxyUnitTerminal =
        !proxyUnitState ||
        ["failed", "inactive"].includes(proxyUnitState.activeState || "");
    const recordUpdatedAt = Date.parse(record.updatedAt);
    const currentTimestamp = Date.now();
    const recordAgeMs =
        Number.isFinite(recordUpdatedAt) && recordUpdatedAt <= currentTimestamp
            ? currentTimestamp - recordUpdatedAt
            : Infinity;
    const isRecentStartup =
        record.status === "starting" &&
        recordAgeMs < PREVIEW_START_RECONCILIATION_GRACE_MS;
    const isStaleStopping =
        record.status === "stopping" &&
        recordAgeMs >= PREVIEW_STOP_RECONCILIATION_GRACE_MS;
    if (
        isStaleStopping ||
        (isManagedLifecycle &&
            !isRecentStartup &&
            (isUnitTerminal || isProxyUnitTerminal))
    ) {
        const cleanup = await cleanupPreviewResources(config, record.ownsTailscaleServe);
        const reconciledUnitState =
            !unitState || isStaleStopping
                ? { activeState: "inactive", result: "success", subState: "dead" }
                : unitState;
        let reconciledMessage = isStaleStopping ? undefined : record.message;
        if (cleanup.errors.length > 0) {
            reconciledMessage = `Preview stopped outside the managed workflow. Cleanup: ${cleanup.errors.join(". ")}`;
        }
        let status = isStaleStopping
            ? "stopped"
            : lifecycleFromUnit(reconciledUnitState, record.status);
        if (cleanup.errors.length > 0) status = "failed";
        const reconciledRecord: PullRequestPreviewRecord = {
            ...record,
            message: reconciledMessage,
            ownsTailscaleServe: cleanup.ownsTailscaleServe,
            status,
            updatedAt: new Date().toISOString(),
        };
        writePreviewRecord(config, reconciledRecord);
        return publicPreviewStatus(
            reconciledRecord,
            cleanup.errors.length > 0 ? undefined : reconciledUnitState
        );
    }
    return publicPreviewStatus(record, unitState);
}

async function stopSystemdUnit(unitName: string): Promise<void> {
    const state = await systemdUnitState(unitName);
    if (!state || ["inactive", "failed"].includes(state.activeState || "")) return;
    await runCommand("systemctl", ["--user", "stop", unitName], {
        env: process.env,
        timeoutMs: 30_000,
    });
}

async function stopPreviewUnit(config: PullRequestPreviewConfig): Promise<void> {
    await stopSystemdUnit(config.unitName);
}

async function stopPreviewGatewayProxyUnit(
    config: PullRequestPreviewConfig
): Promise<void> {
    await stopSystemdUnit(config.gatewayProxyUnitName);
}

export async function cleanupPreviewResources(
    config: PullRequestPreviewConfig,
    isTailscaleServeOwned: boolean
): Promise<{ errors: string[]; ownsTailscaleServe: boolean }> {
    const errors: string[] = [];
    for (const [cleanup, fallback] of [
        [() => stopPreviewUnit(config), "preview service stop failed"],
        [() => stopPreviewGatewayProxyUnit(config), "Gateway proxy stop failed"],
    ] as const) {
        try {
            await cleanup();
        } catch (error) {
            errors.push(errorMessage(error, fallback));
        }
    }
    try {
        removeMaterializedGatewayCredentials(config);
    } catch (error) {
        errors.push(errorMessage(error, "Gateway credential cleanup failed"));
    }
    let isTailscaleServeStillOwned = isTailscaleServeOwned;
    try {
        await disableOwnedTailscaleServe(config, isTailscaleServeOwned);
        isTailscaleServeStillOwned = false;
    } catch (error) {
        errors.push(errorMessage(error, "Serve cleanup failed"));
    }
    return { errors, ownsTailscaleServe: isTailscaleServeStillOwned };
}

export async function waitForPreviewGatewayProxyReady(
    config: PullRequestPreviewConfig,
    signal?: AbortSignal
): Promise<void> {
    const deadline = Date.now() + PREVIEW_GATEWAY_PROXY_READY_TIMEOUT_MS;
    const healthUrl = `http://127.0.0.1:${config.gatewayProxyPort}/health`;
    while (Date.now() < deadline) {
        if (signal?.aborted) {
            throw new DOMException("Preview Gateway proxy startup aborted", "AbortError");
        }
        const state = await systemdUnitState(config.gatewayProxyUnitName);
        if (!state || ["failed", "inactive"].includes(state.activeState || "")) {
            throw new Error(
                `Preview Gateway proxy stopped during startup (${state?.result || state?.activeState || "unit missing"})`
            );
        }
        try {
            const response = await fetch(healthUrl, {
                signal: AbortSignal.timeout(2000),
            });
            if (response.ok && state.activeState === "active") return;
        } catch {
            // The proxy is still connecting to the production Gateway.
        }
        await Bun.sleep(PREVIEW_GATEWAY_PROXY_READY_POLL_MS);
    }
    throw Object.assign(new Error("Timed out waiting for the PR dev Gateway proxy"), {
        statusCode: 504,
    });
}

export async function waitForPreviewReady(
    config: PullRequestPreviewConfig,
    signal?: AbortSignal
): Promise<void> {
    const deadline = Date.now() + PREVIEW_READY_TIMEOUT_MS;
    const healthUrl = `http://127.0.0.1:${config.frontendPort}/api/health/ready`;
    while (Date.now() < deadline) {
        if (signal?.aborted) {
            throw new DOMException("Preview startup aborted", "AbortError");
        }
        const state = await previewUnitState(config);
        if (state && ["failed", "inactive"].includes(state.activeState || "")) {
            throw new Error(
                `Preview service stopped during startup (${state.result || state.activeState})`
            );
        }
        try {
            const response = await fetch(healthUrl, {
                signal: AbortSignal.timeout(2000),
            });
            if (response.ok && state?.activeState === "active") return;
        } catch {
            // The managed frontend/backend pair is still starting.
        }
        await Bun.sleep(PREVIEW_READY_POLL_MS);
    }
    throw Object.assign(new Error("Timed out waiting for PR preview readiness"), {
        statusCode: 504,
    });
}
