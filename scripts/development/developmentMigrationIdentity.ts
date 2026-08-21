import { readdir } from "node:fs/promises";
import path from "node:path";

import { readBoundedRegularFile } from "../files/boundedFile.ts";

const migrationIdentityPollIntervalMs = 250;
const migrationManifestMaximumBytes = 256 * 1024;
const migrationArtifactMaximumBytes = 4 * 1024 * 1024;
const migrationArtifactNames = Object.freeze(["migration.sql", "snapshot.json"]);
const migrationIdentityFailureMessage = "Development migration identity is invalid";

/** One source identity observation for the outer development coordinator. */
export interface DevelopmentMigrationIdentityObservation {
    readonly changed: Promise<string>;
    readonly ready: Promise<string | undefined>;
    close(): void;
}

export interface DevelopmentMigrationIdentityPollTimer {
    cancel(): void;
}

export interface DevelopmentMigrationIdentityPollScheduler {
    schedule(
        callback: () => Promise<void>,
        intervalMs: number
    ): DevelopmentMigrationIdentityPollTimer;
}

export type ObserveDevelopmentMigrationIdentity = (
    repositoryRoot: string,
    initialFingerprint: string
) => DevelopmentMigrationIdentityObservation;

const defaultPollScheduler: DevelopmentMigrationIdentityPollScheduler = Object.freeze({
    schedule(callback: () => Promise<void>, intervalMs: number) {
        const interval = setInterval(() => void callback(), intervalMs);
        interval.unref();
        return Object.freeze({ cancel: () => clearInterval(interval) });
    },
});

function migrationIdentityFailure(): Error {
    return new Error(migrationIdentityFailureMessage);
}

/**
 * Identifies the redacted, retryable failure emitted for an incomplete source graph.
 * @param error Unknown failure raised while refreshing development state.
 * @returns Whether the failure represents an incomplete migration identity.
 */
export function isDevelopmentMigrationIdentityFailure(error: unknown): boolean {
    return error instanceof Error && error.message === migrationIdentityFailureMessage;
}

function validFingerprint(fingerprint: string): boolean {
    return /^[a-f\d]{64}$/u.test(fingerprint);
}

interface ParsedMigrationIdentity {
    readonly id: string;
    readonly migrationSha256: string;
    readonly snapshotSha256: string;
}

const migrationIdPattern = /^\d{14}_[a-z\d][a-z\d_-]*$/u;
const migrationManifestPrefix =
    "export const migrationManifest = Object.freeze<readonly MigrationManifestEntry[]>([";
const migrationManifestSuffix = "]);";
const migrationManifestEntryPattern =
    /Object\.freeze\(\{\s*id:\s*"([^"]+)",\s*migrationSha256:\s*"([a-f\d]{64})",\s*snapshotSha256:\s*"([a-f\d]{64})",?\s*\}\),?/gu;

function parseMigrationManifestSource(bytes: Buffer): readonly ParsedMigrationIdentity[] {
    let source: string;
    try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw migrationIdentityFailure();
    }
    const prefixOffset = source.indexOf(migrationManifestPrefix);
    const suffixOffset = source.indexOf(
        migrationManifestSuffix,
        prefixOffset + migrationManifestPrefix.length
    );
    if (
        prefixOffset === -1 ||
        suffixOffset === -1 ||
        source.includes(migrationManifestPrefix, prefixOffset + 1)
    ) {
        throw migrationIdentityFailure();
    }
    const body = source.slice(
        prefixOffset + migrationManifestPrefix.length,
        suffixOffset
    );
    const entries: ParsedMigrationIdentity[] = [];
    let covered = "";
    let previousEnd = 0;
    for (const match of body.matchAll(migrationManifestEntryPattern)) {
        const [matched, id, migrationSha256, snapshotSha256] = match;
        const matchIndex = match.index;
        if (
            matchIndex === undefined ||
            id === undefined ||
            migrationSha256 === undefined ||
            snapshotSha256 === undefined ||
            !migrationIdPattern.test(id)
        ) {
            throw migrationIdentityFailure();
        }
        covered += body.slice(previousEnd, matchIndex);
        previousEnd = matchIndex + matched.length;
        entries.push(Object.freeze({ id, migrationSha256, snapshotSha256 }));
    }
    covered += body.slice(previousEnd);
    const ids = entries.map(({ id }) => id);
    const sortedIds = ids.toSorted();
    if (
        entries.length === 0 ||
        entries.length > 64 ||
        /[^\s,]/u.test(covered) ||
        new Set(ids).size !== ids.length ||
        ids.some((id, index) => id !== sortedIds[index])
    ) {
        throw migrationIdentityFailure();
    }
    return Object.freeze(entries);
}

function sha256(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function compareCanonicalText(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

async function stableFile(
    repositoryRoot: string,
    relativePath: string,
    maximumBytes: number
): Promise<Buffer> {
    return readBoundedRegularFile(
        path.join(repositoryRoot, relativePath),
        repositoryRoot,
        maximumBytes,
        migrationIdentityFailureMessage
    );
}

/**
 * Derives a stable content identity over parsed reviewed manifest entries and the
 * exact migration artifact tree. This stays fresh even though the coordinator itself is
 * not Bun-watched and therefore cannot rely on a re-evaluated module import.
 * @param repositoryRoot Canonical development source root.
 * @returns Lowercase SHA-256 over ordered relative paths and bytes.
 */
export async function readDevelopmentMigrationIdentity(
    repositoryRoot: string
): Promise<string> {
    if (
        !path.isAbsolute(repositoryRoot) ||
        path.resolve(repositoryRoot) !== repositoryRoot ||
        repositoryRoot.includes("\0")
    ) {
        throw migrationIdentityFailure();
    }
    try {
        const migrationRoot = path.join(repositoryRoot, "migrations");
        const manifestRelativePath = "src/shared/databaseMigrationManifest.ts";
        const manifestBytes = await stableFile(
            repositoryRoot,
            manifestRelativePath,
            migrationManifestMaximumBytes
        );
        const manifest = parseMigrationManifestSource(manifestBytes);
        const entries = await readdir(migrationRoot, { withFileTypes: true });
        const migrationIds = entries.map(({ name }) => name).toSorted();
        if (
            entries.some(
                (entry) =>
                    !entry.isDirectory() ||
                    entry.isSymbolicLink() ||
                    !migrationIdPattern.test(entry.name)
            ) ||
            migrationIds.length !== manifest.length ||
            migrationIds.some((id, index) => id !== manifest[index]?.id)
        ) {
            throw migrationIdentityFailure();
        }
        await Promise.all(
            migrationIds.map(async (migrationId) => {
                const artifactDirectory = path.join(migrationRoot, migrationId);
                const artifactEntries = await readdir(artifactDirectory, {
                    withFileTypes: true,
                });
                const artifacts = artifactEntries.toSorted((left, right) =>
                    compareCanonicalText(left.name, right.name)
                );
                if (
                    artifacts.length !== migrationArtifactNames.length ||
                    artifacts.some(
                        (artifact, index) =>
                            !artifact.isFile() ||
                            artifact.isSymbolicLink() ||
                            artifact.name !== migrationArtifactNames[index]
                    )
                ) {
                    throw migrationIdentityFailure();
                }
            })
        );
        const relativePaths = migrationIds.flatMap((migrationId) =>
            migrationArtifactNames.map(
                (artifactName) => `migrations/${migrationId}/${artifactName}`
            )
        );
        const files = await Promise.all(
            relativePaths.map((relativePath) =>
                stableFile(repositoryRoot, relativePath, migrationArtifactMaximumBytes)
            )
        );
        for (const [index, migration] of manifest.entries()) {
            const migrationSql = files[index * 2];
            const snapshot = files[1 + index * 2];
            if (
                migrationSql === undefined ||
                snapshot === undefined ||
                sha256(migrationSql) !== migration.migrationSha256 ||
                sha256(snapshot) !== migration.snapshotSha256
            ) {
                throw migrationIdentityFailure();
            }
        }
        const fingerprint = new Bun.CryptoHasher("sha256");
        fingerprint.update("mira-dashboard-development-migration-graph:v2\0");
        for (const migration of manifest) {
            fingerprint.update(migration.id);
            fingerprint.update("\0");
            fingerprint.update(migration.migrationSha256);
            fingerprint.update("\0");
            fingerprint.update(migration.snapshotSha256);
            fingerprint.update("\0");
        }
        for (const [index, relativePath] of relativePaths.entries()) {
            const bytes = files[index];
            if (bytes === undefined) throw migrationIdentityFailure();
            fingerprint.update(relativePath);
            fingerprint.update("\0");
            fingerprint.update(bytes);
            fingerprint.update("\0");
        }
        return fingerprint.digest("hex");
    } catch {
        throw migrationIdentityFailure();
    }
}

/**
 * Watches migration identity outside Bun's watched children. A content change resolves
 * once, allowing the coordinator to stop every child before reconciling SQLite. A bounded
 * exact-graph poll avoids broad repository watchers and closes atomic-editor replacement gaps.
 * @param repositoryRoot Canonical development source root.
 * @param initialFingerprint Stable identity returned by state preparation.
 * @param scheduler Cancellable exact-cadence poll scheduler.
 * @returns Closeable one-shot observation resolving with the new stable identity.
 */
export function observeDevelopmentMigrationIdentity(
    repositoryRoot: string,
    initialFingerprint: string,
    scheduler: DevelopmentMigrationIdentityPollScheduler = defaultPollScheduler
): DevelopmentMigrationIdentityObservation {
    if (!validFingerprint(initialFingerprint)) throw migrationIdentityFailure();
    let closed = false;
    let reading = false;
    let resolveChanged!: (fingerprint: string) => void;
    let resolveReady!: (fingerprint: string | undefined) => void;
    let readySettled = false;
    const changed = new Promise<string>((resolve) => {
        resolveChanged = resolve;
    });
    const ready = new Promise<string | undefined>((resolve) => {
        resolveReady = resolve;
    });
    const inspect = async () => {
        if (closed || reading) return;
        reading = true;
        try {
            const nextFingerprint =
                await readDevelopmentMigrationIdentity(repositoryRoot);
            if (nextFingerprint !== initialFingerprint) {
                closed = true;
                poll?.cancel();
                if (!readySettled) {
                    readySettled = true;
                    resolveReady(nextFingerprint);
                }
                resolveChanged(nextFingerprint);
            } else if (!readySettled) {
                readySettled = true;
                resolveReady(undefined);
            }
        } catch {
            // Editors may replace several graph files in steps; later polls revalidate them.
        } finally {
            reading = false;
        }
    };

    const poll = scheduler.schedule(inspect, migrationIdentityPollIntervalMs);
    void inspect();

    return Object.freeze({
        changed,
        ready,
        close() {
            if (closed) return;
            closed = true;
            poll?.cancel();
        },
    });
}
