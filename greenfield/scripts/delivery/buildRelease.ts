import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import {
    type ReleaseManifest,
    releaseBuildCommands,
} from "../../src/shared/releaseManifest.ts";
import {
    type BuildSourceIdentity,
    resolveBuildSourceIdentity,
} from "../buildSourceIdentity.ts";
import {
    type ReleaseRuntimeIdentity,
    verifyReleaseIdentity,
    writeReleaseIdentity,
} from "./releaseIdentity.ts";
import {
    createReleaseStagingPaths,
    discardReleaseTree,
    makeReleaseTreeImmutable,
    promoteStagedRelease,
    stageReleaseArtifacts,
} from "./releaseStaging.ts";

const releaseBuildDeadlineMs = 3 * 60 * 1000;
const releaseBuildFailureMessage = "Dashboard release build failed";

/** One exact package command represented in the release manifest. */
export type ReleaseBuildCommand = (typeof releaseBuildCommands)[number];

/** Injectable command/source boundaries used by focused build orchestration tests. */
export interface DashboardReleaseBuildDependencies {
    readonly resolveSourceIdentity?: (repositoryRoot: string) => BuildSourceIdentity;
    readonly runCommand?: (
        command: ReleaseBuildCommand,
        repositoryRoot: string
    ) => Promise<void>;
    readonly runtimeIdentity?: ReleaseRuntimeIdentity;
}

/** Complete immutable local build ready for later production publication. */
export interface DashboardReleaseBuild {
    readonly manifest: ReleaseManifest;
    readonly releaseRoot: string;
}

type CleanBuildSourceIdentity = Readonly<{
    commitSha: string;
    state: "clean";
}>;

function releaseBuildFailure(): Error {
    return new Error(releaseBuildFailureMessage);
}

function commandArguments(command: ReleaseBuildCommand): readonly string[] {
    switch (command) {
        case "bun run build:browser": {
            return [process.execPath, "run", "build:browser"];
        }
        case "bun run build:processes": {
            return [process.execPath, "run", "build:processes"];
        }
        case "bun run docs:check": {
            return [process.execPath, "run", "docs:check"];
        }
        case "bun run db:check": {
            return [process.execPath, "run", "db:check"];
        }
    }
}

async function runReleaseBuildCommand(
    command: ReleaseBuildCommand,
    repositoryRoot: string
): Promise<void> {
    const child = Bun.spawn([...commandArguments(command)], {
        cwd: repositoryRoot,
        env: { ...process.env, CI: "1", NODE_ENV: "production" },
        signal: AbortSignal.timeout(releaseBuildDeadlineMs),
        stderr: "inherit",
        stdin: "ignore",
        stdout: "inherit",
    });
    if ((await child.exited) !== 0) throw releaseBuildFailure();
}

async function assertRepositoryRoot(repositoryRoot: string): Promise<void> {
    if (
        !path.isAbsolute(repositoryRoot) ||
        repositoryRoot.includes("\0") ||
        path.resolve(repositoryRoot) !== repositoryRoot ||
        typeof process.getuid !== "function"
    ) {
        throw releaseBuildFailure();
    }
    const [canonical, status] = await Promise.all([
        realpath(repositoryRoot),
        lstat(repositoryRoot, { bigint: true }),
    ]);
    if (
        canonical !== repositoryRoot ||
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        status.uid !== BigInt(process.getuid())
    ) {
        throw releaseBuildFailure();
    }
}

function requireCleanSource(
    source: BuildSourceIdentity
): asserts source is CleanBuildSourceIdentity {
    if (source.state !== "clean") throw releaseBuildFailure();
}

function requireSameCleanSource(
    expected: CleanBuildSourceIdentity,
    actual: BuildSourceIdentity
): void {
    requireCleanSource(actual);
    if (actual.commitSha !== expected.commitSha) throw releaseBuildFailure();
}

/**
 * Builds, stages, manifests, freezes, and atomically publishes one local release artifact.
 * This never mutates production state or release pointers.
 * @param repositoryRoot Canonical clean future-root checkout.
 * @param dependencies Focused command/source boundaries, defaulting to real Git and Bun.
 * @returns Commit-addressed immutable release artifact below `dist/releases`.
 */
export async function buildDashboardRelease(
    repositoryRoot: string,
    dependencies: DashboardReleaseBuildDependencies = {}
): Promise<DashboardReleaseBuild> {
    const sourceResolver =
        dependencies.resolveSourceIdentity ?? resolveBuildSourceIdentity;
    const commandRunner = dependencies.runCommand ?? runReleaseBuildCommand;
    let candidateRoot: string | undefined;
    try {
        await assertRepositoryRoot(repositoryRoot);
        const source = sourceResolver(repositoryRoot);
        requireCleanSource(source);
        const paths = await createReleaseStagingPaths(repositoryRoot, source.commitSha);
        candidateRoot = paths.stagingRoot;

        for (const command of releaseBuildCommands) {
            await commandRunner(command, repositoryRoot);
        }
        requireSameCleanSource(source, sourceResolver(repositoryRoot));

        await stageReleaseArtifacts({
            browserRoot: path.join(repositoryRoot, "dist/browser"),
            processRoot: path.join(repositoryRoot, "dist/processes"),
            repositoryRoot,
            stagingRoot: paths.stagingRoot,
        });
        requireSameCleanSource(source, sourceResolver(repositoryRoot));
        const manifest = await writeReleaseIdentity({
            releaseRoot: paths.stagingRoot,
            repositoryRoot,
            runtimeIdentity: dependencies.runtimeIdentity,
            sourceIdentity: source,
        });
        await verifyReleaseIdentity(paths.stagingRoot, manifest.runtime);
        requireSameCleanSource(source, sourceResolver(repositoryRoot));

        await makeReleaseTreeImmutable(repositoryRoot, paths.stagingRoot);
        await promoteStagedRelease(repositoryRoot, paths);
        candidateRoot = paths.finalRoot;
        const verified = await verifyReleaseIdentity(paths.finalRoot, manifest.runtime);
        if (JSON.stringify(verified) !== JSON.stringify(manifest)) {
            throw releaseBuildFailure();
        }
        return Object.freeze({ manifest: verified, releaseRoot: paths.finalRoot });
    } catch {
        if (candidateRoot !== undefined) {
            try {
                await discardReleaseTree(repositoryRoot, candidateRoot);
            } catch {
                // Preserve the fixed release-build failure while leaving evidence for inspection.
            }
        }
        throw releaseBuildFailure();
    }
}

if (import.meta.main) {
    try {
        const repositoryRoot = path.resolve(import.meta.dir, "../..");
        const result = await buildDashboardRelease(repositoryRoot);
        process.stdout.write(
            `${JSON.stringify({
                commitSha: result.manifest.source.commitSha,
                status: "BUILT",
            })}\n`
        );
    } catch (error) {
        const message =
            error instanceof Error ? error.message : releaseBuildFailureMessage;
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}
