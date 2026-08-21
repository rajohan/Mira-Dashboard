import path from "node:path";

import * as v from "valibot";

const mebibyte = 1024 * 1024;
const resourceBudgetUnitIdentifierPattern =
    /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;

export const resourceBudgetScenarioIds = [
    "frontend-build",
    "representative-tests",
    "sqlite-outbox",
    "complete-shutdown",
    "child-cancellation",
] as const;

const resourceBudgetUnitNamePattern = new RegExp(
    `^mira-dashboard-resource-(?:${resourceBudgetScenarioIds.join("|")})-[\\da-f]{8}(?:-[\\da-f]{4}){3}-[\\da-f]{12}$`,
    "iu"
);

export type ResourceBudgetScenarioId = (typeof resourceBudgetScenarioIds)[number];

export interface ResourceBudgetLimits {
    readonly cpuQuotaPercent: number;
    readonly memoryHighBytes: number;
    readonly memoryMaxBytes: number;
    readonly memorySwapMaxBytes: number;
    readonly outerDeadlineMs: number;
    readonly runtimeMaxSeconds: number;
    readonly tasksMax: number;
    readonly workloadDeadlineMs: number;
}

export interface ResourceBudgetScenarioPolicy {
    readonly description: string;
    readonly limits: Readonly<ResourceBudgetLimits>;
}

const sharedSmallWorkloadLimits = Object.freeze({
    cpuQuotaPercent: 100,
    memorySwapMaxBytes: 0,
    outerDeadlineMs: 75_000,
    runtimeMaxSeconds: 60,
    tasksMax: 64,
    workloadDeadlineMs: 50_000,
});

function frozenScenario(
    description: string,
    limits: ResourceBudgetLimits
): Readonly<ResourceBudgetScenarioPolicy> {
    return Object.freeze({ description, limits: Object.freeze(limits) });
}

const resourceBudgetScenarios = Object.freeze({
    "child-cancellation": frozenScenario(
        "Effect interruption and detached process-group cleanup",
        {
            ...sharedSmallWorkloadLimits,
            memoryHighBytes: 192 * mebibyte,
            memoryMaxBytes: 256 * mebibyte,
        }
    ),
    "complete-shutdown": frozenScenario(
        "Two-generation complete shutdown and WAL recovery",
        {
            ...sharedSmallWorkloadLimits,
            memoryHighBytes: 256 * mebibyte,
            memoryMaxBytes: 384 * mebibyte,
        }
    ),
    "frontend-build": frozenScenario(
        "Production frontend build with hashes and compression",
        {
            cpuQuotaPercent: 200,
            memoryHighBytes: 768 * mebibyte,
            memoryMaxBytes: 1024 * mebibyte,
            memorySwapMaxBytes: 0,
            outerDeadlineMs: 195_000,
            runtimeMaxSeconds: 180,
            tasksMax: 96,
            workloadDeadlineMs: 165_000,
        }
    ),
    "representative-tests": frozenScenario("Bounded representative runtime scenarios", {
        cpuQuotaPercent: 200,
        memoryHighBytes: 768 * mebibyte,
        memoryMaxBytes: 1024 * mebibyte,
        memorySwapMaxBytes: 0,
        outerDeadlineMs: 195_000,
        runtimeMaxSeconds: 180,
        tasksMax: 96,
        workloadDeadlineMs: 165_000,
    }),
    "sqlite-outbox": frozenScenario(
        "Multi-process SQLite outbox, crash recovery, and restore",
        {
            ...sharedSmallWorkloadLimits,
            memoryHighBytes: 256 * mebibyte,
            memoryMaxBytes: 384 * mebibyte,
        }
    ),
} satisfies Record<ResourceBudgetScenarioId, ResourceBudgetScenarioPolicy>);

/** Reviewed host-measurement caps. CI validates policy mechanics without timing gates. */
export const resourceBudgetPolicy = Object.freeze({
    childOutputMaxBytes: 512 * 1024,
    formatVersion: 1 as const,
    launcherOutputMaxBytes: 64 * 1024,
    resultMaxBytes: 64 * 1024,
    scenarios: resourceBudgetScenarios,
});

const nonnegativeIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const positiveIntegerSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const memoryEventsSchema = v.strictObject({
    high: nonnegativeIntegerSchema,
    low: nonnegativeIntegerSchema,
    max: nonnegativeIntegerSchema,
    oom: nonnegativeIntegerSchema,
    oomGroupKill: nonnegativeIntegerSchema,
    oomKill: nonnegativeIntegerSchema,
});
const pressureSchema = v.strictObject({
    fullTotalMicros: nonnegativeIntegerSchema,
    someTotalMicros: nonnegativeIntegerSchema,
});
const resourceSnapshotSchema = v.strictObject({
    cpuNrThrottled: nonnegativeIntegerSchema,
    cpuPressure: pressureSchema,
    cpuThrottledMicros: nonnegativeIntegerSchema,
    cpuUsageMicros: nonnegativeIntegerSchema,
    memoryCurrentBytes: nonnegativeIntegerSchema,
    memoryEvents: memoryEventsSchema,
    memoryPressure: pressureSchema,
    pidsCurrent: nonnegativeIntegerSchema,
});
const resourceBudgetScenarioSchema = v.picklist(resourceBudgetScenarioIds);
const cgroupPathSchema = v.pipe(v.string(), v.startsWith("/"));
const bunRevisionSchema = v.pipe(v.string(), v.regex(/^[\da-f]{40}$/u));
const bunVersionSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
const signalCodeSchema = v.pipe(v.string(), v.maxLength(32));
const cgroupReportSchema = v.strictObject({
    final: resourceSnapshotSchema,
    finalProcessIds: v.array(positiveIntegerSchema),
    initial: resourceSnapshotSchema,
    memoryPeakBytes: nonnegativeIntegerSchema,
    path: cgroupPathSchema,
    pidsPeak: nonnegativeIntegerSchema,
});
const observedLimitsSchema = v.strictObject({
    cpuPeriodMicros: positiveIntegerSchema,
    cpuQuotaMicros: positiveIntegerSchema,
    memoryHighBytes: positiveIntegerSchema,
    memoryMaxBytes: positiveIntegerSchema,
    memorySwapMaxBytes: nonnegativeIntegerSchema,
    oomGroup: v.literal(true),
    pidsMax: positiveIntegerSchema,
});
const runtimeIdentitySchema = v.strictObject({
    bunRevision: bunRevisionSchema,
    bunVersion: bunVersionSchema,
});
const workloadResultSchema = v.strictObject({
    durationMs: nonnegativeIntegerSchema,
    exitCode: v.nullable(nonnegativeIntegerSchema),
    signalCode: v.nullable(signalCodeSchema),
    stderrBytes: nonnegativeIntegerSchema,
    stdoutBytes: nonnegativeIntegerSchema,
});

export const resourceBudgetUnitReportSchema = v.strictObject({
    cgroup: cgroupReportSchema,
    formatVersion: v.literal(resourceBudgetPolicy.formatVersion),
    limits: observedLimitsSchema,
    runtime: runtimeIdentitySchema,
    scenarioId: resourceBudgetScenarioSchema,
    unitName: v.pipe(v.string(), v.regex(resourceBudgetUnitNamePattern)),
    workload: workloadResultSchema,
    wrapperProcessId: positiveIntegerSchema,
});

export type ResourceBudgetUnitReport = v.InferOutput<
    typeof resourceBudgetUnitReportSchema
>;

export interface ResourceBudgetScenarioEvidence {
    readonly cgroupRemoved: boolean;
    readonly launcherExitCode: number;
    readonly report: ResourceBudgetUnitReport;
    readonly unitCollected: boolean;
}

export interface ResourceBudgetAssessment {
    readonly cpuPressureMicros: number;
    readonly cpuThrottledMicros: number;
    readonly cpuUsageMicros: number;
    readonly durationMs: number;
    readonly memoryHeadroomBytes: number;
    readonly memoryPeakBytes: number;
    readonly memoryPressureMicros: number;
    readonly pidsPeak: number;
    readonly scenarioId: ResourceBudgetScenarioId;
}

/**
 * Creates a unique, non-user-controlled transient service name.
 * @param scenarioId Reviewed workload identity.
 * @param identifier UUID-compatible random identifier.
 * @returns Valid transient service name without the `.service` suffix.
 */
export function createResourceBudgetUnitName(
    scenarioId: ResourceBudgetScenarioId,
    identifier: string = crypto.randomUUID()
): string {
    if (!resourceBudgetUnitIdentifierPattern.test(identifier)) {
        throw new TypeError("Resource-budget unit identifier is invalid");
    }
    return `mira-dashboard-resource-${scenarioId}-${identifier}`;
}

/**
 * Rejects unit names outside the exact transient-unit grammar.
 * @param unitName Candidate transient service name.
 */
export function assertResourceBudgetUnitName(unitName: string): void {
    if (!resourceBudgetUnitNamePattern.test(unitName)) {
        throw new TypeError("Resource-budget unit name is invalid");
    }
}

/**
 * Returns the exact app.slice cgroup created by the user systemd manager.
 * @param userId POSIX user-manager identity.
 * @param unitName Validated transient service name.
 * @returns Absolute unified cgroup path.
 */
export function expectedResourceBudgetCgroupPath(
    userId: number,
    unitName: string
): string {
    assertResourceBudgetUnitName(unitName);
    if (!Number.isSafeInteger(userId) || userId < 0) {
        throw new TypeError("Resource-budget user ID is invalid");
    }
    return path.posix.join(
        "/user.slice",
        `user-${userId}.slice`,
        `user@${userId}.service`,
        "app.slice",
        `${unitName}.service`
    );
}

/**
 * Parses the bounded unit report written by the capped child.
 * @param value Raw JSON report.
 * @returns Strict validated unit report.
 */
export function parseResourceBudgetUnitReport(value: string): ResourceBudgetUnitReport {
    let candidate: unknown;
    try {
        candidate = JSON.parse(value);
    } catch (error) {
        throw new Error("Resource-budget unit report is not valid JSON", {
            cause: error,
        });
    }
    return v.parse(resourceBudgetUnitReportSchema, candidate);
}

function delta(label: string, finalValue: number, initialValue: number): number {
    if (finalValue < initialValue) {
        throw new Error(`Resource-budget ${label} counter moved backwards`);
    }
    return finalValue - initialValue;
}

function assertObservedLimits(
    report: ResourceBudgetUnitReport,
    expected: Readonly<ResourceBudgetLimits>
): void {
    const observed = report.limits;
    if (
        observed.memoryHighBytes !== expected.memoryHighBytes ||
        observed.memoryMaxBytes !== expected.memoryMaxBytes ||
        observed.memorySwapMaxBytes !== expected.memorySwapMaxBytes ||
        observed.pidsMax !== expected.tasksMax ||
        observed.cpuQuotaMicros * 100 !==
            observed.cpuPeriodMicros * expected.cpuQuotaPercent ||
        !observed.oomGroup
    ) {
        throw new Error(
            `Resource-budget ${report.scenarioId} limits do not match policy`
        );
    }
}

/**
 * Applies deterministic acceptance invariants to one host-measured scenario.
 * CPU and pressure totals are retained as evidence, not flaky CI thresholds.
 * @param evidence Unit report plus post-run cleanup observations.
 * @param userId POSIX user-manager identity used to derive the exact cgroup.
 * @returns Non-gating host measurements for the accepted scenario.
 */
export function assessResourceBudgetEvidence(
    evidence: Readonly<ResourceBudgetScenarioEvidence>,
    userId: number
): Readonly<ResourceBudgetAssessment> {
    const { report } = evidence;
    const scenario = resourceBudgetPolicy.scenarios[report.scenarioId];
    assertObservedLimits(report, scenario.limits);

    const expectedCgroupPath = expectedResourceBudgetCgroupPath(userId, report.unitName);
    if (report.cgroup.path !== expectedCgroupPath) {
        throw new Error(
            `Resource-budget ${report.scenarioId} ran in ${report.cgroup.path}; expected ${expectedCgroupPath}`
        );
    }
    if (evidence.launcherExitCode !== 0 || report.workload.exitCode !== 0) {
        throw new Error(
            `Resource-budget ${report.scenarioId} workload did not exit zero`
        );
    }
    if (report.workload.signalCode !== null) {
        throw new Error(`Resource-budget ${report.scenarioId} workload was signalled`);
    }
    if (report.workload.durationMs > scenario.limits.workloadDeadlineMs) {
        throw new Error(`Resource-budget ${report.scenarioId} exceeded its deadline`);
    }
    if (
        report.workload.stdoutBytes > resourceBudgetPolicy.childOutputMaxBytes ||
        report.workload.stderrBytes > resourceBudgetPolicy.childOutputMaxBytes
    ) {
        throw new Error(`Resource-budget ${report.scenarioId} exceeded its output bound`);
    }
    if (report.cgroup.memoryPeakBytes >= scenario.limits.memoryHighBytes) {
        throw new Error(`Resource-budget ${report.scenarioId} crossed memory.high`);
    }
    if (report.cgroup.pidsPeak > scenario.limits.tasksMax) {
        throw new Error(`Resource-budget ${report.scenarioId} crossed TasksMax`);
    }
    if (
        report.cgroup.finalProcessIds.length !== 1 ||
        report.cgroup.finalProcessIds[0] !== report.wrapperProcessId
    ) {
        throw new Error(`Resource-budget ${report.scenarioId} leaked processes`);
    }
    if (!evidence.unitCollected) {
        throw new Error(`Resource-budget ${report.scenarioId} unit was not collected`);
    }
    if (!evidence.cgroupRemoved) {
        throw new Error(`Resource-budget ${report.scenarioId} cgroup was not removed`);
    }

    const initialEvents = report.cgroup.initial.memoryEvents;
    const finalEvents = report.cgroup.final.memoryEvents;
    for (const eventName of ["high", "max", "oom", "oomKill", "oomGroupKill"] as const) {
        if (
            delta(
                `memory.events ${eventName}`,
                finalEvents[eventName],
                initialEvents[eventName]
            ) !== 0
        ) {
            throw new Error(
                `Resource-budget ${report.scenarioId} observed memory.events ${eventName}`
            );
        }
    }

    return Object.freeze({
        cpuPressureMicros: delta(
            "cpu pressure",
            report.cgroup.final.cpuPressure.someTotalMicros,
            report.cgroup.initial.cpuPressure.someTotalMicros
        ),
        cpuThrottledMicros: delta(
            "CPU throttling",
            report.cgroup.final.cpuThrottledMicros,
            report.cgroup.initial.cpuThrottledMicros
        ),
        cpuUsageMicros: delta(
            "CPU usage",
            report.cgroup.final.cpuUsageMicros,
            report.cgroup.initial.cpuUsageMicros
        ),
        durationMs: report.workload.durationMs,
        memoryHeadroomBytes:
            scenario.limits.memoryHighBytes - report.cgroup.memoryPeakBytes,
        memoryPeakBytes: report.cgroup.memoryPeakBytes,
        memoryPressureMicros: delta(
            "memory pressure",
            report.cgroup.final.memoryPressure.someTotalMicros,
            report.cgroup.initial.memoryPressure.someTotalMicros
        ),
        pidsPeak: report.cgroup.pidsPeak,
        scenarioId: report.scenarioId,
    });
}
