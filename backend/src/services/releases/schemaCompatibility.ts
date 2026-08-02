import { Database } from "bun:sqlite";

import {
    assertMiraDatabasePathSafeForEnvironment,
    getMiraDatabasePath,
} from "../../database.ts";
import { readAppliedDatabaseMigrationHistory } from "../../databaseMigrationRunner.ts";
import {
    type DashboardLiveSchemaState,
    type DashboardReleaseManagerOptions,
    type DashboardReleaseRuntimeAvailabilityOptions,
    type ManagedDashboardRelease,
} from "./managerModel.ts";
import {
    DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY,
    type DashboardReleaseManifest,
} from "./manifest.ts";
import { hasManagedBunRuntime, isBunRuntimeVersion } from "./runtime.ts";

function readLiveDatabaseSchemaState(
    maximumCompatibleVersion: number
): DashboardLiveSchemaState {
    const databasePath = getMiraDatabasePath();
    assertMiraDatabasePathSafeForEnvironment(databasePath);
    const database = new Database(databasePath, { readonly: true });
    try {
        database.run("PRAGMA busy_timeout = 5000");
        const migrations = readAppliedDatabaseMigrationHistory(
            database,
            maximumCompatibleVersion
        );
        return {
            migrations,
            version: migrations.length,
        };
    } finally {
        database.close();
    }
}

function assertLiveSchemaState(value: DashboardLiveSchemaState): void {
    if (
        !Number.isSafeInteger(value.version) ||
        value.version < 0 ||
        !Array.isArray(value.migrations) ||
        value.migrations.length !== value.version ||
        value.migrations.some(
            (migration, index) =>
                migration.version !== index + 1 ||
                !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(migration.name) ||
                !/^[\da-f]{64}$/u.test(migration.checksum)
        )
    ) {
        throw new TypeError("Live SQLite schema state is invalid");
    }
}

export async function resolveLiveSchemaState(
    options: DashboardReleaseManagerOptions,
    maximumCompatibleVersion: number
): Promise<DashboardLiveSchemaState> {
    const readLiveSchemaState =
        options.readLiveSchemaState ?? readLiveDatabaseSchemaState;
    const state = await readLiveSchemaState(maximumCompatibleVersion);
    assertLiveSchemaState(state);
    return state;
}

export function assertReleaseMigrationHistoryCompatible(
    release: DashboardReleaseManifest,
    liveState: DashboardLiveSchemaState,
    action: "Activation" | "Rollback"
): void {
    const expectedMigrations = release.schema.migrations;
    for (const actual of liveState.migrations.slice(0, release.schema.target)) {
        const expected = expectedMigrations[actual.version - 1];
        if (
            !expected ||
            actual.name !== expected.name ||
            actual.checksum !== expected.checksum
        ) {
            throw new Error(
                `${action} release SQLite migration ${actual.version} identity does not match live history`
            );
        }
    }
}

export function assertReleaseCanOpenLiveSchema(
    release: DashboardReleaseManifest,
    liveSchemaVersion: number,
    action: "Activation" | "Rollback"
): void {
    if (
        liveSchemaVersion < release.schema.minimumCompatible ||
        liveSchemaVersion > release.schema.maximumCompatible
    ) {
        throw new Error(
            `${action} release cannot open live SQLite schema ${liveSchemaVersion}`
        );
    }
}

export function assertDashboardReleaseRuntimeAvailable(
    release: ManagedDashboardRelease,
    options: DashboardReleaseRuntimeAvailabilityOptions = {}
): void {
    const releaseVersion = release.manifest.bunVersion;
    const hasRuntime = options.hasRuntime ?? hasManagedBunRuntime;
    if (!isBunRuntimeVersion(releaseVersion) || !hasRuntime(releaseVersion)) {
        throw new Error(
            `Release ${release.commitSha} requires unavailable managed Bun runtime ${releaseVersion}`
        );
    }
}

function requiresCurrentSchemaCutover(
    candidate: DashboardReleaseManifest,
    current: DashboardReleaseManifest
): boolean {
    return (
        candidate.schema.target < current.schema.minimumCompatible ||
        candidate.schema.target > current.schema.maximumCompatible
    );
}

function requiresLiveSchemaCutover(
    release: DashboardReleaseManifest,
    liveSchemaVersion: number
): boolean {
    return (
        liveSchemaVersion < release.schema.minimumCompatible &&
        liveSchemaVersion < release.schema.target
    );
}

export function assertReleaseActivationCompatible(
    candidate: DashboardReleaseManifest,
    current: DashboardReleaseManifest,
    schemaCutoverMode?: DashboardReleaseManagerOptions["schemaCutoverMode"]
): void {
    if (candidate.schema.target < current.schema.target) {
        throw new Error(
            "Forward activation cannot lower the managed SQLite schema target"
        );
    }
    const requiresCoordinatedCutover = requiresCurrentSchemaCutover(candidate, current);
    if (requiresCoordinatedCutover && schemaCutoverMode !== "coordinated") {
        throw new Error(
            `Current release cannot roll back after SQLite schema ${candidate.schema.target}`
        );
    }
    if (
        candidate.schema.target === current.schema.target &&
        candidate.schema.migrationRegistrySha256 !==
            current.schema.migrationRegistrySha256
    ) {
        throw new Error(
            "Release migration registry changed without a new SQLite schema version"
        );
    }
}

export function assertReleaseRollbackCompatible(
    active: DashboardReleaseManifest,
    rollback: DashboardReleaseManifest,
    liveSchemaVersion: number
): void {
    if (
        liveSchemaVersion < rollback.schema.minimumCompatible ||
        liveSchemaVersion > rollback.schema.maximumCompatible
    ) {
        throw new Error(
            `Rollback release cannot open SQLite schema ${liveSchemaVersion}`
        );
    }
    if (
        active.schema.target === rollback.schema.target &&
        active.schema.migrationRegistrySha256 !== rollback.schema.migrationRegistrySha256
    ) {
        throw new Error(
            "Rollback release has a different migration registry for the live SQLite schema"
        );
    }
}

/**
 * Verifies that a managed rollback release can open the live schema and agrees
 * with its applied migration history.
 */
export async function assertManagedDashboardReleaseRollbackSchemaCompatible(
    activeRelease: ManagedDashboardRelease,
    rollbackRelease: ManagedDashboardRelease,
    options: DashboardReleaseManagerOptions = {}
): Promise<void> {
    const maximumInspectableSchemaVersion = Math.max(
        DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.maximum,
        activeRelease.manifest.schema.maximumCompatible,
        rollbackRelease.manifest.schema.maximumCompatible
    );
    const liveSchemaState = await resolveLiveSchemaState(
        options,
        maximumInspectableSchemaVersion
    );
    assertReleaseRollbackCompatible(
        activeRelease.manifest,
        rollbackRelease.manifest,
        liveSchemaState.version
    );
    assertReleaseMigrationHistoryCompatible(
        rollbackRelease.manifest,
        liveSchemaState,
        "Rollback"
    );
}

export function assertReleaseCanActivateLiveSchema(
    release: DashboardReleaseManifest,
    liveSchemaVersion: number,
    schemaCutoverMode?: DashboardReleaseManagerOptions["schemaCutoverMode"]
): void {
    if (
        schemaCutoverMode === "coordinated" &&
        requiresLiveSchemaCutover(release, liveSchemaVersion)
    ) {
        return;
    }
    assertReleaseCanOpenLiveSchema(release, liveSchemaVersion, "Activation");
}
