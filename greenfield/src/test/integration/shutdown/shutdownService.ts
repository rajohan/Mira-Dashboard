import { Database, type SQLQueryBindings, type Statement } from "bun:sqlite";

import { Data, Effect, Scope } from "effect";
import * as v from "valibot";

import {
    acquireShutdownWorkerLease,
    completeShutdownGeneration,
    openShutdownIntegrationDatabase,
    releaseShutdownWorkerLease,
    startShutdownGeneration,
} from "./shutdownDatabase.ts";
import {
    type ShutdownLifecycleEvent,
    type ShutdownServiceStatus,
} from "./shutdownProtocol.ts";
import {
    applicationServerResource,
    awaitMarkerFile,
    gatewayFixtureResource,
    gatewaySocketResource,
    grandchildProcessResource,
    shutdownSignalResource,
    ShutdownIntegrationResourceError,
    writeShutdownStatus,
} from "./shutdownServiceResources.ts";

const serviceCommandSchema = v.strictObject({
    acknowledgePath: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    activatePath: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    databasePath: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    generation: v.pipe(v.number(), v.integer(), v.minValue(1)),
    statusPath: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
});

type ServiceCommand = v.InferOutput<typeof serviceCommandSchema>;

class ShutdownIntegrationArgumentError extends Data.TaggedError(
    "ShutdownIntegrationArgumentError"
)<{
    readonly message: string;
}> {}

function parsePositiveInteger(value: string | undefined): number {
    if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return Number.NaN;
    return Number(value);
}

function parseCommand(arguments_: readonly string[]): ServiceCommand {
    const [databasePath, statusPath, activatePath, acknowledgePath, generation] =
        arguments_;
    try {
        return v.parse(serviceCommandSchema, {
            acknowledgePath,
            activatePath,
            databasePath,
            generation: parsePositiveInteger(generation),
            statusPath,
        });
    } catch {
        throw new ShutdownIntegrationArgumentError({
            message: "Invalid shutdown integration service arguments",
        });
    }
}

function databaseResource(databasePath: string) {
    return Effect.acquireRelease(
        Effect.try({
            catch: (cause) =>
                new ShutdownIntegrationResourceError({
                    cause,
                    operation: "open-database",
                }),
            try: () => openShutdownIntegrationDatabase(databasePath),
        }),
        (database) => Effect.sync(() => database.close(true))
    );
}

function generationResource(
    database: Database,
    generation: number
): Effect.Effect<number, never, Scope.Scope> {
    return Effect.acquireRelease(
        Effect.sync(() =>
            startShutdownGeneration(database, generation, process.pid, Date.now())
        ),
        () =>
            Effect.sync(() =>
                completeShutdownGeneration(database, generation, Date.now())
            )
    );
}

function workerLeaseResource(
    database: Database,
    generation: number
): Effect.Effect<void, never, Scope.Scope> {
    return Effect.acquireRelease(
        Effect.sync(() => {
            acquireShutdownWorkerLease(database, generation, process.pid);
        }),
        () =>
            Effect.sync(() =>
                releaseShutdownWorkerLease(database, generation, Date.now())
            )
    );
}

function preparedStatementResource(
    database: Database,
    generation: number
): Effect.Effect<
    Statement<{ generation: number }, SQLQueryBindings[]>,
    never,
    Scope.Scope
> {
    return Effect.acquireRelease(
        Effect.sync(() => {
            const statement = database.prepare<
                { generation: number },
                SQLQueryBindings[]
            >("SELECT generation FROM shutdown_generations WHERE generation = ?");
            const row = statement.get(generation);
            if (row?.generation !== generation) {
                statement.finalize();
                throw new Error("Shutdown integration prepared statement failed");
            }
            return statement;
        }),
        (statement) => Effect.sync(() => statement.finalize())
    );
}

function appendEvent(
    events: ShutdownLifecycleEvent[],
    event: ShutdownLifecycleEvent
): void {
    events.push(event);
}

function statusSnapshot(options: {
    readonly application: {
        readonly port: number;
        readonly sseConnectionCount: number;
    };
    readonly events: readonly ShutdownLifecycleEvent[];
    readonly gatewaySocketOpen: boolean;
    readonly generation: number;
    readonly grandchildPid?: number;
    readonly leaseActive: boolean;
    readonly phase: ShutdownServiceStatus["phase"];
    readonly readiness: boolean;
    readonly recoveredGenerationCount: number;
}): ShutdownServiceStatus {
    return {
        events: [...options.events],
        gatewaySocketOpen: options.gatewaySocketOpen,
        generation: options.generation,
        ...(options.grandchildPid === undefined
            ? {}
            : { grandchildPid: options.grandchildPid }),
        leaseActive: options.leaseActive,
        phase: options.phase,
        pid: process.pid,
        port: options.application.port,
        readiness: options.readiness,
        recoveredGenerationCount: options.recoveredGenerationCount,
        schemaVersion: 1,
        sseConnectionCount: options.application.sseConnectionCount,
    };
}

function runService(command: ServiceCommand) {
    const events: ShutdownLifecycleEvent[] = [];
    const state = {
        gatewaySocketOpen: false,
        leaseActive: false,
        readiness: false,
    };
    let application:
        | {
              readonly port: number;
              readonly sseConnectionCount: number;
          }
        | undefined;
    let grandchildPid: number | undefined;
    let recoveredGenerationCount = 0;

    const snapshot = (phase: ShutdownServiceStatus["phase"]): ShutdownServiceStatus => {
        if (application === undefined) {
            throw new Error("Shutdown integration application is unavailable");
        }
        return statusSnapshot({
            application,
            events,
            gatewaySocketOpen: state.gatewaySocketOpen,
            generation: command.generation,
            grandchildPid,
            leaseActive: state.leaseActive,
            phase,
            readiness: state.readiness,
            recoveredGenerationCount,
        });
    };

    const lifecycle = Effect.scoped(
        Effect.gen(function* () {
            const signal = yield* shutdownSignalResource();
            appendEvent(events, "signal-handler-installed");

            const applicationServer = yield* applicationServerResource(state);
            application = applicationServer;
            appendEvent(events, "listener-open");
            yield* writeShutdownStatus(command.statusPath, snapshot("starting"));
            yield* awaitMarkerFile(command.activatePath, "await-activation");

            yield* Effect.addFinalizer(() =>
                Effect.sync(() => appendEvent(events, "database-closed"))
            );
            const database = yield* databaseResource(command.databasePath);
            appendEvent(events, "database-open");

            yield* Effect.addFinalizer(() =>
                Effect.sync(() => appendEvent(events, "database-checkpointed"))
            );
            recoveredGenerationCount = yield* generationResource(
                database,
                command.generation
            );

            yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                    state.leaseActive = false;
                    appendEvent(events, "worker-lease-released");
                })
            );
            yield* workerLeaseResource(database, command.generation);
            state.leaseActive = true;
            appendEvent(events, "worker-lease-acquired");

            yield* Effect.addFinalizer(() =>
                Effect.sync(() => appendEvent(events, "statement-finalized"))
            );
            yield* preparedStatementResource(database, command.generation);
            appendEvent(events, "statement-prepared");

            yield* Effect.addFinalizer(() =>
                Effect.sync(() => appendEvent(events, "child-process-reaped"))
            );
            const grandchild = yield* grandchildProcessResource();
            grandchildPid = grandchild.pid;
            appendEvent(events, "child-process-started");

            yield* Effect.addFinalizer(() =>
                Effect.sync(() => appendEvent(events, "gateway-fixture-closed"))
            );
            const gatewayFixture = yield* gatewayFixtureResource();
            appendEvent(events, "gateway-fixture-open");

            yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                    state.gatewaySocketOpen = false;
                    appendEvent(events, "gateway-socket-closed");
                })
            );
            yield* gatewaySocketResource(gatewayFixture.url);
            state.gatewaySocketOpen = true;
            appendEvent(events, "gateway-socket-open");

            state.readiness = true;
            appendEvent(events, "readiness-up");
            yield* writeShutdownStatus(command.statusPath, snapshot("ready"));

            yield* signal.awaitSignal;
            appendEvent(events, "shutdown-requested");
            state.readiness = false;
            appendEvent(events, "readiness-down");
            yield* writeShutdownStatus(command.statusPath, snapshot("draining"));
            yield* awaitMarkerFile(
                command.acknowledgePath,
                "await-drain-acknowledgement"
            );

            const listenerStopMode = yield* applicationServer.close();
            appendEvent(
                events,
                listenerStopMode === "graceful"
                    ? "listener-drained"
                    : "listener-force-stopped"
            );
            appendEvent(events, "sse-server-closed");
        })
    );

    return Effect.gen(function* () {
        yield* lifecycle;
        appendEvent(events, "stopped");
        yield* writeShutdownStatus(command.statusPath, snapshot("stopped"));
    });
}

try {
    const command = parseCommand(process.argv.slice(2));
    await Effect.runPromise(runService(command));
} catch (error) {
    const diagnostic = Bun.inspect(error, { colors: false, depth: 6 }).slice(
        0,
        16 * 1024
    );
    process.stderr.write(`Complete-shutdown integration service failed\n${diagnostic}\n`);
    process.exitCode = 1;
}
