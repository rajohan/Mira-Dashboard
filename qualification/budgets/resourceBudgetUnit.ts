import { rename } from "node:fs/promises";
import path from "node:path";

import { Clock, Data, Effect, Scope } from "effect";

import {
    readCgroupV2ControlFile,
    readCurrentCgroupV2Snapshot,
    type CgroupV2MemoryEvents,
} from "../resources/cgroupV2.ts";
import {
    buildResourceBudgetWorkloadCommand,
    type ResourceBudgetWorkloadCommand,
} from "./resourceBudgetCommand.ts";
import {
    assertResourceBudgetUnitName,
    expectedResourceBudgetCgroupPath,
    resourceBudgetPolicy,
    resourceBudgetScenarioIds,
    type ResourceBudgetScenarioId,
    type ResourceBudgetUnitReport,
} from "./resourceBudgetPolicy.ts";

const nanosecondsPerMillisecond = 1_000_000n;
type WorkloadProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

export class ResourceBudgetUnitError extends Data.TaggedError("ResourceBudgetUnitError")<{
    readonly cause?: unknown;
    readonly operation: string;
}> {}

export class ResourceBudgetUnitDeadlineError extends Data.TaggedError(
    "ResourceBudgetUnitDeadlineError"
)<{
    readonly scenarioId: ResourceBudgetScenarioId;
}> {}

interface ResourceBudgetUnitArguments {
    readonly repositoryRoot: string;
    readonly resultPath: string;
    readonly scenarioId: ResourceBudgetScenarioId;
    readonly unitName: string;
}

interface PressureTotals {
    readonly fullTotalMicros: number;
    readonly someTotalMicros: number;
}

interface ResourceSnapshot {
    readonly cpuNrThrottled: number;
    readonly cpuPressure: PressureTotals;
    readonly cpuThrottledMicros: number;
    readonly cpuUsageMicros: number;
    readonly memoryCurrentBytes: number;
    readonly memoryEvents: Readonly<CgroupV2MemoryEvents>;
    readonly memoryPressure: PressureTotals;
    readonly pidsCurrent: number;
}

function parseArguments(arguments_: readonly string[]): ResourceBudgetUnitArguments {
    if (arguments_.length !== 4) {
        throw new TypeError("Resource-budget unit requires exactly four arguments");
    }
    const values = Object.fromEntries(
        arguments_.map((argument) => {
            const separator = argument.indexOf("=");
            if (!argument.startsWith("--") || separator <= 2) {
                throw new TypeError("Resource-budget unit argument is malformed");
            }
            return [argument.slice(2, separator), argument.slice(separator + 1)];
        })
    );
    if (Object.keys(values).length !== 4) {
        throw new TypeError("Resource-budget unit arguments contain duplicates");
    }
    const repositoryRoot = values.repository ?? "";
    const resultPath = values.result ?? "";
    const scenarioId = values.scenario ?? "";
    const unitName = values.unit ?? "";
    if (
        !path.isAbsolute(repositoryRoot) ||
        !path.isAbsolute(resultPath) ||
        repositoryRoot.includes("\0") ||
        resultPath.includes("\0") ||
        !resourceBudgetScenarioIds.includes(scenarioId as ResourceBudgetScenarioId)
    ) {
        throw new TypeError("Resource-budget unit arguments are invalid");
    }
    assertResourceBudgetUnitName(unitName);
    return {
        repositoryRoot,
        resultPath,
        scenarioId: scenarioId as ResourceBudgetScenarioId,
        unitName,
    };
}

function parseNamedCounters(
    value: string,
    requiredNames: readonly string[]
): Map<string, number> {
    const counters = new Map<string, number>();
    for (const line of value.split(/\r?\n/u)) {
        const normalized = line.trim();
        if (normalized.length === 0) continue;
        const [name, rawCounter, ...extra] = normalized.split(/\s+/u);
        if (
            name === undefined ||
            rawCounter === undefined ||
            extra.length > 0 ||
            !/^\d+$/u.test(rawCounter) ||
            counters.has(name)
        ) {
            throw new Error("Malformed cgroup counter file");
        }
        const counter = Number(rawCounter);
        if (!Number.isSafeInteger(counter)) {
            throw new TypeError("Cgroup counter exceeds the safe integer range");
        }
        counters.set(name, counter);
    }
    for (const name of requiredNames) {
        if (!counters.has(name)) throw new Error(`Missing cgroup counter ${name}`);
    }
    return counters;
}

function parsePressure(value: string): PressureTotals {
    const totals = new Map<string, number>();
    for (const line of value.split(/\r?\n/u)) {
        const normalized = line.trim();
        if (normalized.length === 0) continue;
        const [kind, ...fields] = normalized.split(/\s+/u);
        if ((kind !== "some" && kind !== "full") || totals.has(kind)) {
            throw new Error("Malformed cgroup pressure file");
        }
        const total = fields.find((field) => field.startsWith("total="));
        const rawTotal = total?.slice("total=".length) ?? "";
        if (!/^\d+$/u.test(rawTotal)) {
            throw new Error("Malformed cgroup pressure total");
        }
        const parsed = Number(rawTotal);
        if (!Number.isSafeInteger(parsed)) {
            throw new TypeError("Cgroup pressure total exceeds the safe integer range");
        }
        totals.set(kind, parsed);
    }
    const fullTotalMicros = totals.get("full");
    const someTotalMicros = totals.get("some");
    if (fullTotalMicros === undefined || someTotalMicros === undefined) {
        throw new Error("Incomplete cgroup pressure file");
    }
    return { fullTotalMicros, someTotalMicros };
}

function readResourceSnapshot(): Effect.Effect<
    ResourceSnapshot,
    ResourceBudgetUnitError
> {
    return Effect.tryPromise({
        catch: (cause) =>
            new ResourceBudgetUnitError({ cause, operation: "read-cgroup-snapshot" }),
        try: async () => {
            const cgroup = await readCurrentCgroupV2Snapshot();
            const [cpuStatText, cpuPressureText, memoryPressureText] = await Promise.all([
                readCgroupV2ControlFile(cgroup.path, "cpu.stat"),
                readCgroupV2ControlFile(cgroup.path, "cpu.pressure"),
                readCgroupV2ControlFile(cgroup.path, "memory.pressure"),
            ]);
            const cpu = parseNamedCounters(cpuStatText, [
                "usage_usec",
                "nr_throttled",
                "throttled_usec",
            ]);
            return {
                cpuNrThrottled: cpu.get("nr_throttled")!,
                cpuPressure: parsePressure(cpuPressureText),
                cpuThrottledMicros: cpu.get("throttled_usec")!,
                cpuUsageMicros: cpu.get("usage_usec")!,
                memoryCurrentBytes: cgroup.memoryCurrentBytes,
                memoryEvents: cgroup.memoryEvents,
                memoryPressure: parsePressure(memoryPressureText),
                pidsCurrent: cgroup.pidsCurrent,
            };
        },
    });
}

function awaitProcessExit(
    process_: WorkloadProcess
): Effect.Effect<number, ResourceBudgetUnitError> {
    return Effect.tryPromise({
        catch: (cause) =>
            new ResourceBudgetUnitError({ cause, operation: "await-workload-exit" }),
        try: () => process_.exited,
    });
}

function stopProcess(process_: WorkloadProcess): Effect.Effect<void> {
    if (process_.exitCode !== null || process_.signalCode !== null) return Effect.void;
    const graceful = Effect.sync(() => process_.kill("SIGTERM")).pipe(
        Effect.andThen(awaitProcessExit(process_)),
        Effect.timeoutOrElse({
            duration: "2 seconds",
            orElse: () =>
                Effect.sync(() => process_.kill("SIGKILL")).pipe(
                    Effect.andThen(awaitProcessExit(process_))
                ),
        })
    );
    return graceful.pipe(Effect.asVoid, Effect.orDie);
}

function workloadProcessResource(
    command: ResourceBudgetWorkloadCommand,
    repositoryRoot: string
): Effect.Effect<WorkloadProcess, ResourceBudgetUnitError, Scope.Scope> {
    return Effect.gen(function* () {
        const signal = yield* Effect.abortSignal;
        return yield* Effect.acquireRelease(
            Effect.try({
                catch: (cause) =>
                    new ResourceBudgetUnitError({
                        cause,
                        operation: "spawn-workload",
                    }),
                try: () =>
                    Bun.spawn([...command.argv], {
                        cwd: repositoryRoot,
                        env: command.environment,
                        killSignal: "SIGTERM",
                        maxBuffer: resourceBudgetPolicy.childOutputMaxBytes,
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

function captureOutput(
    stream: ReadableStream<Uint8Array>,
    operation: string
): Effect.Effect<number, ResourceBudgetUnitError> {
    return Effect.tryPromise({
        catch: (cause) => new ResourceBudgetUnitError({ cause, operation }),
        try: async () => {
            const output = await new Response(stream).arrayBuffer();
            return output.byteLength;
        },
    });
}

function runWorkload(
    arguments_: ResourceBudgetUnitArguments,
    environment: Readonly<Record<string, string>>
) {
    const command = buildResourceBudgetWorkloadCommand(
        arguments_.scenarioId,
        arguments_.repositoryRoot,
        process.execPath,
        environment
    );
    const deadlineMs =
        resourceBudgetPolicy.scenarios[arguments_.scenarioId].limits.workloadDeadlineMs;
    return Effect.scoped(
        Effect.gen(function* () {
            const startedAt = yield* Clock.monotonicTimeNanos;
            const process_ = yield* workloadProcessResource(
                command,
                arguments_.repositoryRoot
            );
            const [exitCode, stderrBytes, stdoutBytes] = yield* Effect.all(
                [
                    awaitProcessExit(process_),
                    captureOutput(process_.stderr, "read-workload-stderr"),
                    captureOutput(process_.stdout, "read-workload-stdout"),
                ] as const,
                { concurrency: "unbounded" }
            ).pipe(
                Effect.timeoutOrElse({
                    duration: deadlineMs,
                    orElse: () =>
                        Effect.fail(
                            new ResourceBudgetUnitDeadlineError({
                                scenarioId: arguments_.scenarioId,
                            })
                        ),
                })
            );
            const endedAt = yield* Clock.monotonicTimeNanos;
            return Object.freeze({
                durationMs: Number((endedAt - startedAt) / nanosecondsPerMillisecond),
                exitCode,
                signalCode: process_.signalCode,
                stderrBytes,
                stdoutBytes,
            });
        })
    );
}

function readFinalProcessIds(cgroupPath: string) {
    return Effect.tryPromise({
        catch: (cause) =>
            new ResourceBudgetUnitError({ cause, operation: "read-final-processes" }),
        try: async () => {
            const value = await readCgroupV2ControlFile(cgroupPath, "cgroup.procs");
            return value
                .split(/\r?\n/u)
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0)
                .map((entry) => {
                    if (!/^\d+$/u.test(entry)) {
                        throw new Error("Malformed cgroup.procs entry");
                    }
                    return Number(entry);
                })
                .toSorted((left, right) => left - right);
        },
    });
}

function writeReport(resultPath: string, report: ResourceBudgetUnitReport) {
    return Effect.tryPromise({
        catch: (cause) =>
            new ResourceBudgetUnitError({ cause, operation: "write-unit-report" }),
        try: async () => {
            const temporaryPath = `${resultPath}.tmp`;
            await Bun.write(temporaryPath, `${JSON.stringify(report, null, 2)}\n`);
            await rename(temporaryPath, resultPath);
        },
    });
}

function runUnit(arguments_: ResourceBudgetUnitArguments) {
    return Effect.gen(function* () {
        if (process.getuid === undefined) {
            return yield* Effect.fail(
                new ResourceBudgetUnitError({ operation: "read-user-id" })
            );
        }
        const initialCgroup = yield* Effect.tryPromise({
            catch: (cause) =>
                new ResourceBudgetUnitError({
                    cause,
                    operation: "read-initial-cgroup",
                }),
            try: () => readCurrentCgroupV2Snapshot(),
        });
        const expectedPath = expectedResourceBudgetCgroupPath(
            process.getuid(),
            arguments_.unitName
        );
        if (initialCgroup.path !== expectedPath) {
            return yield* Effect.fail(
                new ResourceBudgetUnitError({ operation: "verify-cgroup-membership" })
            );
        }
        const policy = resourceBudgetPolicy.scenarios[arguments_.scenarioId].limits;
        if (
            initialCgroup.memoryHighBytes !== policy.memoryHighBytes ||
            initialCgroup.memoryMaxBytes !== policy.memoryMaxBytes ||
            initialCgroup.memorySwapMaxBytes !== policy.memorySwapMaxBytes ||
            initialCgroup.pidsMax !== policy.tasksMax ||
            initialCgroup.cpuQuotaMicros === "max" ||
            initialCgroup.cpuQuotaMicros * 100 !==
                initialCgroup.cpuPeriodMicros * policy.cpuQuotaPercent ||
            !initialCgroup.oomGroup
        ) {
            return yield* Effect.fail(
                new ResourceBudgetUnitError({ operation: "verify-cgroup-policy" })
            );
        }

        const initial = yield* readResourceSnapshot();
        const environment = Object.freeze({
            CI: process.env.CI ?? "1",
            FORCE_COLOR: "0",
            HOME: process.env.HOME ?? "",
            LANG: "C.UTF-8",
            NODE_ENV: "test",
            NO_COLOR: "1",
            PATH: "/usr/local/bin:/usr/bin:/bin",
            TMPDIR: process.env.TMPDIR ?? "/tmp",
        });
        const workload = yield* runWorkload(arguments_, environment);
        const finalCgroup = yield* Effect.tryPromise({
            catch: (cause) =>
                new ResourceBudgetUnitError({
                    cause,
                    operation: "read-final-cgroup",
                }),
            try: () => readCurrentCgroupV2Snapshot(),
        });
        const [final, finalProcessIds, pidsPeakText] = yield* Effect.all(
            [
                readResourceSnapshot(),
                readFinalProcessIds(finalCgroup.path),
                Effect.tryPromise({
                    catch: (cause) =>
                        new ResourceBudgetUnitError({
                            cause,
                            operation: "read-pids-peak",
                        }),
                    try: () => readCgroupV2ControlFile(finalCgroup.path, "pids.peak"),
                }),
            ] as const,
            { concurrency: "unbounded" }
        );
        const pidsPeak = Number(pidsPeakText.trim());
        if (!Number.isSafeInteger(pidsPeak) || pidsPeak < 0) {
            return yield* Effect.fail(
                new ResourceBudgetUnitError({ operation: "parse-pids-peak" })
            );
        }
        const report: ResourceBudgetUnitReport = {
            cgroup: {
                final,
                finalProcessIds,
                initial,
                memoryPeakBytes: finalCgroup.memoryPeakBytes,
                path: finalCgroup.path,
                pidsPeak,
            },
            formatVersion: resourceBudgetPolicy.formatVersion,
            limits: {
                cpuPeriodMicros: finalCgroup.cpuPeriodMicros,
                cpuQuotaMicros: finalCgroup.cpuQuotaMicros as number,
                memoryHighBytes: finalCgroup.memoryHighBytes as number,
                memoryMaxBytes: finalCgroup.memoryMaxBytes as number,
                memorySwapMaxBytes: finalCgroup.memorySwapMaxBytes as number,
                oomGroup: true,
                pidsMax: finalCgroup.pidsMax as number,
            },
            runtime: {
                bunRevision: Bun.revision,
                bunVersion: Bun.version,
            },
            scenarioId: arguments_.scenarioId,
            unitName: arguments_.unitName,
            workload,
            wrapperProcessId: process.pid,
        };
        yield* writeReport(arguments_.resultPath, report);
    });
}

if (import.meta.main) {
    try {
        const arguments_ = parseArguments(Bun.argv.slice(2));
        await Effect.runPromise(runUnit(arguments_));
    } catch (error) {
        process.stderr.write(
            `${Bun.inspect(error, { colors: false, depth: 6 }).slice(0, 16 * 1024)}\n`
        );
        process.exitCode = 1;
    }
}
