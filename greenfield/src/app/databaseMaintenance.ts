import path from "node:path";

import { Effect } from "effect";
import * as v from "valibot";

import {
    createDatabaseCandidateMigrationOwner,
    type DatabaseRuntimeOwner,
} from "../server/database/runtime/databaseCandidateMigrationOwner.ts";
import type { DatabaseCandidateMigrationLayerOptions } from "../server/database/runtime/databaseService.ts";
import {
    createVerifiedDatabaseSnapshot,
    type DatabaseSnapshotOptions,
    type DatabaseSnapshotResult,
} from "../server/database/runtime/databaseSnapshot.ts";
import { fullCommitShaSchema, lowercaseUuidV7Schema } from "../shared/validation.ts";

const databaseMaintenanceFailureMessage = "Dashboard database maintenance failed";
const databaseMaintenanceUsage =
    "Usage: bun database-maintenance.js --operation=migrate-candidate|snapshot with the exact operation arguments";
const absolutePathSchema = v.pipe(
    v.string(),
    v.maxLength(4096),
    v.check(
        (value) =>
            path.isAbsolute(value) &&
            path.resolve(value) === value &&
            !value.includes("\0"),
        databaseMaintenanceUsage
    )
);
const candidateMigrationArgumentsSchema = v.strictObject({
    operation: v.literal("migrate-candidate"),
    migrationsDirectory: absolutePathSchema,
    releaseId: fullCommitShaSchema(databaseMaintenanceUsage),
    stateDirectory: absolutePathSchema,
});
const snapshotArgumentsSchema = v.variant("expectedState", [
    v.strictObject({
        expectedState: v.literal("absent"),
        operation: v.literal("snapshot"),
        stateDirectory: absolutePathSchema,
        transitionId: lowercaseUuidV7Schema(databaseMaintenanceUsage),
    }),
    v.strictObject({
        expectedState: v.literal("present"),
        migrationsDirectory: absolutePathSchema,
        operation: v.literal("snapshot"),
        releaseId: fullCommitShaSchema(databaseMaintenanceUsage),
        stateDirectory: absolutePathSchema,
        transitionId: lowercaseUuidV7Schema(databaseMaintenanceUsage),
    }),
]);

/** Validated command for candidate migration or live-state snapshot creation. */
export type DashboardDatabaseMaintenanceCommand =
    | Readonly<v.InferOutput<typeof candidateMigrationArgumentsSchema>>
    | Readonly<v.InferOutput<typeof snapshotArgumentsSchema>>;

/** Injectable retained-runtime boundary used by deterministic lifecycle tests. */
export interface DashboardDatabaseMaintenanceDependencies {
    readonly createRuntime: (
        options: DatabaseCandidateMigrationLayerOptions
    ) => DatabaseRuntimeOwner;
    readonly createSnapshot: (
        options: DatabaseSnapshotOptions
    ) => Promise<DatabaseSnapshotResult>;
}

const defaultDependencies = Object.freeze({
    createRuntime: createDatabaseCandidateMigrationOwner,
    createSnapshot: (options: DatabaseSnapshotOptions) =>
        Effect.runPromise(createVerifiedDatabaseSnapshot(options)),
} satisfies DashboardDatabaseMaintenanceDependencies);

function databaseMaintenanceFailure(error?: unknown): Error {
    return error instanceof Error
        ? error
        : new Error(databaseMaintenanceFailureMessage, { cause: error });
}

function readArgument(arguments_: readonly string[], name: string): string | undefined {
    const prefix = `--${name}=`;
    const matches = arguments_.filter((argument) => argument.startsWith(prefix));
    if (matches.length !== 1) return undefined;
    return matches[0]?.slice(prefix.length);
}

/**
 * Parses the exact maintenance command arguments without reading ambient configuration.
 * @param arguments_ Bun arguments after the executable entrypoint.
 * @returns Frozen database runtime options.
 */
export function parseDatabaseMaintenanceArguments(
    arguments_: readonly string[]
): DashboardDatabaseMaintenanceCommand {
    const operation = readArgument(arguments_, "operation");
    const expectedState = readArgument(arguments_, "expected-state");
    let candidate: unknown;
    if (operation === "migrate-candidate" && arguments_.length === 4) {
        candidate = {
            migrationsDirectory: readArgument(arguments_, "migrations"),
            operation,
            releaseId: readArgument(arguments_, "release"),
            stateDirectory: readArgument(arguments_, "state"),
        };
    } else if (
        operation === "snapshot" &&
        expectedState === "absent" &&
        arguments_.length === 4
    ) {
        candidate = {
            expectedState,
            operation,
            stateDirectory: readArgument(arguments_, "state"),
            transitionId: readArgument(arguments_, "transition"),
        };
    } else if (
        operation === "snapshot" &&
        expectedState === "present" &&
        arguments_.length === 6
    ) {
        candidate = {
            expectedState,
            migrationsDirectory: readArgument(arguments_, "migrations"),
            operation,
            releaseId: readArgument(arguments_, "release"),
            stateDirectory: readArgument(arguments_, "state"),
            transitionId: readArgument(arguments_, "transition"),
        };
    } else {
        throw new TypeError(databaseMaintenanceUsage);
    }
    const schema =
        operation === "migrate-candidate"
            ? candidateMigrationArgumentsSchema
            : snapshotArgumentsSchema;
    const parsed = v.safeParse(schema, candidate, {
        abortEarly: true,
    });
    if (!parsed.success) throw new TypeError(databaseMaintenanceUsage);
    return Object.freeze(parsed.output);
}

/**
 * Opens, migrates or validates, checkpoints, and closes one isolated database scope.
 * @param command Exact candidate-migration or snapshot command.
 * @param dependencies Injectable runtime owner boundary.
 * @returns Snapshot result for snapshot commands; otherwise completion after migration.
 */
export async function runDashboardDatabaseMaintenance(
    command: DashboardDatabaseMaintenanceCommand,
    dependencies: DashboardDatabaseMaintenanceDependencies = defaultDependencies
): Promise<DatabaseSnapshotResult | undefined> {
    if (command.operation === "snapshot") {
        const { operation: _operation, ...options } = command;
        return dependencies.createSnapshot(options);
    }
    const { operation: _operation, ...options } = command;
    const runtime = dependencies.createRuntime(options);
    let failure: Error | undefined;
    try {
        await runtime.initialize();
    } catch (error) {
        failure = databaseMaintenanceFailure(error);
    }
    try {
        await runtime.dispose();
    } catch (error) {
        failure ??= databaseMaintenanceFailure(error);
    }
    if (failure) throw failure;
    return undefined;
}

if (import.meta.main) {
    try {
        const options = parseDatabaseMaintenanceArguments(Bun.argv.slice(2));
        const result = await runDashboardDatabaseMaintenance(options);
        process.stdout.write(
            `${JSON.stringify(
                result === undefined
                    ? { status: "MAINTAINED" }
                    : { ...result, status: "SNAPSHOT" }
            )}\n`
        );
    } catch (error) {
        const message =
            error instanceof TypeError
                ? error.message
                : databaseMaintenanceFailureMessage;
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}
