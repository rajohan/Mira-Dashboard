import type { DatabaseMigrationIdentity } from "../../databaseMigrations/index.ts";
import type { DashboardReleaseManifest } from "./manifest.ts";

export const MANAGED_RELEASES_DIRECTORY_NAME = "releases";

export const RELEASE_COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;
export const RELEASE_TRANSITION_FORMAT_VERSION = 1;
export const RELEASE_TRANSITION_JOURNAL_FILE_NAME = ".release-transition.json";
export const RELEASE_TRANSITION_LOCK_FILE_NAME = ".release-transition.lock";
export const RETIRED_RELEASE_DIRECTORY_PATTERN =
    /^\.retired-[\da-f]{40}-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
export const STAGING_RELEASE_DIRECTORY_PATTERN =
    /^\.staging-([\da-f]{40})-[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;
export const STALE_STAGING_RELEASE_AGE_MS = 24 * 60 * 60 * 1000;
export const RELEASE_PUBLICATION_LOCK_WAIT_MS = 2 * 60 * 1000;
export const RELEASE_TRANSITION_LOCK_RETRY_MS = 50;
export const MAX_RELEASE_TRANSITION_FILE_BYTES = 4096;
export const RELEASE_TRANSITION_LOCK_PROGRAM = "/usr/bin/flock";

export type ReleaseLinkName = "current" | "previous";

export interface ManagedDashboardRelease {
    commitSha: string;
    directoryIdentity: string;
    manifest: DashboardReleaseManifest;
    manifestIdentity: string;
    path: string;
}

export interface DashboardReleaseLayout {
    releasesPath: string;
    root: string;
}

export interface DashboardReleaseState {
    current?: ManagedDashboardRelease;
    previous?: ManagedDashboardRelease;
    root: string;
}

export interface DashboardReleaseRetentionResult {
    removed: string[];
    removedRuntimes: string[];
    retained: string[];
    retainedRuntimes: string[];
    warnings: string[];
}

export interface DashboardReleaseRuntimeAvailabilityOptions {
    hasRuntime?: (version: string) => boolean;
}

export interface DashboardReleaseTransitionPreparation {
    rollback: () => Promise<void>;
}

export interface DashboardReleaseManagerOptions extends DashboardReleaseRuntimeAvailabilityOptions {
    prepareReleaseTransition?: (
        target: ManagedDashboardRelease
    ) => Promise<DashboardReleaseTransitionPreparation>;
    readLiveSchemaState?: (
        maximumCompatibleVersion: number
    ) => DashboardLiveSchemaState | Promise<DashboardLiveSchemaState>;
    schemaCutoverMode?: "coordinated";
    transitionLockWaitMs?: number;
}

export interface DashboardReleaseRollbackExpectation {
    currentCommitSha: string;
    targetCommitSha: string;
}

export interface DashboardReleaseRollbackOptions extends DashboardReleaseManagerOptions {
    expected?: DashboardReleaseRollbackExpectation;
}

export interface DashboardReleaseFailedActivationRestoreExpectation {
    candidateCommitSha: string;
    previousCommitSha?: string;
    rollbackCommitSha: string;
}

export interface DashboardReleaseFailedActivationRestoreOptions extends DashboardReleaseManagerOptions {
    expected: DashboardReleaseFailedActivationRestoreExpectation;
}

export interface DashboardReleasePublicationOptions {
    onTransitionLockContention?: () => void;
    prepareManifest?: (manifest: DashboardReleaseManifest) => Promise<void>;
}

export interface DashboardLiveSchemaState {
    migrations: DatabaseMigrationIdentity[];
    version: number;
}

export interface ReleaseLinkState {
    current: false | string;
    previous: false | string;
}

export interface ReleaseTransitionJournal {
    after: ReleaseLinkState;
    before: ReleaseLinkState;
    formatVersion: 1;
    operation: "activate" | "restore" | "rollback";
}

export interface ReleaseTransitionJournalSnapshot {
    device: number;
    inode: number;
    journal: ReleaseTransitionJournal;
}

export function compareStrings(left: string, right: string): number {
    return left.localeCompare(right);
}

export function assertReleaseCommitSha(commitSha: string): void {
    if (!RELEASE_COMMIT_SHA_PATTERN.test(commitSha)) {
        throw new TypeError("Managed release commit must be a full lowercase Git SHA");
    }
}
