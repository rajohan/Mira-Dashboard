import type { QueryClient } from "@tanstack/react-query";

import type { AuthStatus } from "../../contracts/auth.ts";
import type { KopiaBackupStatus, WalgBackupStatus } from "../../contracts/backups.ts";
import { authStatusCacheIdentity, authStatusQueryKey } from "../auth/authQueries.ts";

export type BackupBrowserOperation = "clear-attention" | "run";
type ProviderStatus = KopiaBackupStatus | WalgBackupStatus;

const recoveryPrefix = "mira-dashboard.backups.request.v1:";
const idempotencyKeyPattern = /^[0-9a-f]{32}$/u;

export class BackupRecoveryError extends Error {
    constructor() {
        super("Backup request recovery is unavailable");
        this.name = "BackupRecoveryError";
    }
}

/** @returns The exact authenticated user/session browser identity, when available. */
export function authenticatedBackupIdentity(
    queryClient: QueryClient
): string | undefined {
    const status = queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
    return status?.state === "authenticated"
        ? authStatusCacheIdentity(status)
        : undefined;
}

/** @returns A request fingerprint bound to exact source and observed activity state. */
export function backupRequestFingerprint(
    status: ProviderStatus,
    operation: BackupBrowserOperation
): string {
    if (status.state !== "fresh") throw new BackupRecoveryError();
    const activity =
        status.activity.state === "idle"
            ? "idle"
            : `${status.activity.state}:${status.activity.jobRunId}`;
    if (operation === "clear-attention" && status.activity.state !== "needs-attention") {
        throw new BackupRecoveryError();
    }
    return `${status.payload.type}:${operation}:${status.payload.sourceRevision}:${activity}`;
}

function storageKey(
    identity: string,
    type: "kopia" | "walg",
    operation: BackupBrowserOperation
): string {
    return `${recoveryPrefix}${identity}:${type}:${operation}`;
}

function parseRecovery(raw: string): {
    readonly fingerprint: string;
    readonly idempotencyKey: string;
} {
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (
            typeof parsed !== "object" ||
            parsed === null ||
            Object.keys(parsed).toSorted().join(",") !== "fingerprint,idempotencyKey" ||
            !("fingerprint" in parsed) ||
            typeof parsed.fingerprint !== "string" ||
            !("idempotencyKey" in parsed) ||
            typeof parsed.idempotencyKey !== "string" ||
            !idempotencyKeyPattern.test(parsed.idempotencyKey)
        ) {
            throw new BackupRecoveryError();
        }
        return {
            fingerprint: parsed.fingerprint,
            idempotencyKey: parsed.idempotencyKey,
        };
    } catch (error) {
        if (error instanceof BackupRecoveryError) throw error;
        throw new BackupRecoveryError();
    }
}

/**
 * Returns an exact request-bound recovery identity or persists a fresh one.
 * @param input Identity, provider, operation, and exact request fingerprint.
 * @returns A verified browser-retained idempotency key.
 */
export function readOrCreateBackupIdempotencyKey(input: {
    readonly fingerprint: string;
    readonly identity: string;
    readonly operation: BackupBrowserOperation;
    readonly type: "kopia" | "walg";
}): string {
    const key = storageKey(input.identity, input.type, input.operation);
    let current: string | null;
    try {
        current = globalThis.sessionStorage.getItem(key);
    } catch {
        throw new BackupRecoveryError();
    }
    if (current !== null) {
        const recovered = parseRecovery(current);
        if (recovered.fingerprint === input.fingerprint) {
            return recovered.idempotencyKey;
        }
    }
    const created = globalThis.crypto.randomUUID().replaceAll("-", "");
    const serialized = JSON.stringify({
        fingerprint: input.fingerprint,
        idempotencyKey: created,
    });
    try {
        globalThis.sessionStorage.setItem(key, serialized);
        if (globalThis.sessionStorage.getItem(key) !== serialized) {
            throw new BackupRecoveryError();
        }
    } catch {
        throw new BackupRecoveryError();
    }
    return created;
}

/**
 * @param input Identity and exact provider operation whose recovery is cleared.
 * @returns Whether the exact confirmed request recovery record was removed.
 */
export function clearBackupRecovery(input: {
    readonly identity: string;
    readonly operation: BackupBrowserOperation;
    readonly type: "kopia" | "walg";
}): boolean {
    const key = storageKey(input.identity, input.type, input.operation);
    try {
        globalThis.sessionStorage.removeItem(key);
        return globalThis.sessionStorage.getItem(key) === null;
    } catch {
        return false;
    }
}
