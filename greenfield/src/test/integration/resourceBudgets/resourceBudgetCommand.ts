import path from "node:path";

import {
    assertResourceBudgetUnitName,
    resourceBudgetPolicy,
    type ResourceBudgetScenarioId,
} from "./resourceBudgetPolicy.ts";

const launcherEnvironmentNames = [
    "DBUS_SESSION_BUS_ADDRESS",
    "HOME",
    "LANG",
    "PATH",
    "XDG_RUNTIME_DIR",
] as const;

export interface ResourceBudgetCommandOptions {
    readonly bunExecutable: string;
    readonly childEntrypoint: string;
    readonly envExecutable: string;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly repositoryRoot: string;
    readonly resultPath: string;
    readonly scenarioId: ResourceBudgetScenarioId;
    readonly systemctlExecutable: string;
    readonly systemdRunExecutable: string;
    readonly temporaryDirectory: string;
    readonly unitName: string;
}

export interface ResourceBudgetLauncherCommand {
    readonly argv: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
    readonly resultPath: string;
    readonly scenarioId: ResourceBudgetScenarioId;
    readonly systemctlExecutable: string;
    readonly unitName: string;
}

export interface ResourceBudgetWorkloadCommand {
    readonly argv: readonly string[];
    readonly environment: Readonly<Record<string, string>>;
}

function assertAbsolutePath(label: string, value: string): void {
    if (!path.isAbsolute(value) || value.includes("\0")) {
        throw new TypeError(`${label} must be an absolute path`);
    }
}

function sanitizedEnvironment(
    source: Readonly<Record<string, string | undefined>>,
    temporaryDirectory: string
): Readonly<Record<string, string>> {
    const home = source.HOME;
    if (!home) throw new Error("HOME is required for resource-budget evidence");
    return Object.freeze({
        CI: "1",
        FORCE_COLOR: "0",
        HOME: home,
        LANG: "C.UTF-8",
        NODE_ENV: "test",
        NO_COLOR: "1",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        TMPDIR: temporaryDirectory,
    });
}

function childEnvironmentArguments(
    environment: Readonly<Record<string, string>>
): string[] {
    return Object.entries(environment)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}=${value}`);
}

/**
 * Builds the exact argv-only command executed by the capped wrapper.
 * @param scenarioId Reviewed workload identity.
 * @param repositoryRoot Absolute repository root.
 * @param bunExecutable Absolute Bun executable.
 * @param environment Sanitized workload environment.
 * @returns Immutable argv-only workload command.
 */
export function buildResourceBudgetWorkloadCommand(
    scenarioId: ResourceBudgetScenarioId,
    repositoryRoot: string,
    bunExecutable: string,
    environment: Readonly<Record<string, string>>
): ResourceBudgetWorkloadCommand {
    assertAbsolutePath("Repository root", repositoryRoot);
    assertAbsolutePath("Bun executable", bunExecutable);
    const integrationTest = (...segments: string[]) =>
        path.join(repositoryRoot, "src", "test", "integration", ...segments);
    const testFiles = [
        integrationTest("runtime", "runtimeCandidate.test.ts"),
        integrationTest("resources", "cgroupV2.test.ts"),
        integrationTest("build", "frontendBuildScenario.test.ts"),
        integrationTest("openclaw", "sourceAudit.test.ts"),
    ];
    const scenarioArguments: Record<ResourceBudgetScenarioId, readonly string[]> = {
        "child-cancellation": [
            integrationTest("resourceBudgets", "runSafeChildCancellationEvidence.ts"),
        ],
        "complete-shutdown": [
            integrationTest("shutdown", "runCompleteShutdownEvidence.ts"),
        ],
        "frontend-build": [integrationTest("build", "runFrontendBuildEvidence.ts")],
        "representative-tests": ["test", ...testFiles],
        "sqlite-outbox": [integrationTest("outbox", "runSqliteOutboxEvidence.ts"), "1"],
    };
    return Object.freeze({
        argv: Object.freeze([bunExecutable, ...scenarioArguments[scenarioId]]),
        environment,
    });
}

/**
 * Builds one transient user-systemd command with explicit cgroup v2 limits.
 * @param options Resolved paths, unit identity, and sanitized host environment.
 * @returns Immutable launcher command.
 */
export function buildResourceBudgetLauncherCommand(
    options: ResourceBudgetCommandOptions
): ResourceBudgetLauncherCommand {
    for (const [label, value] of [
        ["Bun executable", options.bunExecutable],
        ["Child entrypoint", options.childEntrypoint],
        ["env executable", options.envExecutable],
        ["Repository root", options.repositoryRoot],
        ["Result path", options.resultPath],
        ["systemctl executable", options.systemctlExecutable],
        ["systemd-run executable", options.systemdRunExecutable],
        ["Temporary directory", options.temporaryDirectory],
    ] as const) {
        assertAbsolutePath(label, value);
    }
    assertResourceBudgetUnitName(options.unitName);

    const launcherEnvironment = Object.freeze(
        Object.fromEntries(
            launcherEnvironmentNames.flatMap((name) => {
                const value = options.environment[name];
                return value === undefined ? [] : [[name, value]];
            })
        )
    );
    const workloadEnvironment = sanitizedEnvironment(
        options.environment,
        options.temporaryDirectory
    );
    const limits = resourceBudgetPolicy.scenarios[options.scenarioId].limits;
    const argv = Object.freeze([
        options.systemdRunExecutable,
        "--user",
        "--wait",
        "--pipe",
        "--collect",
        "--quiet",
        `--unit=${options.unitName}`,
        "--slice=app.slice",
        "--expand-environment=no",
        "--nice=10",
        `--working-directory=${options.repositoryRoot}`,
        "--property=MemoryAccounting=yes",
        "--property=CPUAccounting=yes",
        "--property=TasksAccounting=yes",
        `--property=MemoryHigh=${limits.memoryHighBytes}`,
        `--property=MemoryMax=${limits.memoryMaxBytes}`,
        `--property=MemorySwapMax=${limits.memorySwapMaxBytes}`,
        `--property=TasksMax=${limits.tasksMax}`,
        `--property=CPUQuota=${limits.cpuQuotaPercent}%`,
        `--property=RuntimeMaxSec=${limits.runtimeMaxSeconds}s`,
        "--property=OOMPolicy=kill",
        "--property=KillMode=control-group",
        "--property=TimeoutStopSec=5s",
        options.envExecutable,
        "-i",
        ...childEnvironmentArguments(workloadEnvironment),
        options.bunExecutable,
        options.childEntrypoint,
        `--repository=${options.repositoryRoot}`,
        `--result=${options.resultPath}`,
        `--scenario=${options.scenarioId}`,
        `--unit=${options.unitName}`,
    ]);

    return Object.freeze({
        argv,
        environment: launcherEnvironment,
        resultPath: options.resultPath,
        scenarioId: options.scenarioId,
        systemctlExecutable: options.systemctlExecutable,
        unitName: options.unitName,
    });
}
