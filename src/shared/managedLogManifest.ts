export type ManagedLogRotationStrategy = "copytruncate" | "rename";

export interface ManagedLogProvisionedDirectory {
    readonly directoryPath: string;
    readonly groupId: number;
    readonly inheritGroupAccess: boolean;
    readonly mode: number;
    readonly ownerId: number;
}

export interface ManagedLogProvisioningAnchor {
    readonly directoryPath: string;
    readonly groupId: number;
    readonly mode: number;
    readonly ownerId: number;
}

export interface ManagedLogFileTarget {
    readonly cadenceMs?: number;
    readonly compress: boolean;
    readonly filePath: string;
    readonly id: string;
    readonly maximumSourceBytes: number;
    readonly maximumSizeBytes: number;
    readonly provisionedDirectories?: readonly ManagedLogProvisionedDirectory[];
    readonly provisioningAnchor?: ManagedLogProvisioningAnchor;
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
const maximumFileTargets = 64;
const rotationEpochProjectionFileName = "rotation-epochs.json";

function trustedSourceOwnerIds(
    runtimeOwnerId: number,
    ...sourceOwnerIds: number[]
): readonly number[] {
    return Object.freeze(
        [...new Set([0, runtimeOwnerId, ...sourceOwnerIds])].toSorted(
            (left, right) => left - right
        )
    );
}

function dirname(value: string): string {
    return value.slice(0, value.lastIndexOf("/")) || "/";
}

function basename(value: string): string {
    return value.slice(value.lastIndexOf("/") + 1);
}

function validateManifestPath(value: string): void {
    if (
        value.includes("\0") ||
        !value.startsWith("/") ||
        value === "/" ||
        value.endsWith("/") ||
        value.split("/").some((segment) => segment === "." || segment === "..") ||
        value.includes("//") ||
        value.length > 4096
    ) {
        throw new TypeError("Managed log manifest is invalid");
    }
}

function validIdentity(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

function validateProvisioningPolicy(target: ManagedLogFileTarget): void {
    const anchor = target.provisioningAnchor;
    const directories = target.provisionedDirectories;
    if (anchor === undefined && directories === undefined) return;
    if (
        anchor === undefined ||
        directories === undefined ||
        directories.length === 0 ||
        directories.length > 16
    ) {
        throw new TypeError("Managed log manifest is invalid");
    }
    validateManifestPath(anchor.directoryPath);
    if (
        !validIdentity(anchor.ownerId) ||
        !validIdentity(anchor.groupId) ||
        !Number.isSafeInteger(anchor.mode) ||
        anchor.mode < 0 ||
        anchor.mode > 0o7777
    ) {
        throw new TypeError("Managed log manifest is invalid");
    }
    for (const [index, directory] of directories.entries()) {
        validateManifestPath(directory.directoryPath);
        const expectedParent =
            index === 0 ? anchor.directoryPath : directories[index - 1]!.directoryPath;
        if (
            dirname(directory.directoryPath) !== expectedParent ||
            !validIdentity(directory.ownerId) ||
            !validIdentity(directory.groupId) ||
            !Number.isSafeInteger(directory.mode) ||
            directory.mode < 0 ||
            directory.mode > 0o7777 ||
            (directory.inheritGroupAccess &&
                directory.groupId !== target.trustedWritableGroupId)
        ) {
            throw new TypeError("Managed log manifest is invalid");
        }
    }
    const leaf = directories.at(-1);
    if (
        leaf === undefined ||
        leaf.directoryPath !== dirname(target.filePath) ||
        (target.trustedWritableGroupId !== undefined &&
            (leaf.groupId !== target.trustedWritableGroupId ||
                leaf.mode !== 0o2770 ||
                !leaf.inheritGroupAccess))
    ) {
        throw new TypeError("Managed log manifest is invalid");
    }
}

function managedFile(
    id: string,
    filePath: string,
    rootAndRuntimeOwnerIds: readonly number[],
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

function managedSharedFile(
    id: string,
    filePath: string,
    trustedOwnerIds: readonly number[],
    provisionedDirectories: readonly ManagedLogProvisionedDirectory[],
    maintenanceGroupId: number | undefined,
    rootAndRuntimeOwnerIds: readonly number[]
): ManagedLogFileTarget {
    return managedFile(id, filePath, rootAndRuntimeOwnerIds, {
        provisionedDirectories,
        provisioningAnchor: Object.freeze({
            directoryPath: "/opt",
            groupId: 0,
            mode: 0o755,
            ownerId: 0,
        }),
        trustedOwnerIds,
        ...(maintenanceGroupId === undefined
            ? {}
            : { trustedWritableGroupId: maintenanceGroupId }),
    });
}

const dashboardLogsRoot = "/home/ubuntu/projects/mira-dashboard/production/state/logs";

function provisionedDirectory(
    directoryPath: string,
    ownerId: number,
    groupId: number,
    mode: number,
    inheritGroupAccess = false
): ManagedLogProvisionedDirectory {
    return Object.freeze({
        directoryPath,
        groupId,
        inheritGroupAccess,
        mode,
        ownerId,
    });
}

/**
 * Creates the fixed manifest from environment-admitted runtime identities.
 * @param runtimeOwnerId - Runtime account allowed to own managed sources.
 * @param maintenanceGroupId - Optional group granted shared rotation access.
 * @returns The validated immutable managed-log manifest.
 */
export function createManagedLogManifest(
    runtimeOwnerId: number,
    maintenanceGroupId?: number
): ManagedLogManifest {
    const rootAndRuntimeOwnerIds = trustedSourceOwnerIds(runtimeOwnerId);
    const dockerRoot = provisionedDirectory("/opt/docker", 1001, 1001, 0o755);
    const dockerData = provisionedDirectory("/opt/docker/data", 1001, 1001, 0o775);
    const prowlarrDirectories = Object.freeze([
        dockerRoot,
        dockerData,
        provisionedDirectory("/opt/docker/data/prowlarr", 1001, 1001, 0o755),
        provisionedDirectory(
            "/opt/docker/data/prowlarr/logs",
            1001,
            maintenanceGroupId ?? 1001,
            maintenanceGroupId === undefined ? 0o755 : 0o2770,
            maintenanceGroupId !== undefined
        ),
    ]);
    const submakerDirectories = Object.freeze([
        dockerRoot,
        dockerData,
        provisionedDirectory("/opt/docker/data/submaker", 1001, 1001, 0o755),
        provisionedDirectory(
            "/opt/docker/data/submaker/logs",
            1000,
            maintenanceGroupId ?? 1000,
            maintenanceGroupId === undefined ? 0o755 : 0o2770,
            maintenanceGroupId !== undefined
        ),
    ]);
    const traefikDirectories = Object.freeze([
        dockerRoot,
        dockerData,
        provisionedDirectory(
            "/opt/docker/data/traefik",
            1001,
            maintenanceGroupId ?? 1001,
            maintenanceGroupId === undefined ? 0o755 : 0o2770,
            maintenanceGroupId !== undefined
        ),
    ]);
    const manifest: ManagedLogManifest = Object.freeze({
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
                `${dashboardLogsRoot}/web-stdout.log`,
                rootAndRuntimeOwnerIds
            ),
            managedFile(
                "dashboard.web.stderr",
                `${dashboardLogsRoot}/web-stderr.log`,
                rootAndRuntimeOwnerIds
            ),
            managedFile(
                "dashboard.worker.stdout",
                `${dashboardLogsRoot}/worker-stdout.log`,
                rootAndRuntimeOwnerIds
            ),
            managedFile(
                "dashboard.worker.stderr",
                `${dashboardLogsRoot}/worker-stderr.log`,
                rootAndRuntimeOwnerIds
            ),
            managedSharedFile(
                "docker.prowlarr.debug",
                "/opt/docker/data/prowlarr/logs/prowlarr.debug.txt",
                trustedSourceOwnerIds(runtimeOwnerId, 1001),
                prowlarrDirectories,
                maintenanceGroupId,
                rootAndRuntimeOwnerIds
            ),
            managedSharedFile(
                "docker.prowlarr.trace",
                "/opt/docker/data/prowlarr/logs/prowlarr.trace.txt",
                trustedSourceOwnerIds(runtimeOwnerId, 1001),
                prowlarrDirectories,
                maintenanceGroupId,
                rootAndRuntimeOwnerIds
            ),
            managedSharedFile(
                "docker.prowlarr",
                "/opt/docker/data/prowlarr/logs/prowlarr.txt",
                trustedSourceOwnerIds(runtimeOwnerId, 1001),
                prowlarrDirectories,
                maintenanceGroupId,
                rootAndRuntimeOwnerIds
            ),
            managedSharedFile(
                "docker.submaker",
                "/opt/docker/data/submaker/logs/app.log",
                trustedSourceOwnerIds(runtimeOwnerId, 1000, 1001),
                submakerDirectories,
                maintenanceGroupId,
                rootAndRuntimeOwnerIds
            ),
            managedSharedFile(
                "docker.traefik",
                "/opt/docker/data/traefik/access.log",
                trustedSourceOwnerIds(runtimeOwnerId, 1001),
                traefikDirectories,
                maintenanceGroupId,
                rootAndRuntimeOwnerIds
            ),
        ]),
        lockPath:
            "/home/ubuntu/projects/mira-dashboard/production/state/log-maintenance/managed.lock",
        statePath:
            "/home/ubuntu/projects/mira-dashboard/production/state/log-maintenance/managed-state.json",
    });
    validateManagedLogManifest(manifest);
    return manifest;
}

/** Validates an injected worker manifest before any descriptor is opened. */
export function validateManagedLogManifest(manifest: ManagedLogManifest): void {
    if (manifest.fileTargets.length > maximumFileTargets) {
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
        if ("filePath" in target) {
            validateProvisioningPolicy(target);
        }
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
        dirname(manifest.lockPath) !== dirname(manifest.statePath) ||
        manifest.lockPath === manifest.statePath ||
        [manifest.lockPath, manifest.statePath].some(
            (filePath) => basename(filePath) === rotationEpochProjectionFileName
        )
    ) {
        throw new TypeError("Managed log manifest is invalid");
    }
}
