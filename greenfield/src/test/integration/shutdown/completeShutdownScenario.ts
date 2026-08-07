import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Data, Deferred, Duration, Effect, Fiber, Schedule, Scope } from "effect";
import * as v from "valibot";

import {
    openShutdownIntegrationDatabase,
    readShutdownDatabaseSnapshot,
    type ShutdownDatabaseSnapshot,
} from "./shutdownDatabase.ts";
import { idleHttpConnectionResource } from "./shutdownIdleHttpConnection.ts";
import {
    parseShutdownServiceStatus,
    type ShutdownServiceStatus,
} from "./shutdownProtocol.ts";

const serviceModulePath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "shutdownService.ts"
);
const statusMaximumBytes = 64 * 1024;
const operationDeadline = "10 seconds";
const streamCancellationDeadline = "250 millis";
export const linuxProcessStatReadConcurrency = 16;
const statusPollingSchedule = Schedule.spaced("5 millis").pipe(
    Schedule.upTo({ times: 2000 })
);

type ShutdownScenarioServiceProcess = Bun.Subprocess<"ignore", "ignore", "ignore">;

const applicationStateSchema = v.strictObject({
    gatewaySocketOpen: v.boolean(),
    leaseActive: v.boolean(),
    readiness: v.boolean(),
    sseConnectionCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

type ApplicationState = v.InferOutput<typeof applicationStateSchema>;

export class CompleteShutdownScenarioError extends Data.TaggedError(
    "CompleteShutdownScenarioError"
)<{
    readonly cause?: unknown;
    readonly operation: string;
}> {}

export class CompleteShutdownDeadlineError extends Data.TaggedError(
    "CompleteShutdownDeadlineError"
)<{
    readonly operation: string;
}> {}

class ShutdownStatusPendingError extends Data.TaggedError("ShutdownStatusPendingError")<{
    readonly cause?: unknown;
}> {}

export interface ShutdownGenerationEvidence {
    readonly drainingStatus: ShutdownServiceStatus;
    readonly exitCode: number;
    readonly generation: number;
    readonly processGroupMembersAfterExit: readonly number[];
    readonly processGroupMembersWhileReady: readonly number[];
    readonly readyState: ApplicationState;
    readonly readyStatus: ShutdownServiceStatus;
    readonly sseClosedCleanly: boolean;
    readonly sseConnectionCountWhileDraining: number;
    readonly startingReadinessStatus: number;
    readonly stoppedStatus: ShutdownServiceStatus;
    readonly stoppingReadinessStatus: number;
}

export interface CompleteShutdownScenarioReport {
    readonly database: ShutdownDatabaseSnapshot;
    readonly generations: readonly [
        ShutdownGenerationEvidence,
        ShutdownGenerationEvidence,
    ];
}

export interface InterruptedShutdownScenarioReport {
    readonly processGroupMembersAfterInterruption: readonly number[];
    readonly processGroupMembersWhileReady: readonly number[];
    readonly stoppedStatus: ShutdownServiceStatus;
}

function deadlineFailure(operation: string) {
    return new CompleteShutdownDeadlineError({ operation });
}

function withDeadline<A, E>(
    effect: Effect.Effect<A, E>,
    operation: string
): Effect.Effect<A, E | CompleteShutdownDeadlineError> {
    return effect.pipe(
        Effect.timeoutOrElse({
            duration: operationDeadline,
            orElse: () => Effect.fail(deadlineFailure(operation)),
        })
    );
}

/**
 * Attempts one stream cancellation without allowing a non-cooperative promise to
 * block the owning scope's remaining finalizers.
 * @param cancel Promise-returning Web Stream cancellation operation.
 * @param deadline Maximum time to wait before continuing cleanup.
 * @returns Best-effort, Effect-owned cancellation.
 */
export function cancelShutdownStreamBeforeDeadline(
    cancel: () => Promise<void>,
    deadline: Duration.Input = streamCancellationDeadline
): Effect.Effect<void> {
    return Effect.tryPromise(cancel).pipe(
        // Scope finalizers are uninterruptible. Restore interruptibility only for
        // the promise bridge so timeoutOrElse can detach a cancel promise that
        // never settles and let older finalizers continue.
        Effect.interruptible,
        Effect.timeoutOrElse({
            duration: deadline,
            orElse: () => Effect.void,
        }),
        Effect.ignore,
        Effect.asVoid
    );
}

function temporaryWorkspace() {
    return Effect.acquireRelease(
        Effect.tryPromise({
            catch: (cause) =>
                new CompleteShutdownScenarioError({
                    cause,
                    operation: "create-temporary-workspace",
                }),
            try: () => mkdtemp(path.join(tmpdir(), "mira-shutdown-scenario-")),
        }),
        (workspacePath) =>
            Effect.tryPromise(() =>
                rm(workspacePath, { force: true, recursive: true })
            ).pipe(Effect.orDie)
    );
}

function writeMarker(
    markerPath: string
): Effect.Effect<void, CompleteShutdownScenarioError> {
    return Effect.tryPromise({
        catch: (cause) =>
            new CompleteShutdownScenarioError({
                cause,
                operation: "write-control-marker",
            }),
        try: () => Bun.write(markerPath, "ready\n"),
    }).pipe(Effect.asVoid);
}

function awaitServiceExit(
    child: ShutdownScenarioServiceProcess,
    operation: string
): Effect.Effect<number, CompleteShutdownDeadlineError | CompleteShutdownScenarioError> {
    return withDeadline(
        Effect.tryPromise({
            catch: (cause) => new CompleteShutdownScenarioError({ cause, operation }),
            try: () => child.exited,
        }),
        operation
    );
}

function killProcessGroup(processGroupId: number): void {
    try {
        process.kill(-processGroupId, "SIGKILL");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
}

function stopServiceProcess(
    child: ShutdownScenarioServiceProcess,
    acknowledgePath: string
): Effect.Effect<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Effect.sync(() => killProcessGroup(child.pid));
    }
    const graceful = writeMarker(acknowledgePath).pipe(
        Effect.andThen(Effect.sync(() => child.kill("SIGTERM"))),
        Effect.andThen(awaitServiceExit(child, "release-service-process"))
    );
    return graceful.pipe(
        Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () =>
                Effect.sync(() => killProcessGroup(child.pid)).pipe(
                    Effect.andThen(
                        awaitServiceExit(child, "force-release-service-process")
                    )
                ),
        }),
        Effect.asVoid,
        Effect.orDie
    );
}

function serviceProcessResource(options: {
    readonly acknowledgePath: string;
    readonly activatePath: string;
    readonly databasePath: string;
    readonly generation: number;
    readonly statusPath: string;
}): Effect.Effect<
    ShutdownScenarioServiceProcess,
    CompleteShutdownScenarioError,
    Scope.Scope
> {
    return Effect.acquireRelease(
        Effect.try({
            catch: (cause) =>
                new CompleteShutdownScenarioError({
                    cause,
                    operation: "spawn-shutdown-service",
                }),
            try: () =>
                Bun.spawn(
                    [
                        process.execPath,
                        serviceModulePath,
                        options.databasePath,
                        options.statusPath,
                        options.activatePath,
                        options.acknowledgePath,
                        String(options.generation),
                    ],
                    {
                        detached: true,
                        stderr: "ignore",
                        stdin: "ignore",
                        stdout: "ignore",
                    }
                ),
        }),
        (child) => stopServiceProcess(child, options.acknowledgePath)
    );
}

function readStatus(
    statusPath: string,
    predicate: (status: ShutdownServiceStatus) => boolean,
    operation: string
): Effect.Effect<ShutdownServiceStatus, CompleteShutdownDeadlineError> {
    const attempt = Effect.tryPromise({
        catch: (cause) => new ShutdownStatusPendingError({ cause }),
        try: async () => {
            const statusFile = Bun.file(statusPath);
            if (!(await statusFile.exists())) throw new Error("status pending");
            if (statusFile.size > statusMaximumBytes) {
                throw new Error("status exceeds scenario bound");
            }
            const value: unknown = JSON.parse(await statusFile.text());
            const status = parseShutdownServiceStatus(value);
            if (!predicate(status)) throw new Error("status phase pending");
            return status;
        },
    });
    return withDeadline(
        attempt.pipe(
            Effect.retry({ schedule: statusPollingSchedule }),
            Effect.catchTag("ShutdownStatusPendingError", () =>
                Effect.fail(deadlineFailure(operation))
            )
        ),
        operation
    );
}

function fetchResponse(
    url: string,
    operation: string
): Effect.Effect<
    Response,
    CompleteShutdownDeadlineError | CompleteShutdownScenarioError,
    Scope.Scope
> {
    return Effect.gen(function* () {
        const signal = yield* Effect.abortSignal;
        const response = yield* withDeadline(
            Effect.tryPromise({
                catch: (cause) => new CompleteShutdownScenarioError({ cause, operation }),
                try: () => fetch(url, { signal }),
            }),
            operation
        );
        const body = response.body;
        if (body !== null) {
            yield* Effect.addFinalizer(() =>
                cancelShutdownStreamBeforeDeadline(() => body.cancel())
            );
        }
        return response;
    });
}

function readApplicationState(
    baseUrl: string
): Effect.Effect<
    ApplicationState,
    CompleteShutdownDeadlineError | CompleteShutdownScenarioError,
    Scope.Scope
> {
    return Effect.gen(function* () {
        const response = yield* fetchResponse(
            `${baseUrl}/api/shutdown/state`,
            "read-application-state"
        );
        if (!response.ok) {
            return yield* Effect.fail(
                new CompleteShutdownScenarioError({
                    operation: "application-state-status",
                })
            );
        }
        const value = yield* Effect.tryPromise({
            catch: (cause) =>
                new CompleteShutdownScenarioError({
                    cause,
                    operation: "parse-application-state",
                }),
            try: () => response.json(),
        });
        return v.parse(applicationStateSchema, value);
    });
}

interface SseReader {
    cancel(): Promise<void>;
    read(): Promise<{
        readonly done: boolean;
        readonly value?: Uint8Array;
    }>;
}

interface SseConnection {
    readonly reader: SseReader;
}

function sseConnectionResource(
    baseUrl: string
): Effect.Effect<
    SseConnection,
    CompleteShutdownDeadlineError | CompleteShutdownScenarioError,
    Scope.Scope
> {
    return Effect.acquireRelease(
        Effect.gen(function* () {
            const response = yield* fetchResponse(
                `${baseUrl}/api/events`,
                "open-sse-connection"
            );
            if (
                !response.ok ||
                !response.headers.get("content-type")?.startsWith("text/event-stream") ||
                response.body === null
            ) {
                return yield* Effect.fail(
                    new CompleteShutdownScenarioError({
                        operation: "validate-sse-connection",
                    })
                );
            }
            const reader: SseReader = response.body.getReader();
            const cancelReader = cancelShutdownStreamBeforeDeadline(() =>
                reader.cancel()
            );
            const first = yield* withDeadline(
                Effect.tryPromise({
                    catch: (cause) =>
                        new CompleteShutdownScenarioError({
                            cause,
                            operation: "read-sse-opening-event",
                        }),
                    try: () => reader.read(),
                }),
                "read-sse-opening-event"
            ).pipe(Effect.onError(() => cancelReader));
            if (
                first.done ||
                first.value === undefined ||
                !new TextDecoder().decode(first.value).includes("event: ready")
            ) {
                yield* cancelReader;
                return yield* Effect.fail(
                    new CompleteShutdownScenarioError({
                        operation: "validate-sse-opening-event",
                    })
                );
            }
            return Object.freeze({ reader });
        }),
        ({ reader }) => cancelShutdownStreamBeforeDeadline(() => reader.cancel())
    );
}

function awaitSseClosed(
    connection: SseConnection
): Effect.Effect<boolean, CompleteShutdownDeadlineError | CompleteShutdownScenarioError> {
    return withDeadline(
        Effect.tryPromise({
            catch: (cause) =>
                new CompleteShutdownScenarioError({
                    cause,
                    operation: "await-sse-close",
                }),
            try: () => connection.reader.read(),
        }).pipe(Effect.map(({ done }) => done)),
        "await-sse-close"
    );
}

/**
 * Parses Linux `/proc/<pid>/stat` into process identifiers.
 * @param text Raw stat record.
 * @returns Process and process-group IDs.
 */
export function parseLinuxProcessStat(text: string): {
    readonly processGroupId: number;
    readonly processId: number;
} {
    const commandEnd = text.lastIndexOf(")");
    const commandStart = text.indexOf("(");
    if (commandStart <= 0 || commandEnd <= commandStart) {
        throw new Error("Malformed Linux process stat record");
    }
    const processId = Number(text.slice(0, commandStart).trim());
    const fields = text
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/u);
    const processGroupId = Number(fields[2]);
    if (!Number.isSafeInteger(processId) || !Number.isSafeInteger(processGroupId)) {
        throw new TypeError("Linux process stat identifiers are invalid");
    }
    return Object.freeze({ processGroupId, processId });
}

/**
 * Collects one process group's members with bounded `/proc` stat fanout.
 * @param candidateProcessIds Candidate process identifiers read from `/proc`.
 * @param processGroupId Process group to retain.
 * @param readProcessStat Effectful, injectable stat-record reader.
 * @returns Sorted process identifiers belonging to the requested group.
 */
export function collectLinuxProcessGroupMembers<E>(
    candidateProcessIds: readonly number[],
    processGroupId: number,
    readProcessStat: (processId: number) => Effect.Effect<string | null, E>
): Effect.Effect<readonly number[], CompleteShutdownScenarioError | E> {
    return Effect.forEach(
        candidateProcessIds,
        (processId) =>
            readProcessStat(processId).pipe(
                Effect.flatMap((text) =>
                    text === null
                        ? Effect.succeed(null)
                        : Effect.try({
                              catch: (cause) =>
                                  new CompleteShutdownScenarioError({
                                      cause,
                                      operation: "parse-linux-process-stat",
                                  }),
                              try: () => parseLinuxProcessStat(text),
                          })
                )
            ),
        { concurrency: linuxProcessStatReadConcurrency }
    ).pipe(
        Effect.map((records) =>
            Object.freeze(
                records
                    .filter(
                        (record): record is NonNullable<(typeof records)[number]> =>
                            record !== null && record.processGroupId === processGroupId
                    )
                    .map((record) => record.processId)
                    .toSorted((left, right) => left - right)
            )
        )
    );
}

export function readLinuxProcessGroupMembers(
    processGroupId: number
): Effect.Effect<readonly number[], CompleteShutdownScenarioError> {
    return Effect.gen(function* () {
        const entries = yield* Effect.tryPromise({
            catch: (cause) =>
                new CompleteShutdownScenarioError({
                    cause,
                    operation: "inspect-linux-process-group",
                }),
            try: () => readdir("/proc", { withFileTypes: true }),
        });
        const candidateProcessIds = entries
            .filter((entry) => entry.isDirectory() && /^[1-9][0-9]*$/u.test(entry.name))
            .map((entry) => Number(entry.name));
        return yield* collectLinuxProcessGroupMembers(
            candidateProcessIds,
            processGroupId,
            (processId) =>
                Effect.tryPromise({
                    catch: (cause) =>
                        new CompleteShutdownScenarioError({
                            cause,
                            operation: "read-linux-process-stat",
                        }),
                    try: () => readFile(`/proc/${processId}/stat`, "utf8"),
                }).pipe(
                    Effect.catchIf(
                        (error) =>
                            (error.cause as NodeJS.ErrnoException | undefined)?.code ===
                            "ENOENT",
                        () => Effect.succeed(null)
                    )
                )
        );
    });
}

function runGeneration(
    workspacePath: string,
    databasePath: string,
    generation: number
): Effect.Effect<
    ShutdownGenerationEvidence,
    CompleteShutdownDeadlineError | CompleteShutdownScenarioError
> {
    const prefix = path.join(workspacePath, `generation-${generation}`);
    const statusPath = `${prefix}.status.json`;
    const activatePath = `${prefix}.activate`;
    const acknowledgePath = `${prefix}.acknowledge`;

    return Effect.scoped(
        Effect.gen(function* () {
            const child = yield* serviceProcessResource({
                acknowledgePath,
                activatePath,
                databasePath,
                generation,
                statusPath,
            });
            const startingStatus = yield* readStatus(
                statusPath,
                (status) => status.phase === "starting",
                "await-starting-status"
            );
            const baseUrl = `http://127.0.0.1:${startingStatus.port}`;
            const startingReadiness = yield* fetchResponse(
                `${baseUrl}/api/health/ready`,
                "read-starting-readiness"
            );

            yield* writeMarker(activatePath);
            const readyStatus = yield* readStatus(
                statusPath,
                (status) => status.phase === "ready",
                "await-ready-status"
            );
            const readyReadiness = yield* fetchResponse(
                `${baseUrl}/api/health/ready`,
                "read-ready-readiness"
            );
            if (readyReadiness.status !== 200) {
                return yield* Effect.fail(
                    new CompleteShutdownScenarioError({
                        operation: "ready-readiness-status",
                    })
                );
            }
            const connection = yield* sseConnectionResource(baseUrl);
            const readyState = yield* readApplicationState(baseUrl);
            yield* idleHttpConnectionResource(baseUrl).pipe(
                Effect.mapError(
                    (cause) =>
                        new CompleteShutdownScenarioError({
                            cause,
                            operation: "hold-idle-http-connection",
                        })
                )
            );
            const processGroupMembersWhileReady = yield* readLinuxProcessGroupMembers(
                child.pid
            );

            yield* Effect.sync(() => child.kill("SIGTERM"));
            const drainingStatus = yield* readStatus(
                statusPath,
                (status) => status.phase === "draining",
                "await-draining-status"
            );
            const stoppingReadiness = yield* fetchResponse(
                `${baseUrl}/api/health/ready`,
                "read-stopping-readiness"
            );
            const drainingState = yield* readApplicationState(baseUrl);
            yield* writeMarker(acknowledgePath);

            const exitCode = yield* awaitServiceExit(child, "await-service-exit");
            const sseClosedCleanly = yield* awaitSseClosed(connection);
            const stoppedStatus = yield* readStatus(
                statusPath,
                (status) => status.phase === "stopped",
                "await-stopped-status"
            );
            const processGroupMembersAfterExit = yield* readLinuxProcessGroupMembers(
                child.pid
            );

            return Object.freeze({
                drainingStatus,
                exitCode,
                generation,
                processGroupMembersAfterExit,
                processGroupMembersWhileReady,
                readyState,
                readyStatus,
                sseClosedCleanly,
                sseConnectionCountWhileDraining: drainingState.sseConnectionCount,
                startingReadinessStatus: startingReadiness.status,
                stoppedStatus,
                stoppingReadinessStatus: stoppingReadiness.status,
            });
        })
    );
}

function databaseSnapshotResource(databasePath: string) {
    return Effect.acquireRelease(
        Effect.sync(() => openShutdownIntegrationDatabase(databasePath)),
        (database) => Effect.sync(() => database.close(true))
    );
}

/** Runs two production-shaped process generations against one WAL database. */
export const completeShutdownScenario = Effect.scoped(
    Effect.gen(function* () {
        const workspacePath = yield* temporaryWorkspace();
        const databasePath = path.join(workspacePath, "shutdown.sqlite");
        const first = yield* runGeneration(workspacePath, databasePath, 1);
        const second = yield* runGeneration(workspacePath, databasePath, 2);
        const database = yield* databaseSnapshotResource(databasePath);
        const snapshot = yield* Effect.sync(() => readShutdownDatabaseSnapshot(database));
        return Object.freeze({
            database: snapshot,
            generations: Object.freeze([first, second] as const),
        });
    })
);

/** Proves that interrupting the owning Effect scope releases the full process tree. */
export const interruptedShutdownScenario = Effect.scoped(
    Effect.gen(function* () {
        const workspacePath = yield* temporaryWorkspace();
        const databasePath = path.join(workspacePath, "interrupted.sqlite");
        const statusPath = path.join(workspacePath, "interrupted.status.json");
        const activatePath = path.join(workspacePath, "interrupted.activate");
        const acknowledgePath = path.join(workspacePath, "interrupted.acknowledge");
        const ready = yield* Deferred.make<{
            readonly processGroupId: number;
            readonly status: ShutdownServiceStatus;
        }>();

        const ownedProcess = Effect.scoped(
            Effect.gen(function* () {
                const child = yield* serviceProcessResource({
                    acknowledgePath,
                    activatePath,
                    databasePath,
                    generation: 1,
                    statusPath,
                });
                yield* readStatus(
                    statusPath,
                    (status) => status.phase === "starting",
                    "await-interrupted-starting-status"
                );
                yield* writeMarker(activatePath);
                const status = yield* readStatus(
                    statusPath,
                    (candidate) => candidate.phase === "ready",
                    "await-interrupted-ready-status"
                );
                yield* Deferred.succeed(ready, {
                    processGroupId: child.pid,
                    status,
                });
                return yield* Effect.never;
            })
        );

        const fiber = yield* Effect.forkChild(ownedProcess);
        const readyState = yield* withDeadline(
            Deferred.await(ready),
            "await-interrupted-process"
        );
        const processGroupMembersWhileReady = yield* readLinuxProcessGroupMembers(
            readyState.processGroupId
        );
        yield* Fiber.interrupt(fiber);
        const stoppedStatus = yield* readStatus(
            statusPath,
            (status) => status.phase === "stopped",
            "await-interrupted-stopped-status"
        );
        const processGroupMembersAfterInterruption = yield* readLinuxProcessGroupMembers(
            readyState.processGroupId
        );
        return Object.freeze({
            processGroupMembersAfterInterruption,
            processGroupMembersWhileReady,
            stoppedStatus,
        });
    })
);
