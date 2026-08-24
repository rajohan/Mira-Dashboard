import path from "node:path";

import { Effect } from "effect";
import * as v from "valibot";

import { healthReadinessPath } from "../../src/contracts/system.ts";
import type { ProductionActivationRecord } from "../../src/shared/productionActivationRecord.ts";
import type { ReleaseManifest } from "../../src/shared/releaseManifest.ts";
import { fullCommitShaSchema } from "../../src/shared/validation.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import { assertProductionArtifactCapacity } from "./productionArtifactCapacity.ts";
import {
    prepareProductionDeliveryDirectories,
    type PreparedProductionDeliveryPaths,
} from "./productionDeliveryFilesystem.ts";
import {
    activatePublishedProductionRelease,
    prepareProductionArtifactAdmission,
    type ProductionReleaseActivationDependencies,
    type ProductionServiceController,
} from "./productionReleaseActivation.ts";
import {
    publishProductionRelease,
    type PublishedProductionRelease,
} from "./productionReleasePublication.ts";
import {
    installProductionRuntime,
    type InstalledProductionRuntime,
} from "./productionRuntime.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";
import { verifyReleaseArtifactIdentity } from "./releaseIdentity.ts";
import { createSystemdProductionServiceController } from "./systemdProductionServices.ts";

const activationCliFailureMessage = "Production release activation failed";
const activationCliUsage =
    "Usage: bun run delivery activate --project-root=/absolute/project --release-root=/absolute/release --readiness-url=http://127.0.0.1:PORT/api/health/ready [--runtime-source=/absolute/bun] [--activation-mode=greenfield]";
const absolutePathSchema = v.pipe(
    v.string(),
    v.maxLength(4096),
    v.check(
        (input) =>
            path.isAbsolute(input) &&
            path.resolve(input) === input &&
            path.parse(input).root !== input &&
            !input.includes("\0"),
        activationCliUsage
    )
);
const readinessUrlSchema = v.pipe(
    v.string(),
    v.url(),
    v.check((input) => {
        try {
            const url = new URL(input);
            return (
                url.protocol === "http:" &&
                url.hostname === "127.0.0.1" &&
                url.pathname === healthReadinessPath &&
                url.username.length === 0 &&
                url.password.length === 0 &&
                url.search.length === 0 &&
                url.hash.length === 0
            );
        } catch {
            return false;
        }
    }, activationCliUsage)
);
const activateProductionReleaseArgumentsSchema = v.strictObject({
    activationMode: v.optional(v.literal("greenfield")),
    projectRoot: absolutePathSchema,
    readinessUrl: readinessUrlSchema,
    releaseRoot: absolutePathSchema,
    runtimeSource: v.optional(absolutePathSchema),
});
const activationCliResultSchema = v.strictObject({
    releaseId: fullCommitShaSchema(activationCliFailureMessage),
    status: v.literal("ACTIVATED"),
    transitionId: v.pipe(v.string(), v.uuid()),
});
const activationArgumentNames = new Set([
    "activation-mode",
    "project-root",
    "readiness-url",
    "release-root",
    "runtime-source",
]);

/** Explicit immutable-release activation command. */
export type ActivateProductionReleaseArguments = Readonly<
    v.InferOutput<typeof activateProductionReleaseArgumentsSchema>
>;

/** Safe machine-readable result from production activation. */
export type ActivateProductionReleaseResult = Readonly<
    v.InferOutput<typeof activationCliResultSchema>
>;

/** Injectable orchestration boundary used by the CLI contract test. */
export interface ActivateProductionReleaseCliDependencies {
    readonly activate?: (
        options: ActivateProductionReleaseArguments
    ) => Promise<ProductionActivationRecord>;
}

/** Install/publication boundaries exposed to focused admission-lifecycle tests. */
export interface ProductionArtifactDeliveryDependencies {
    readonly activateRelease?: typeof activatePublishedProductionRelease;
    readonly artifactAdmission?: typeof prepareProductionArtifactAdmission;
    readonly capacityAdmission?: typeof assertProductionArtifactCapacity;
    readonly installRuntime?: typeof installProductionRuntime;
    readonly publishRelease?: typeof publishProductionRelease;
}

function readNamedArguments(arguments_: readonly string[]): Record<string, string> {
    const values = Object.create(null) as Record<string, string>;
    for (const argument of arguments_) {
        const separator = argument.indexOf("=");
        if (separator <= 2 || !argument.startsWith("--")) {
            throw new TypeError(activationCliUsage);
        }
        const name = argument.slice(2, separator);
        const value = argument.slice(separator + 1);
        if (!value || Object.hasOwn(values, name)) {
            throw new TypeError(activationCliUsage);
        }
        values[name] = value;
    }
    return values;
}

/**
 * Parses the exact production activation CLI surface without ambient defaults.
 * @param arguments_ Arguments after the Bun entrypoint.
 * @returns Frozen project, release, runtime, and readiness inputs.
 */
export function parseActivateProductionReleaseArguments(
    arguments_: readonly string[]
): ActivateProductionReleaseArguments {
    if (arguments_.length < 3 || arguments_.length > 5) {
        throw new TypeError(activationCliUsage);
    }
    const named = readNamedArguments(arguments_);
    if (Object.keys(named).some((name) => !activationArgumentNames.has(name))) {
        throw new TypeError(activationCliUsage);
    }
    const candidate: unknown = {
        activationMode: named["activation-mode"],
        projectRoot: named["project-root"],
        readinessUrl: named["readiness-url"],
        releaseRoot: named["release-root"],
        runtimeSource: named["runtime-source"],
    };
    const parsed = v.safeParse(activateProductionReleaseArgumentsSchema, candidate, {
        abortEarly: true,
    });
    if (!parsed.success) throw new TypeError(activationCliUsage);
    return Object.freeze(parsed.output);
}

/**
 * Runs pre-admission recovery/retention, capacity admission, copy, and activation under one lease.
 * A failed runtime install or publication immediately repeats journal-aware retention so repeated
 * attempts with distinct identities cannot accumulate immutable artifacts.
 * @returns The authoritative activation record after candidate readiness commits.
 */
export async function deliverProductionReleaseUnderLease(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    options: ActivateProductionReleaseArguments,
    sourceManifest: ReleaseManifest,
    services: ProductionServiceController,
    dependencies: ProductionArtifactDeliveryDependencies = {}
): Promise<ProductionActivationRecord> {
    const artifactAdmission =
        dependencies.artifactAdmission ?? prepareProductionArtifactAdmission;
    const activationDependencies: ProductionReleaseActivationDependencies = {
        services,
    };
    const runtimeSource = options.runtimeSource ?? process.execPath;
    await artifactAdmission(lease, paths, activationDependencies);
    await (dependencies.capacityAdmission ?? assertProductionArtifactCapacity)(
        lease,
        paths,
        options.releaseRoot,
        sourceManifest,
        runtimeSource
    );

    let runtime: InstalledProductionRuntime;
    let release: PublishedProductionRelease;
    try {
        runtime = await (dependencies.installRuntime ?? installProductionRuntime)(
            lease,
            paths,
            sourceManifest.runtime,
            { sourceExecutable: runtimeSource }
        );
        release = await (dependencies.publishRelease ?? publishProductionRelease)(
            lease,
            paths,
            options.releaseRoot,
            sourceManifest.runtime
        );
    } catch {
        await artifactAdmission(lease, paths, activationDependencies);
        throw new Error(activationCliFailureMessage);
    }
    return Effect.runPromise(
        (dependencies.activateRelease ?? activatePublishedProductionRelease)(
            lease,
            paths,
            release,
            runtime,
            activationDependencies
        )
    );
}

async function activateProductionRelease(
    options: ActivateProductionReleaseArguments
): Promise<ProductionActivationRecord> {
    const state = await prepareProtectedProductionStatePath(options.projectRoot);
    const sourceManifest = await verifyReleaseArtifactIdentity(options.releaseRoot);
    return withDeploymentLease(state.stateDirectory, async (lease) => {
        const paths = await prepareProductionDeliveryDirectories(state);
        const services = createSystemdProductionServiceController(lease, paths, {
            allowEmptyOperatorSmoke: options.activationMode === "greenfield",
            readinessUrl: options.readinessUrl,
        });
        return deliverProductionReleaseUnderLease(
            lease,
            paths,
            options,
            sourceManifest,
            services
        );
    });
}

/**
 * Prepares state, installs the pinned runtime, publishes, and atomically activates one release.
 * @param arguments_ Arguments after the Bun entrypoint.
 * @param dependencies Injectable complete activation boundary.
 * @returns Redacted machine-readable activation identity.
 */
export async function runActivateProductionReleaseCli(
    arguments_: readonly string[],
    dependencies: ActivateProductionReleaseCliDependencies = {}
): Promise<ActivateProductionReleaseResult> {
    const options = parseActivateProductionReleaseArguments(arguments_);
    const activation = await (dependencies.activate ?? activateProductionRelease)(
        options
    );
    return Object.freeze(
        v.parse(activationCliResultSchema, {
            releaseId: activation.current.releaseId,
            status: "ACTIVATED",
            transitionId: activation.transitionId,
        })
    );
}

if (import.meta.main) {
    try {
        const result = await runActivateProductionReleaseCli(Bun.argv.slice(2));
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        const message =
            error instanceof TypeError ? error.message : activationCliFailureMessage;
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}
