import { userInfo } from "node:os";
import path from "node:path";

import * as v from "valibot";

import { fullCommitShaSchema } from "../../src/shared/validation.ts";
import { readBoundedRegularFile } from "../files/boundedFile.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import {
    prepareProductionDeliveryDirectories,
    type PreparedProductionDeliveryPaths,
} from "./productionDeliveryFilesystem.ts";
import {
    loadPublishedProductionRelease,
    type PublishedProductionRelease,
} from "./productionReleasePublication.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";
import {
    installProductionSystemdUnitFiles,
    type ProductionSystemdUnitFile,
    type ProductionSystemdUnitFilesystemTestHooks,
} from "./productionSystemdUnitFilesystem.ts";
import {
    productionProjectHomeRelativePath,
    productionSystemdUnits,
} from "./productionSystemdUnitPolicy.ts";
import {
    executeSystemctlProcess,
    requireSuccessfulSystemctlProcess,
    type SystemctlExecutor,
} from "./systemctlProcess.ts";

const unitInstallFailureMessage = "Production systemd unit installation failed";
const unitInstallUsage =
    "Usage: bun run delivery:install-units --project-root=/absolute/project --release-id=<40-hex> --runtime-revision=<40-hex> --user-unit-directory=/absolute/home/.config/systemd/user";
const maximumUnitBytes = 64 * 1024;
const systemctlExecutableDefault = "/usr/bin/systemctl";
const absolutePathSchema = v.pipe(
    v.string(),
    v.maxLength(4096),
    v.check(
        (input) =>
            path.isAbsolute(input) &&
            path.resolve(input) === input &&
            path.parse(input).root !== input &&
            !input.includes("\0"),
        unitInstallUsage
    )
);
const installArgumentsSchema = v.strictObject({
    projectRoot: absolutePathSchema,
    releaseId: fullCommitShaSchema(unitInstallUsage),
    runtimeRevision: fullCommitShaSchema(unitInstallUsage),
    userUnitDirectory: absolutePathSchema,
});
const installResultSchema = v.strictObject({
    releaseId: fullCommitShaSchema(unitInstallFailureMessage),
    status: v.literal("INSTALLED"),
});

/** Exact explicit systemd-unit installation CLI inputs. */
export type InstallProductionSystemdUnitsArguments = Readonly<
    v.InferOutput<typeof installArgumentsSchema>
>;

/** Redacted machine-readable unit installation result. */
export type InstallProductionSystemdUnitsResult = Readonly<
    v.InferOutput<typeof installResultSchema>
>;

/** Injectable host boundaries used by focused unit-installation tests. */
export interface ProductionSystemdUnitInstallDependencies {
    readonly execute?: SystemctlExecutor;
    readonly filesystemTestHooks?: ProductionSystemdUnitFilesystemTestHooks;
    readonly homeDirectory?: string;
    readonly systemctlExecutable?: string;
    readonly userUnitDirectory?: string;
}

function unitInstallFailure(): Error {
    return new Error(unitInstallFailureMessage);
}

function currentUserHomeDirectory(): string {
    if (typeof process.getuid !== "function") throw unitInstallFailure();
    const identity = userInfo();
    if (
        identity.uid !== process.getuid() ||
        !path.isAbsolute(identity.homedir) ||
        path.resolve(identity.homedir) !== identity.homedir ||
        path.parse(identity.homedir).root === identity.homedir ||
        identity.homedir.includes("\0")
    ) {
        throw unitInstallFailure();
    }
    return identity.homedir;
}

function sha256(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function sameRelease(
    left: PublishedProductionRelease,
    right: PublishedProductionRelease
): boolean {
    return (
        left.releaseRoot === right.releaseRoot &&
        JSON.stringify(left.manifest) === JSON.stringify(right.manifest)
    );
}

function validateProjectBinding(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    homeDirectory: string,
    userUnitDirectory: string
): void {
    const projectRoot = path.join(homeDirectory, productionProjectHomeRelativePath);
    if (
        lease.stateDirectory !== paths.stateDirectory ||
        paths.productionDirectory !== path.join(projectRoot, "production") ||
        paths.releasesDirectory !== path.join(projectRoot, "production/releases") ||
        paths.runtimesDirectory !== path.join(projectRoot, "production/runtimes") ||
        userUnitDirectory !== path.join(homeDirectory, ".config/systemd/user")
    ) {
        throw unitInstallFailure();
    }
}

async function readManifestUnits(
    release: PublishedProductionRelease
): Promise<readonly ProductionSystemdUnitFile[]> {
    const systemdArtifacts = release.manifest.artifacts.filter(({ path: artifactPath }) =>
        artifactPath.startsWith("systemd/")
    );
    if (
        systemdArtifacts.length !== productionSystemdUnits.length ||
        productionSystemdUnits.some(
            ({ artifactPath }, index) => systemdArtifacts[index]?.path !== artifactPath
        )
    ) {
        throw unitInstallFailure();
    }
    const units: ProductionSystemdUnitFile[] = [];
    for (const policy of productionSystemdUnits) {
        const artifact = systemdArtifacts.find(
            ({ path: artifactPath }) => artifactPath === policy.artifactPath
        );
        if (!artifact || artifact.bytes > maximumUnitBytes) {
            throw unitInstallFailure();
        }
        const bytes = await readBoundedRegularFile(
            path.join(release.releaseRoot, artifact.path),
            release.releaseRoot,
            maximumUnitBytes,
            unitInstallFailureMessage
        );
        if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
            throw unitInstallFailure();
        }
        units.push(
            Object.freeze({
                bytes,
                fileName: policy.fileName,
                sha256: artifact.sha256,
            })
        );
    }
    return Object.freeze(units);
}

/**
 * Installs the exact units from one immutable published release and reloads user systemd.
 * It never starts, stops, restarts, enables, or disables a service.
 * @param lease Active deployment lease guarding the complete delivery transition.
 * @param paths Exact protected project-local production paths.
 * @param release Candidate or rollback release whose unit bytes must become active.
 * @param dependencies Explicit host and deterministic test boundaries.
 */
export async function installPublishedProductionSystemdUnits(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    release: PublishedProductionRelease,
    dependencies: ProductionSystemdUnitInstallDependencies = {}
): Promise<void> {
    try {
        const homeDirectory = dependencies.homeDirectory ?? currentUserHomeDirectory();
        const userUnitDirectory =
            dependencies.userUnitDirectory ??
            path.join(homeDirectory, ".config/systemd/user");
        validateProjectBinding(lease, paths, homeDirectory, userUnitDirectory);
        const verified = await loadPublishedProductionRelease(
            paths,
            release.manifest.source.commitSha,
            release.manifest.runtime.revision
        );
        if (!sameRelease(release, verified)) throw unitInstallFailure();
        const units = await readManifestUnits(verified);
        await installProductionSystemdUnitFiles(
            homeDirectory,
            userUnitDirectory,
            units,
            dependencies.filesystemTestHooks
        );
        const after = await loadPublishedProductionRelease(
            paths,
            release.manifest.source.commitSha,
            release.manifest.runtime.revision
        );
        if (!sameRelease(verified, after)) throw unitInstallFailure();
        await requireSuccessfulSystemctlProcess(
            dependencies.execute ?? executeSystemctlProcess,
            dependencies.systemctlExecutable ?? systemctlExecutableDefault,
            ["--user", "daemon-reload"]
        );
    } catch {
        throw unitInstallFailure();
    }
}

function readNamedArguments(arguments_: readonly string[]): Record<string, string> {
    const values = Object.create(null) as Record<string, string>;
    for (const argument of arguments_) {
        const separator = argument.indexOf("=");
        if (separator <= 2 || !argument.startsWith("--")) {
            throw new TypeError(unitInstallUsage);
        }
        const name = argument.slice(2, separator);
        const value = argument.slice(separator + 1);
        if (!value || Object.hasOwn(values, name)) {
            throw new TypeError(unitInstallUsage);
        }
        values[name] = value;
    }
    return values;
}

/**
 * Parses the exact unit-installation command without ambient path defaults.
 * @param arguments_ Arguments after the Bun entrypoint.
 * @returns Frozen project, release, runtime, and user-unit paths.
 */
export function parseInstallProductionSystemdUnitsArguments(
    arguments_: readonly string[]
): InstallProductionSystemdUnitsArguments {
    if (arguments_.length !== 4) throw new TypeError(unitInstallUsage);
    const named = readNamedArguments(arguments_);
    const parsed = v.safeParse(
        installArgumentsSchema,
        {
            projectRoot: named["project-root"],
            releaseId: named["release-id"],
            runtimeRevision: named["runtime-revision"],
            userUnitDirectory: named["user-unit-directory"],
        },
        { abortEarly: true }
    );
    if (!parsed.success) throw new TypeError(unitInstallUsage);
    return Object.freeze(parsed.output);
}

/**
 * Revalidates project state and installs one already-published release's unit files.
 * @param arguments_ Exact explicit unit-installation CLI arguments.
 * @param dependencies Injectable host boundaries used by tests.
 * @returns Redacted installation identity.
 */
export async function runInstallProductionSystemdUnitsCli(
    arguments_: readonly string[],
    dependencies: ProductionSystemdUnitInstallDependencies = {}
): Promise<InstallProductionSystemdUnitsResult> {
    const parsed = parseInstallProductionSystemdUnitsArguments(arguments_);
    const homeDirectory = dependencies.homeDirectory ?? currentUserHomeDirectory();
    if (
        parsed.projectRoot !==
            path.join(homeDirectory, productionProjectHomeRelativePath) ||
        parsed.userUnitDirectory !== path.join(homeDirectory, ".config/systemd/user")
    ) {
        throw unitInstallFailure();
    }
    const state = await prepareProtectedProductionStatePath(parsed.projectRoot);
    await withDeploymentLease(state.stateDirectory, async (lease) => {
        const paths = await prepareProductionDeliveryDirectories(state);
        const release = await loadPublishedProductionRelease(
            paths,
            parsed.releaseId,
            parsed.runtimeRevision
        );
        await installPublishedProductionSystemdUnits(lease, paths, release, {
            ...dependencies,
            homeDirectory,
            userUnitDirectory: parsed.userUnitDirectory,
        });
    });
    return Object.freeze(
        v.parse(installResultSchema, {
            releaseId: parsed.releaseId,
            status: "INSTALLED",
        })
    );
}

if (import.meta.main) {
    try {
        const result = await runInstallProductionSystemdUnitsCli(Bun.argv.slice(2));
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        const message =
            error instanceof TypeError ? error.message : unitInstallFailureMessage;
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}
