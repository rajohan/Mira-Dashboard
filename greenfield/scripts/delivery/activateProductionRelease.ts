import path from "node:path";

import { Effect } from "effect";
import * as v from "valibot";

import { healthReadinessPath } from "../../src/contracts/system.ts";
import type { ProductionActivationRecord } from "../../src/shared/productionActivationRecord.ts";
import { fullCommitShaSchema } from "../../src/shared/validation.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
import { activatePublishedProductionRelease } from "./productionReleaseActivation.ts";
import { publishProductionRelease } from "./productionReleasePublication.ts";
import { installProductionRuntime } from "./productionRuntime.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";
import { verifyReleaseIdentity } from "./releaseIdentity.ts";
import { createSystemdProductionServiceController } from "./systemdProductionServices.ts";

const activationCliFailureMessage = "Production release activation failed";
const activationCliUsage =
    "Usage: bun run delivery:activate --project-root=/absolute/project --release-root=/absolute/release --readiness-url=http://127.0.0.1:PORT/api/health/ready [--runtime-source=/absolute/bun]";
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
                (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
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
    if (arguments_.length < 3 || arguments_.length > 4) {
        throw new TypeError(activationCliUsage);
    }
    const named = readNamedArguments(arguments_);
    const candidate: unknown = {
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

async function activateProductionRelease(
    options: ActivateProductionReleaseArguments
): Promise<ProductionActivationRecord> {
    const state = await prepareProtectedProductionStatePath(options.projectRoot);
    const sourceManifest = await verifyReleaseIdentity(options.releaseRoot);
    return withDeploymentLease(state.stateDirectory, async (lease) => {
        const paths = await prepareProductionDeliveryDirectories(state);
        const runtime = await installProductionRuntime(
            lease,
            paths,
            sourceManifest.runtime,
            options.runtimeSource === undefined
                ? undefined
                : { sourceExecutable: options.runtimeSource }
        );
        const release = await publishProductionRelease(
            lease,
            paths,
            options.releaseRoot,
            sourceManifest.runtime
        );
        const services = createSystemdProductionServiceController(lease, paths, {
            readinessUrl: options.readinessUrl,
        });
        return Effect.runPromise(
            activatePublishedProductionRelease(lease, paths, release, runtime, {
                services,
            })
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
