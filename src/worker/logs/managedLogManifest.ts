import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import path from "node:path";

import {
    logRotationEpochProjectionFileName,
    logRotationEpochProjectionMaximumEntries,
} from "../../shared/logRotationEpochProjection.ts";

export type ManagedLogRotationStrategy = "copytruncate" | "rename";

export interface ManagedLogFileTarget {
    readonly cadenceMs?: number;
    readonly compress: boolean;
    readonly filePath: string;
    readonly id: string;
    readonly maximumSourceBytes: number;
    readonly maximumSizeBytes: number;
    readonly retentionAgeMs: number;
    readonly retentionCount: number;
    readonly strategy: ManagedLogRotationStrategy;
    readonly trustedOwnerIds: readonly number[];
    readonly trustedWritableGroupId?: number;
}

export interface ManagedArchiveTarget {
    readonly compressAfterMs: number;
    readonly directoryPath: string;
    readonly id: string;
    readonly kind: "openclaw-daily";
    readonly maximumEntries: number;
    readonly maximumSourceBytes: number;
    readonly retentionAgeMs: number;
    readonly retentionCount: number;
    readonly trustedOwnerIds: readonly number[];
}

export interface ManagedLogManifest {
    readonly archiveTargets: readonly ManagedArchiveTarget[];
    readonly fileTargets: readonly ManagedLogFileTarget[];
    readonly lockPath: string;
    readonly statePath: string;
}

const mebibyte = 1024 * 1024;
const dayMs = 24 * 60 * 60 * 1000;
const runtimeOwnerId = typeof process.getuid === "function" ? process.getuid() : 0;
const rootAndRuntimeOwnerIds = Object.freeze(
    runtimeOwnerId === 0 ? [0] : [0, runtimeOwnerId]
);
const maintenanceGroupName = "mira-dashboard-log-maintenance";

function resolveMaintenanceGroupId(): number | undefined {
    let descriptor: number | undefined;
    try {
        descriptor = openSync(
            "/etc/group",
            constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        );
        const status = fstatSync(descriptor);
        if (
            !status.isFile() ||
            status.nlink !== 1 ||
            status.uid !== 0 ||
            (status.mode & 0o022) !== 0 ||
            status.size === 0 ||
            status.size > 1024 * 1024
        ) {
            return undefined;
        }
        const matches = readFileSync(descriptor, "utf8")
            .split("\n")
            .filter((line) => line.startsWith(`${maintenanceGroupName}:`));
        if (matches.length !== 1) return undefined;
        const fields = matches[0]?.split(":");
        const groupId = fields?.[2];
        if (fields?.length !== 4 || !/^(?:0|[1-9]\d{0,9})$/u.test(groupId ?? "")) {
            return undefined;
        }
        const parsed = Number(groupId);
        return Number.isSafeInteger(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
    }
}

const maintenanceGroupId = resolveMaintenanceGroupId();

function trustedContainerOwnerIds(...containerOwnerIds: number[]): readonly number[] {
    return Object.freeze(
        [...new Set([...rootAndRuntimeOwnerIds, ...containerOwnerIds])].toSorted(
            (left, right) => left - right
        )
    );
}

function validateManifestPath(value: string): void {
    if (
        value.includes("\0") ||
        !path.isAbsolute(value) ||
        path.normalize(value) !== value ||
        value === path.parse(value).root ||
        value.length > 4096
    ) {
        throw new TypeError("Managed log manifest is invalid");
    }
}

function managedFile(
    id: string,
    filePath: string,
    options: Partial<
        Omit<ManagedLogFileTarget, "filePath" | "id" | "trustedOwnerIds">
    > & { readonly trustedOwnerIds?: readonly number[] } = {}
): ManagedLogFileTarget {
    return Object.freeze({
        cadenceMs: dayMs,
        compress: true,
        filePath,
        id,
        maximumSizeBytes: 10 * mebibyte,
        maximumSourceBytes: 64 * mebibyte,
        retentionAgeMs: 14 * dayMs,
        retentionCount: 7,
        strategy: "copytruncate",
        trustedOwnerIds: rootAndRuntimeOwnerIds,
        ...options,
    });
}

function managedContainerFile(
    id: string,
    filePath: string,
    trustedOwnerIds: readonly number[]
): ManagedLogFileTarget {
    return managedFile(id, filePath, {
        trustedOwnerIds,
        ...(maintenanceGroupId === undefined
            ? {}
            : { trustedWritableGroupId: maintenanceGroupId }),
    });
}

const dashboardLogsRoot = "/home/ubuntu/projects/mira-dashboard/production/state/logs";

/**
 * Worker-owned fixed manifest. Browser input can select only `docker-managed`; it can
 * never contribute a path, glob, owner id, size, strategy, or retention value.
 */
export const managedLogManifest: ManagedLogManifest = Object.freeze({
    archiveTargets: Object.freeze([
        Object.freeze({
            compressAfterMs: dayMs,
            directoryPath: "/tmp/openclaw",
            id: "openclaw.daily",
            kind: "openclaw-daily" as const,
            maximumEntries: 128,
            maximumSourceBytes: 64 * mebibyte,
            retentionAgeMs: 30 * dayMs,
            retentionCount: 30,
            trustedOwnerIds: rootAndRuntimeOwnerIds,
        }),
    ]),
    fileTargets: Object.freeze([
        managedFile(
            "dashboard.web.stdout",
            path.join(dashboardLogsRoot, "web-stdout.log")
        ),
        managedFile(
            "dashboard.web.stderr",
            path.join(dashboardLogsRoot, "web-stderr.log")
        ),
        managedFile(
            "dashboard.worker.stdout",
            path.join(dashboardLogsRoot, "worker-stdout.log")
        ),
        managedFile(
            "dashboard.worker.stderr",
            path.join(dashboardLogsRoot, "worker-stderr.log")
        ),
        managedContainerFile(
            "docker.prowlarr.debug",
            "/opt/docker/data/prowlarr/logs/prowlarr.debug.txt",
            trustedContainerOwnerIds(1001)
        ),
        managedContainerFile(
            "docker.prowlarr.trace",
            "/opt/docker/data/prowlarr/logs/prowlarr.trace.txt",
            trustedContainerOwnerIds(1001)
        ),
        managedContainerFile(
            "docker.prowlarr",
            "/opt/docker/data/prowlarr/logs/prowlarr.txt",
            trustedContainerOwnerIds(1001)
        ),
        managedContainerFile(
            "docker.submaker",
            "/opt/docker/data/submaker/logs/app.log",
            trustedContainerOwnerIds(1000, 1001)
        ),
        managedContainerFile(
            "docker.traefik",
            "/opt/docker/data/traefik/access.log",
            trustedContainerOwnerIds(1001)
        ),
    ]),
    lockPath:
        "/home/ubuntu/projects/mira-dashboard/production/state/log-maintenance/managed.lock",
    statePath:
        "/home/ubuntu/projects/mira-dashboard/production/state/log-maintenance/managed-state.json",
});

/** Validates an injected worker manifest before any descriptor is opened. */
export function validateManagedLogManifest(manifest: ManagedLogManifest): void {
    if (manifest.fileTargets.length > logRotationEpochProjectionMaximumEntries) {
        throw new TypeError("Managed log manifest is invalid");
    }
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const target of [...manifest.fileTargets, ...manifest.archiveTargets]) {
        if (!/^[a-z0-9][a-z0-9.-]{0,127}$/u.test(target.id) || ids.has(target.id)) {
            throw new TypeError("Managed log manifest is invalid");
        }
        ids.add(target.id);
        const absolutePath =
            "filePath" in target ? target.filePath : target.directoryPath;
        validateManifestPath(absolutePath);
        if (paths.has(absolutePath))
            throw new TypeError("Managed log manifest is invalid");
        paths.add(absolutePath);
        if (
            target.maximumSourceBytes < 1 ||
            !Number.isSafeInteger(target.maximumSourceBytes) ||
            target.retentionCount < 1 ||
            !Number.isSafeInteger(target.retentionCount) ||
            target.retentionAgeMs < 0 ||
            !Number.isSafeInteger(target.retentionAgeMs) ||
            target.trustedOwnerIds.length === 0 ||
            target.trustedOwnerIds.length > 16 ||
            target.trustedOwnerIds.some(
                (ownerId) => !Number.isSafeInteger(ownerId) || ownerId < 0
            )
        ) {
            throw new TypeError("Managed log manifest is invalid");
        }
        if ("filePath" in target) {
            if (
                (target.trustedWritableGroupId !== undefined &&
                    (!Number.isSafeInteger(target.trustedWritableGroupId) ||
                        target.trustedWritableGroupId < 0)) ||
                target.maximumSizeBytes < 1 ||
                target.maximumSizeBytes > target.maximumSourceBytes ||
                !Number.isSafeInteger(target.maximumSizeBytes) ||
                (target.cadenceMs !== undefined &&
                    (!Number.isSafeInteger(target.cadenceMs) || target.cadenceMs < 1))
            ) {
                throw new TypeError("Managed log manifest is invalid");
            }
        } else if (
            target.maximumEntries < 1 ||
            target.maximumEntries > 4096 ||
            !Number.isSafeInteger(target.maximumEntries) ||
            target.compressAfterMs < 0 ||
            !Number.isSafeInteger(target.compressAfterMs)
        ) {
            throw new TypeError("Managed log manifest is invalid");
        }
    }
    validateManifestPath(manifest.lockPath);
    validateManifestPath(manifest.statePath);
    if (
        path.dirname(manifest.lockPath) !== path.dirname(manifest.statePath) ||
        manifest.lockPath === manifest.statePath ||
        [manifest.lockPath, manifest.statePath].some(
            (filePath) => path.basename(filePath) === logRotationEpochProjectionFileName
        )
    ) {
        throw new TypeError("Managed log manifest is invalid");
    }
}
