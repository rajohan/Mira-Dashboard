import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Data, Effect, Schedule, Scope } from "effect";

import {
    buildResourceBudgetLauncherCommand,
    type ResourceBudgetLauncherCommand,
} from "./resourceBudgetCommand.ts";
import {
    assessResourceBudgetEvidence,
    createResourceBudgetUnitName,
    expectedResourceBudgetCgroupPath,
    parseResourceBudgetUnitReport,
    resourceBudgetPolicy,
    resourceBudgetScenarioIds,
    type ResourceBudgetAssessment,
    type ResourceBudgetScenarioEvidence,
    type ResourceBudgetScenarioId,
} from "./resourceBudgetPolicy.ts";

type ManagedProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;
const unitCollectionSchedule = Schedule.spaced("20 millis").pipe(
    Schedule.upTo({ times: 100 })
);

export class ResourceBudgetOrchestrationError extends Data.TaggedError(
    "ResourceBudgetOrchestrationError"
)<{
    readonly cause?: unknown;
    readonly operation: string;
    readonly scenarioId?: ResourceBudgetScenarioId;
}> {}

export class ResourceBudgetOrchestrationDeadlineError extends Data.TaggedError(
    "ResourceBudgetOrchestrationDeadlineError"
)<{
    readonly operation: string;
    readonly scenarioId: ResourceBudgetScenarioId;
}> {}

class ResourceBudgetUnitPendingError extends Data.TaggedError(
    "ResourceBudgetUnitPendingError"
)<{
    readonly operation: string;
}> {}

interface ProcessResult {
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
}

export type ResourceBudgetUnitCollectionInspection =
    | Readonly<{ readonly state: "collected" }>
    | Readonly<{ readonly state: "pending" }>
    | Readonly<{
          readonly error: ResourceBudgetOrchestrationError;
          readonly state: "failed";
      }>;

interface ResourceBudgetExecutables {
    readonly bun: string;
    readonly env: string;
    readonly systemctl: string;
    readonly systemdRun: string;
}

export interface ResourceBudgetEvidenceReport {
    readonly assessments: readonly Readonly<ResourceBudgetAssessment>[];
    readonly bunRevision: string;
    readonly bunVersion: string;
    readonly ciInvariants: readonly string[];
    readonly hostMeasurementsAreTimingGates: false;
    readonly scenarioEvidence: readonly ResourceBudgetScenarioEvidence[];
}

function requiredExecutable(
    name: string
): Effect.Effect<string, ResourceBudgetOrchestrationError> {
    return Effect.try({
        catch: (cause) =>
            new ResourceBudgetOrchestrationError({
                cause,
                operation: `resolve-${name}-executable`,
            }),
        try: () => Bun.which(name),
    }).pipe(
        Effect.flatMap((executable) =>
            executable !== null && path.isAbsolute(executable)
                ? Effect.succeed(executable)
                : Effect.fail(
                      new ResourceBudgetOrchestrationError({
                          operation: `resolve-${name}-executable`,
                      })
                  )
        )
    );
}

function temporaryWorkspace() {
    return Effect.acquireRelease(
        Effect.tryPromise({
            catch: (cause) =>
                new ResourceBudgetOrchestrationError({
                    cause,
                    operation: "create-temporary-workspace",
                }),
            try: () => mkdtemp(path.join(tmpdir(), "mira-resource-budget-")),
        }),
        (directory) =>
            Effect.tryPromise(() => rm(directory, { force: true, recursive: true })).pipe(
                Effect.orDie
            )
    );
}

function awaitProcessExit(process_: ManagedProcess, operation: string) {
    return Effect.tryPromise({
        catch: (cause) => new ResourceBudgetOrchestrationError({ cause, operation }),
        try: () => process_.exited,
    });
}

function stopProcess(process_: ManagedProcess): Effect.Effect<void> {
    if (process_.exitCode !== null || process_.signalCode !== null) return Effect.void;
    return Effect.sync(() => process_.kill("SIGTERM")).pipe(
        Effect.andThen(awaitProcessExit(process_, "stop-subprocess")),
        Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () =>
                Effect.sync(() => process_.kill("SIGKILL")).pipe(
                    Effect.andThen(awaitProcessExit(process_, "kill-subprocess"))
                ),
        }),
        Effect.asVoid,
        Effect.orDie
    );
}

function processResource(
    argv: readonly string[],
    environment: Readonly<Record<string, string>>,
    maximumOutputBytes: number,
    operation: string
): Effect.Effect<ManagedProcess, ResourceBudgetOrchestrationError, Scope.Scope> {
    return Effect.gen(function* () {
        const signal = yield* Effect.abortSignal;
        return yield* Effect.acquireRelease(
            Effect.try({
                catch: (cause) =>
                    new ResourceBudgetOrchestrationError({ cause, operation }),
                try: () =>
                    Bun.spawn([...argv], {
                        env: environment,
                        killSignal: "SIGTERM",
                        maxBuffer: maximumOutputBytes,
                        signal,
                        stderr: "pipe",
                        stdin: "ignore",
                        stdout: "pipe",
                    }),
            }),
            stopProcess
        );
    });
}

function captureOutput(stream: ReadableStream<Uint8Array>, operation: string) {
    return Effect.tryPromise({
        catch: (cause) => new ResourceBudgetOrchestrationError({ cause, operation }),
        try: () => new Response(stream).text(),
    });
}

function runBoundedProcess(
    argv: readonly string[],
    environment: Readonly<Record<string, string>>,
    maximumOutputBytes: number,
    deadlineMs: number,
    operation: string,
    scenarioId: ResourceBudgetScenarioId
): Effect.Effect<
    ProcessResult,
    ResourceBudgetOrchestrationError | ResourceBudgetOrchestrationDeadlineError
> {
    return Effect.scoped(
        Effect.gen(function* () {
            const process_ = yield* processResource(
                argv,
                environment,
                maximumOutputBytes,
                operation
            );
            const [exitCode, stderr, stdout] = yield* Effect.all(
                [
                    awaitProcessExit(process_, operation),
                    captureOutput(process_.stderr, `${operation}:stderr`),
                    captureOutput(process_.stdout, `${operation}:stdout`),
                ] as const,
                { concurrency: "unbounded" }
            ).pipe(
                Effect.timeoutOrElse({
                    duration: deadlineMs,
                    orElse: () =>
                        Effect.fail(
                            new ResourceBudgetOrchestrationDeadlineError({
                                operation,
                                scenarioId,
                            })
                        ),
                })
            );
            return { exitCode, stderr, stdout };
        })
    );
}

function systemctl(
    command: ResourceBudgetLauncherCommand,
    arguments_: readonly string[],
    operation: string
) {
    return runBoundedProcess(
        [
            command.systemctlExecutable,
            "--user",
            "--no-ask-password",
            "--no-pager",
            ...arguments_,
        ],
        command.environment,
        16 * 1024,
        3000,
        operation,
        command.scenarioId
    );
}

/**
 * Classifies one bounded `systemctl show` result without hiding transport failures.
 * @param result Captured systemctl process result.
 * @returns Explicit collected, pending, or failed inspection state.
 */
export function classifyResourceBudgetUnitCollection(
    result: Readonly<ProcessResult>
): ResourceBudgetUnitCollectionInspection {
    if (result.exitCode !== 0) {
        return {
            error: new ResourceBudgetOrchestrationError({
                cause: {
                    exitCode: result.exitCode,
                    stderr: result.stderr.trim(),
                },
                operation: "inspect-unit-collection",
            }),
            state: "failed",
        };
    }
    return result.stdout.trim() === "LoadState=not-found"
        ? { state: "collected" }
        : { state: "pending" };
}

function unitIsCollected(command: ResourceBudgetLauncherCommand) {
    return systemctl(
        command,
        ["show", `${command.unitName}.service`, "--property=LoadState"],
        "inspect-unit-collection"
    ).pipe(
        Effect.flatMap(
            (
                result
            ): Effect.Effect<
                boolean,
                ResourceBudgetOrchestrationError | ResourceBudgetUnitPendingError
            > => {
                const inspection = classifyResourceBudgetUnitCollection(result);
                switch (inspection.state) {
                    case "collected": {
                        return Effect.succeed(true);
                    }
                    case "failed": {
                        return Effect.fail(inspection.error);
                    }
                    case "pending": {
                        return Effect.fail(
                            new ResourceBudgetUnitPendingError({
                                operation: "await-unit-collection",
                            })
                        );
                    }
                }
            }
        ),
        Effect.retry({ schedule: unitCollectionSchedule }),
        Effect.catchTag("ResourceBudgetUnitPendingError", () => Effect.succeed(false))
    );
}

function cgroupIsRemoved(cgroupPath: string) {
    const filesystemPath = path.join("/sys/fs/cgroup", `.${cgroupPath}`);
    const attempt = Effect.tryPromise({
        catch: (cause) =>
            new ResourceBudgetOrchestrationError({
                cause,
                operation: "inspect-cgroup-removal",
            }),
        try: async () => {
            try {
                await stat(filesystemPath);
                return false;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
                throw error;
            }
        },
    }).pipe(
        Effect.flatMap((removed) =>
            removed
                ? Effect.succeed(true)
                : Effect.fail(
                      new ResourceBudgetUnitPendingError({
                          operation: "await-cgroup-removal",
                      })
                  )
        )
    );
    return attempt.pipe(
        Effect.retry({ schedule: unitCollectionSchedule }),
        Effect.catchTag("ResourceBudgetUnitPendingError", () => Effect.succeed(false))
    );
}

function cleanupTransientUnit(command: ResourceBudgetLauncherCommand) {
    const unit = `${command.unitName}.service`;
    return Effect.gen(function* () {
        const stopped = yield* systemctl(command, ["stop", unit], "stop-unit");
        if (stopped.exitCode !== 0) {
            yield* systemctl(
                command,
                ["kill", "--kill-whom=all", "--signal=SIGKILL", unit],
                "kill-unit"
            );
            yield* systemctl(command, ["stop", unit], "stop-killed-unit");
        }
        yield* systemctl(command, ["reset-failed", unit], "reset-failed-unit");
        const collected = yield* unitIsCollected(command);
        if (!collected) {
            return yield* Effect.fail(
                new ResourceBudgetOrchestrationError({
                    operation: "collect-transient-unit",
                    scenarioId: command.scenarioId,
                })
            );
        }
    }).pipe(Effect.orDie);
}

function transientUnitResource(command: ResourceBudgetLauncherCommand) {
    return Effect.acquireRelease(Effect.succeed(command), cleanupTransientUnit);
}

function readResult(command: ResourceBudgetLauncherCommand) {
    return Effect.tryPromise({
        catch: (cause) =>
            new ResourceBudgetOrchestrationError({
                cause,
                operation: "read-unit-report",
                scenarioId: command.scenarioId,
            }),
        try: async () => {
            const resultFile = Bun.file(command.resultPath);
            if (!(await resultFile.exists())) {
                throw new Error("Resource-budget unit did not write a report");
            }
            if (resultFile.size > resourceBudgetPolicy.resultMaxBytes) {
                throw new Error("Resource-budget unit report exceeds its bound");
            }
            return parseResourceBudgetUnitReport(await resultFile.text());
        },
    });
}

function runScenario(
    scenarioId: ResourceBudgetScenarioId,
    workspace: string,
    executables: ResourceBudgetExecutables,
    userId: number
) {
    const unitName = createResourceBudgetUnitName(scenarioId);
    const scenarioDirectory = path.join(workspace, scenarioId);
    const temporaryDirectory = path.join(scenarioDirectory, "tmp");
    const resultPath = path.join(scenarioDirectory, "result.json");
    const command = buildResourceBudgetLauncherCommand({
        bunExecutable: executables.bun,
        childEntrypoint: path.join(import.meta.dir, "resourceBudgetUnit.ts"),
        envExecutable: executables.env,
        environment: process.env,
        repositoryRoot: path.resolve(import.meta.dir, "../../../.."),
        resultPath,
        scenarioId,
        systemctlExecutable: executables.systemctl,
        systemdRunExecutable: executables.systemdRun,
        temporaryDirectory,
        unitName,
    });
    const cgroupPath = expectedResourceBudgetCgroupPath(userId, unitName);

    return Effect.gen(function* () {
        yield* Effect.tryPromise({
            catch: (cause) =>
                new ResourceBudgetOrchestrationError({
                    cause,
                    operation: "create-scenario-directory",
                    scenarioId,
                }),
            try: () => mkdir(temporaryDirectory, { recursive: true }),
        });
        const completed = yield* Effect.scoped(
            Effect.gen(function* () {
                yield* transientUnitResource(command);
                const limits = resourceBudgetPolicy.scenarios[scenarioId].limits;
                const launcher = yield* runBoundedProcess(
                    command.argv,
                    command.environment,
                    resourceBudgetPolicy.launcherOutputMaxBytes,
                    limits.outerDeadlineMs,
                    "run-transient-unit",
                    scenarioId
                );
                if (launcher.exitCode !== 0) {
                    const diagnostic = [launcher.stderr.trim(), launcher.stdout.trim()]
                        .filter((value) => value.length > 0)
                        .join("\n")
                        .slice(0, 16 * 1024);
                    return yield* Effect.fail(
                        new ResourceBudgetOrchestrationError({
                            cause: diagnostic,
                            operation: "transient-unit-exit",
                            scenarioId,
                        })
                    );
                }
                const report = yield* readResult(command);
                return { launcher, report };
            })
        );
        const [unitCollected, cgroupRemoved] = yield* Effect.all(
            [unitIsCollected(command), cgroupIsRemoved(cgroupPath)] as const,
            { concurrency: "unbounded" }
        );
        return {
            cgroupRemoved,
            launcherExitCode: completed.launcher.exitCode,
            report: completed.report,
            unitCollected,
        } satisfies ResourceBudgetScenarioEvidence;
    });
}

/** Executes all representative workloads sequentially under reviewed cgroup limits. */
export const resourceBudgetEvidence: Effect.Effect<
    ResourceBudgetEvidenceReport,
    ResourceBudgetOrchestrationError | ResourceBudgetOrchestrationDeadlineError
> = Effect.scoped(
    Effect.gen(function* () {
        if (process.getuid === undefined) {
            return yield* Effect.fail(
                new ResourceBudgetOrchestrationError({
                    operation: "read-current-user-id",
                })
            );
        }
        const workspace = yield* temporaryWorkspace();
        const [env, systemctl, systemdRun] = yield* Effect.all(
            [
                requiredExecutable("env"),
                requiredExecutable("systemctl"),
                requiredExecutable("systemd-run"),
            ] as const,
            { concurrency: "unbounded" }
        );
        const executables: ResourceBudgetExecutables = {
            bun: process.execPath,
            env,
            systemctl,
            systemdRun,
        };
        const userId = process.getuid();
        const scenarioEvidence = yield* Effect.forEach(
            resourceBudgetScenarioIds,
            (scenarioId) => runScenario(scenarioId, workspace, executables, userId),
            { concurrency: 1 }
        );
        const assessments = scenarioEvidence.map((evidence) =>
            assessResourceBudgetEvidence(evidence, userId)
        );
        return Object.freeze({
            assessments: Object.freeze(assessments),
            bunRevision: Bun.revision,
            bunVersion: Bun.version,
            ciInvariants: Object.freeze([
                "exact transient-unit controller limits",
                "zero OOM/high/max events",
                "zero workload exit status and no signal",
                "memory peak below memory.high",
                "no child process or transient-unit leakage",
                "bounded output and Effect-owned deadlines",
            ]),
            hostMeasurementsAreTimingGates: false as const,
            scenarioEvidence: Object.freeze(scenarioEvidence),
        });
    })
);
