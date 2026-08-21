import path from "node:path";

import * as v from "valibot";

import {
    databaseSnapshotManifestSchema,
    parseDatabaseSnapshotManifest,
    type DatabaseSnapshotManifest,
} from "../../src/shared/databaseSnapshotManifest.ts";
import { lowercaseUuidV7Schema } from "../../src/shared/validation.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";
import type { PublishedProductionRelease } from "./productionReleasePublication.ts";
import {
    type InstalledProductionRuntime,
    type ProductionRuntimeVerificationDependencies,
    verifyInstalledProductionRuntime,
} from "./productionRuntime.ts";
import { verifyReleaseIdentity } from "./releaseIdentity.ts";

const databaseMaintenanceProcessFailureMessage = "Database maintenance process failed";
const databaseMaintenanceDeadlineMs = 5 * 60 * 1000;
const maximumProcessOutputBytes = 128 * 1024;
const maintainedOutputSchema = v.strictObject({ status: v.literal("MAINTAINED") });
const absentSnapshotOutputSchema = v.strictObject({
    state: v.literal("absent"),
    status: v.literal("SNAPSHOT"),
    transitionId: lowercaseUuidV7Schema(databaseMaintenanceProcessFailureMessage),
});
const sourceDatabaseIdentitySchema = v.strictObject({
    ctimeNs: v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d{0,39})$/u)),
    device: v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d{0,39})$/u)),
    inode: v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d{0,39})$/u)),
    mtimeNs: v.pipe(v.string(), v.regex(/^(?:0|[1-9]\d{0,39})$/u)),
    size: v.pipe(v.string(), v.regex(/^[1-9]\d{0,39}$/u)),
});
const presentSnapshotOutputSchema = v.strictObject({
    manifest: databaseSnapshotManifestSchema,
    snapshotDirectory: v.string(),
    snapshotFile: v.string(),
    sourceDatabase: sourceDatabaseIdentitySchema,
    state: v.literal("present"),
    status: v.literal("SNAPSHOT"),
});

/** Bounded result from one isolated child process invocation. */
export interface DatabaseMaintenanceProcessOutput {
    readonly exitCode: number;
    readonly stderr: Uint8Array;
    readonly stdout: Uint8Array;
}

/** Injectable execution/runtime boundaries used by focused delivery tests. */
export interface DatabaseMaintenanceProcessDependencies {
    readonly execute?: (
        command: readonly string[],
        releaseRoot: string
    ) => Promise<DatabaseMaintenanceProcessOutput>;
    readonly runtimeVerification?: ProductionRuntimeVerificationDependencies;
}

/** Verified present snapshot returned by the immutable maintenance process. */
export interface PublishedDatabaseSnapshot {
    readonly manifest: DatabaseSnapshotManifest;
    readonly snapshotDirectory: string;
    readonly snapshotFile: string;
    readonly sourceDatabase: Readonly<{
        ctimeNs: string;
        device: string;
        inode: string;
        mtimeNs: string;
        size: string;
    }>;
    readonly state: "present";
}

export type PublishedDatabaseSnapshotResult =
    | Readonly<{ state: "absent"; transitionId: string }>
    | PublishedDatabaseSnapshot;

function processFailure(): Error {
    return new Error(databaseMaintenanceProcessFailureMessage);
}

async function readBoundedStream(
    stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            total += result.value.byteLength;
            if (total > maximumProcessOutputBytes) throw processFailure();
            chunks.push(result.value);
        }
    } finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

async function executeMaintenanceProcess(
    command: readonly string[],
    releaseRoot: string
): Promise<DatabaseMaintenanceProcessOutput> {
    const child = Bun.spawn([...command], {
        cwd: releaseRoot,
        env: { NODE_ENV: "production", PATH: "/usr/bin:/bin" },
        signal: AbortSignal.timeout(databaseMaintenanceDeadlineMs),
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    try {
        const [exitCode, stdout, stderr] = await Promise.all([
            child.exited,
            readBoundedStream(child.stdout),
            readBoundedStream(child.stderr),
        ]);
        return Object.freeze({ exitCode, stderr, stdout });
    } catch {
        child.kill();
        await child.exited.catch(() => null);
        throw processFailure();
    }
}

function decodeOutput(output: Uint8Array): unknown {
    try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(output);
        if (!text.endsWith("\n") || text.trim().split("\n").length !== 1) {
            throw processFailure();
        }
        return JSON.parse(text) as unknown;
    } catch {
        throw processFailure();
    }
}

async function verifyExecutionInputs(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    release: PublishedProductionRelease,
    runtime: InstalledProductionRuntime,
    dependencies: DatabaseMaintenanceProcessDependencies
): Promise<void> {
    try {
        const commitSha = release.manifest.source.commitSha;
        if (
            lease.stateDirectory !== paths.stateDirectory ||
            release.releaseRoot !== path.join(paths.releasesDirectory, commitSha)
        ) {
            throw processFailure();
        }
        const [verifiedManifest] = await Promise.all([
            verifyReleaseIdentity(release.releaseRoot, runtime.identity),
            verifyInstalledProductionRuntime(
                paths,
                runtime,
                dependencies.runtimeVerification
            ),
        ]);
        if (JSON.stringify(verifiedManifest) !== JSON.stringify(release.manifest)) {
            throw processFailure();
        }
    } catch {
        throw processFailure();
    }
}

async function runProcess(
    command: readonly string[],
    releaseRoot: string,
    dependencies: DatabaseMaintenanceProcessDependencies
): Promise<unknown> {
    const output = await (dependencies.execute ?? executeMaintenanceProcess)(
        command,
        releaseRoot
    );
    if (output.exitCode !== 0 || output.stderr.byteLength !== 0) {
        throw processFailure();
    }
    return decodeOutput(output.stdout);
}

function maintenanceCommand(
    release: PublishedProductionRelease,
    runtime: InstalledProductionRuntime,
    arguments_: readonly string[]
): readonly string[] {
    return Object.freeze([
        runtime.executable,
        path.join(release.releaseRoot, "server/databaseMaintenance.js"),
        ...arguments_,
    ]);
}

/**
 * Runs the candidate release's migration process against one isolated transition directory.
 * @param lease Active deployment transition lease.
 * @param paths Exact project-local production paths.
 * @param release Verified immutable candidate release.
 * @param runtime Exact runtime named by the candidate manifest.
 * @param transitionId Canonical transition identifier.
 * @param candidateStateDirectory Exact private candidate state directory.
 * @param dependencies Injectable process/probe boundaries.
 */
export async function runDatabaseCandidateMaintenance(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    release: PublishedProductionRelease,
    runtime: InstalledProductionRuntime,
    transitionId: string,
    candidateStateDirectory: string,
    dependencies: DatabaseMaintenanceProcessDependencies = {}
): Promise<void> {
    await verifyExecutionInputs(lease, paths, release, runtime, dependencies);
    const expectedCandidate = path.join(
        paths.stateDirectory,
        `.database-transition-${transitionId}`,
        "candidate"
    );
    if (
        !v.is(lowercaseUuidV7Schema(), transitionId) ||
        candidateStateDirectory !== expectedCandidate
    ) {
        throw processFailure();
    }
    const result = await runProcess(
        maintenanceCommand(release, runtime, [
            "--operation=migrate-candidate",
            `--migrations=${path.join(release.releaseRoot, "migrations")}`,
            `--release=${release.manifest.source.commitSha}`,
            `--state=${candidateStateDirectory}`,
        ]),
        release.releaseRoot,
        dependencies
    );
    if (!v.is(maintainedOutputSchema, result)) throw processFailure();
}

/**
 * Snapshots the expected live state through the release that currently owns its schema.
 * For first activation, the candidate executable may prove that the live database is absent.
 * @param lease Active deployment transition lease.
 * @param paths Exact project-local production paths.
 * @param release Release whose maintenance executable owns the expected live schema.
 * @param runtime Exact runtime named by that release.
 * @param transitionId Canonical transition identifier.
 * @param expectedState Whether live state must be absent or schema-current for this release.
 * @param dependencies Injectable process/probe boundaries.
 * @returns Verified absent marker or immutable snapshot artifact.
 */
export async function runDatabaseSnapshotMaintenance(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    release: PublishedProductionRelease,
    runtime: InstalledProductionRuntime,
    transitionId: string,
    expectedState: "absent" | "present",
    dependencies: DatabaseMaintenanceProcessDependencies = {}
): Promise<PublishedDatabaseSnapshotResult> {
    await verifyExecutionInputs(lease, paths, release, runtime, dependencies);
    if (!v.is(lowercaseUuidV7Schema(), transitionId)) throw processFailure();
    const stateArguments =
        expectedState === "present"
            ? [
                  `--migrations=${path.join(release.releaseRoot, "migrations")}`,
                  `--release=${release.manifest.source.commitSha}`,
              ]
            : [];
    const value = await runProcess(
        maintenanceCommand(release, runtime, [
            "--operation=snapshot",
            `--expected-state=${expectedState}`,
            ...stateArguments,
            `--state=${paths.stateDirectory}`,
            `--transition=${transitionId}`,
        ]),
        release.releaseRoot,
        dependencies
    );
    if (expectedState === "absent") {
        const parsed = v.safeParse(absentSnapshotOutputSchema, value, {
            abortEarly: true,
        });
        if (!parsed.success || parsed.output.transitionId !== transitionId) {
            throw processFailure();
        }
        return Object.freeze({ state: "absent", transitionId });
    }
    const parsed = v.safeParse(presentSnapshotOutputSchema, value, {
        abortEarly: true,
    });
    if (!parsed.success) throw processFailure();
    const expectedDirectory = path.join(paths.stateDirectory, "backups", transitionId);
    const expectedFile = path.join(expectedDirectory, "mira-dashboard.db");
    const manifest = parseDatabaseSnapshotManifest(parsed.output.manifest);
    if (
        parsed.output.snapshotDirectory !== expectedDirectory ||
        parsed.output.snapshotFile !== expectedFile ||
        manifest.transitionId !== transitionId ||
        manifest.releaseId !== release.manifest.source.commitSha
    ) {
        throw processFailure();
    }
    return Object.freeze({
        manifest,
        snapshotDirectory: expectedDirectory,
        snapshotFile: expectedFile,
        sourceDatabase: Object.freeze(parsed.output.sourceDatabase),
        state: "present" as const,
    });
}
