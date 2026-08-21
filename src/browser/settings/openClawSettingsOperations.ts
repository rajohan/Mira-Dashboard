import type { QueryClient } from "@tanstack/react-query";

import type { AuthStatus } from "../../contracts/auth.ts";
import { openClawConfigurationBackupMaximumBytes } from "../../contracts/openClawSettings.ts";
import type { DashboardProcedureOutput } from "../api/trpcClient.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { authStatusCacheIdentity, authStatusQueryKey } from "../auth/authQueries.ts";
import { AuthenticatedMutationExpiredError } from "../auth/useAuthenticatedMutationBoundary.ts";

export const openClawGatewayRestartRecoveryStoragePrefix =
    "mira-dashboard.openclaw-settings.gateway-restart.v1:";

const openClawConfigurationBackupFileName = "openclaw.json";
const openClawConfigurationBackupMimeType = "application/json";
const openClawConfigurationBackupDisposition = 'attachment; filename="openclaw.json"';
const openClawConfigurationBackupDownloadTimeoutMs = 60_000;
const restartIdempotencyKeyPattern = /^[0-9a-f]{32}$/u;

type ConfigurationBackupDownloadFailure =
    | "expired"
    | "protocol"
    | "unauthorized"
    | "unavailable";

class ConfigurationBackupDownloadError extends Error {
    readonly reason: ConfigurationBackupDownloadFailure;

    constructor(reason: ConfigurationBackupDownloadFailure) {
        super("OpenClaw configuration backup download failed");
        this.name = "ConfigurationBackupDownloadError";
        this.reason = reason;
    }
}

export class GatewayRestartRecoveryError extends Error {
    constructor() {
        super("OpenClaw Gateway restart recovery is unavailable");
        this.name = "GatewayRestartRecoveryError";
    }
}

/**
 * @param error Browser-side ticket or raw download failure.
 * @returns Fixed browser-safe feedback for the failure.
 */
export function openClawConfigurationBackupFailureMessage(error: unknown): string {
    if (!(error instanceof ConfigurationBackupDownloadError)) {
        return dashboardBrowserFailureMessage(error);
    }
    switch (error.reason) {
        case "expired": {
            return "The configuration backup ticket expired or was already used. Request a new backup.";
        }
        case "protocol": {
            return "The configuration backup response was invalid. Request a new backup before trying again.";
        }
        case "unauthorized": {
            return "The configuration backup is no longer authorized for this session. Sign in or verify your identity again, then request a new backup.";
        }
        case "unavailable": {
            return "The configuration backup is temporarily unavailable. Request a new backup and try again shortly.";
        }
    }
}

function configurationBackupFailureForStatus(
    status: number
): ConfigurationBackupDownloadFailure {
    if (status === 401 || status === 403) return "unauthorized";
    if (status === 404 || status === 410) return "expired";
    if (status === 429 || status >= 500) return "unavailable";
    return "protocol";
}

function responseContentLength(response: Response): number | undefined {
    const header = response.headers.get("content-length");
    if (header === null || !/^\d+$/u.test(header)) return undefined;
    const value = Number(header);
    return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Consumes one actor-bound ticket through an observed bounded raw GET and activates
 * only the validated blob. The object URL is revoked on the next task before success.
 */
export async function downloadOpenClawConfigurationBackup(
    result: DashboardProcedureOutput<"openClawSettings.createConfigurationBackup">,
    signal: AbortSignal,
    isActive: () => boolean
): Promise<void> {
    if (result.expiresAtMs <= Date.now()) {
        throw new ConfigurationBackupDownloadError("expired");
    }

    const transferSignal = AbortSignal.any([
        signal,
        AbortSignal.timeout(openClawConfigurationBackupDownloadTimeoutMs),
    ]);
    let response: Response;
    try {
        response = await globalThis.fetch(result.downloadUrl, {
            cache: "no-store",
            credentials: "same-origin",
            method: "GET",
            signal: transferSignal,
        });
    } catch (error) {
        if (signal.aborted) throw error;
        throw new ConfigurationBackupDownloadError("unavailable");
    }
    if (!response.ok || response.status !== 200) {
        throw new ConfigurationBackupDownloadError(
            configurationBackupFailureForStatus(response.status)
        );
    }

    const contentLength = responseContentLength(response);
    const contentType = response.headers.get("content-type")?.split(";", 1)[0];
    if (
        contentLength === undefined ||
        contentLength < 1 ||
        contentLength > openClawConfigurationBackupMaximumBytes ||
        contentType !== openClawConfigurationBackupMimeType ||
        response.headers.get("content-disposition") !==
            openClawConfigurationBackupDisposition
    ) {
        throw new ConfigurationBackupDownloadError("protocol");
    }

    let backup: Blob;
    try {
        backup = await response.blob();
    } catch (error) {
        if (signal.aborted) throw error;
        throw new ConfigurationBackupDownloadError("unavailable");
    }
    if (
        backup.size !== contentLength ||
        backup.size > openClawConfigurationBackupMaximumBytes ||
        backup.type.split(";", 1)[0] !== openClawConfigurationBackupMimeType
    ) {
        throw new ConfigurationBackupDownloadError("protocol");
    }
    if (transferSignal.aborted) {
        if (signal.aborted) {
            throw (
                signal.reason ??
                new DOMException("Configuration backup download aborted", "AbortError")
            );
        }
        throw new ConfigurationBackupDownloadError("unavailable");
    }
    if (!isActive()) throw new AuthenticatedMutationExpiredError();

    const objectUrl = URL.createObjectURL(backup);
    const anchor = document.createElement("a");
    let activated = false;
    try {
        anchor.download = openClawConfigurationBackupFileName;
        anchor.href = objectUrl;
        anchor.hidden = true;
        document.body.append(anchor);
        anchor.click();
        activated = true;
    } finally {
        anchor.remove();
        if (!activated) URL.revokeObjectURL(objectUrl);
    }
    if (activated) {
        await new Promise<void>((resolve, reject) => {
            globalThis.setTimeout(() => {
                try {
                    URL.revokeObjectURL(objectUrl);
                    resolve();
                } catch (error) {
                    reject(
                        error instanceof Error
                            ? error
                            : new Error("Configuration backup cleanup failed")
                    );
                }
            }, 0);
        });
    }
}

/** @returns The exact authenticated user/session cache identity, when available. */
export function authenticatedOpenClawRestartIdentity(
    queryClient: QueryClient
): string | undefined {
    const status = queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
    return status?.state === "authenticated"
        ? authStatusCacheIdentity(status)
        : undefined;
}

function restartRecoveryStorageKey(identity: string): string {
    return `${openClawGatewayRestartRecoveryStoragePrefix}${identity}`;
}

/**
 * @param identity Exact authenticated browser identity, when available.
 * @returns Whether this identity owns a retained restart intent.
 */
export function openClawRestartRecoveryExists(identity: string | undefined): boolean {
    if (identity === undefined) return false;
    try {
        return (
            globalThis.sessionStorage.getItem(restartRecoveryStorageKey(identity)) !==
            null
        );
    } catch {
        return false;
    }
}

/**
 * Returns one existing identity-bound restart key or persists a fresh key before use.
 * Invalid/unavailable storage fails closed so a restart is never sent unrecoverably.
 * @param identity Exact authenticated browser identity.
 * @returns The retained or newly persisted idempotency key.
 */
export function readOrCreateOpenClawRestartIdempotencyKey(identity: string): string {
    const storageKey = restartRecoveryStorageKey(identity);
    let current: string | null;
    try {
        current = globalThis.sessionStorage.getItem(storageKey);
    } catch {
        throw new GatewayRestartRecoveryError();
    }
    if (current !== null) {
        if (restartIdempotencyKeyPattern.test(current)) return current;
        throw new GatewayRestartRecoveryError();
    }

    const created = globalThis.crypto.randomUUID().replaceAll("-", "");
    try {
        globalThis.sessionStorage.setItem(storageKey, created);
        if (globalThis.sessionStorage.getItem(storageKey) !== created) {
            throw new GatewayRestartRecoveryError();
        }
    } catch {
        throw new GatewayRestartRecoveryError();
    }
    return created;
}

/**
 * @param identity Exact authenticated browser identity.
 * @returns Whether the exact identity-bound recovery key was observably removed.
 */
export function clearOpenClawRestartRecovery(identity: string): boolean {
    const storageKey = restartRecoveryStorageKey(identity);
    try {
        globalThis.sessionStorage.removeItem(storageKey);
        return globalThis.sessionStorage.getItem(storageKey) === null;
    } catch {
        return false;
    }
}
