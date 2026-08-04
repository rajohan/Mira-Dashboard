import path from "node:path";

import { sseMemoryQualificationPolicy } from "./resourcePolicy.ts";
import { assertSseMemoryUnitName } from "./unitIdentity.ts";

const launcherEnvironmentNames = [
    "DBUS_SESSION_BUS_ADDRESS",
    "HOME",
    "LANG",
    "PATH",
    "XDG_RUNTIME_DIR",
] as const;
/** Fixed uncapped-parent process limits used around the capped child. */
export const systemdLauncherProcessPolicy = Object.freeze({
    launcherOutputMaxBytes: 64 * 1024,
    systemctlOutputMaxBytes: 16 * 1024,
    systemctlTimeoutMs: 2000,
});
export { createSseMemoryUnitName } from "./unitIdentity.ts";

/** Absolute executables and paths used by one transient qualification unit. */
export interface SystemdLauncherOptions {
    bunExecutable: string;
    childEntrypoint: string;
    environment: Readonly<Record<string, string | undefined>>;
    envExecutable: string;
    repositoryRoot: string;
    resultPath: string;
    systemctlExecutable: string;
    systemdRunExecutable: string;
    unitName: string;
}

/** Fully resolved command with the only host environment values it may inherit. */
export interface SystemdLauncherCommand {
    argv: readonly string[];
    environment: Readonly<Record<string, string>>;
    systemctlExecutable: string;
    unitName: string;
}

/** Result returned after the transient unit exits. */
export interface SystemdLauncherResult {
    exitCode: number;
    stderr: string;
    stdout: string;
}

/** Reason a signal-terminated launcher stopped. */
export type SystemdLauncherTermination = Readonly<{
    kind: "deadline" | "signal";
    signalCode: NodeJS.Signals;
}>;

/** Complete bounded subprocess specification consumed by `Bun.spawn`. */
export interface SystemdSubprocessSpecification {
    argv: readonly string[];
    options: Readonly<{
        env: Readonly<Record<string, string>>;
        killSignal: "SIGKILL";
        maxBuffer: number;
        stderr: "pipe";
        stdout: "pipe";
        timeout: number;
    }>;
}

/** Injectable bounded systemctl boundary used by deterministic shutdown tests. */
export type SystemctlRunner = (
    command: SystemdLauncherCommand,
    arguments_: readonly string[]
) => Promise<SystemdLauncherResult>;

/** Load and activity state returned by `systemctl show`. */
export interface SystemdUnitState {
    activeState: string;
    loadState: string;
}

function assertAbsolutePath(label: string, value: string): void {
    if (!path.isAbsolute(value) || value.includes("\0")) {
        throw new TypeError(`${label} must be an absolute path`);
    }
}

function childEnvironment(options: SystemdLauncherOptions): readonly string[] {
    const home = options.environment.HOME;
    if (!home) {
        throw new Error("HOME is required to launch the SSE memory qualification");
    }
    return [
        "-i",
        `HOME=${home}`,
        "LANG=C.UTF-8",
        "NODE_ENV=test",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "TMPDIR=/tmp",
        options.bunExecutable,
        options.childEntrypoint,
        "--child",
        `--result=${options.resultPath}`,
        `--unit=${options.unitName}`,
    ];
}

/**
 * Builds the argv-only systemd launcher and its sanitised host environment.
 * @param options Resolved executables, paths, and unit identity.
 * @returns Immutable launcher command.
 */
export function buildSystemdLauncherCommand(
    options: SystemdLauncherOptions
): SystemdLauncherCommand {
    assertAbsolutePath("Bun executable", options.bunExecutable);
    assertAbsolutePath("Child entrypoint", options.childEntrypoint);
    assertAbsolutePath("env executable", options.envExecutable);
    assertAbsolutePath("Repository root", options.repositoryRoot);
    assertAbsolutePath("Result path", options.resultPath);
    assertAbsolutePath("systemctl executable", options.systemctlExecutable);
    assertAbsolutePath("systemd-run executable", options.systemdRunExecutable);
    assertSseMemoryUnitName(options.unitName);

    const environment = Object.fromEntries(
        launcherEnvironmentNames.flatMap((name) => {
            const value = options.environment[name];
            return value === undefined ? [] : [[name, value]];
        })
    );
    const cgroup = sseMemoryQualificationPolicy.cgroup;
    const argv = [
        options.systemdRunExecutable,
        "--user",
        "--wait",
        "--pipe",
        "--quiet",
        `--unit=${options.unitName}`,
        "--slice=app.slice",
        "--expand-environment=no",
        "--nice=10",
        `--working-directory=${options.repositoryRoot}`,
        "--property=MemoryAccounting=yes",
        "--property=CPUAccounting=yes",
        "--property=TasksAccounting=yes",
        `--property=MemoryHigh=${cgroup.memoryHighBytes}`,
        `--property=MemoryMax=${cgroup.memoryMaxBytes}`,
        `--property=MemorySwapMax=${cgroup.memorySwapMaxBytes}`,
        `--property=TasksMax=${cgroup.tasksMax}`,
        `--property=CPUQuota=${cgroup.cpuQuotaPercent}%`,
        `--property=RuntimeMaxSec=${cgroup.runtimeMaxSeconds}s`,
        `--property=OOMPolicy=${cgroup.oomPolicy}`,
        "--property=KillMode=control-group",
        "--property=TimeoutStopSec=5s",
        options.envExecutable,
        ...childEnvironment(options),
    ];

    return Object.freeze({
        argv: Object.freeze(argv),
        environment: Object.freeze(environment),
        systemctlExecutable: options.systemctlExecutable,
        unitName: options.unitName,
    });
}

/**
 * Parses the bounded key/value state returned by `systemctl show`.
 * @param value Raw `systemctl show` output.
 * @returns Exact load and active state pair.
 */
export function parseSystemdUnitState(value: string): SystemdUnitState {
    const properties = new Map<string, string>();
    for (const line of value.split(/\r?\n/u)) {
        if (line.length === 0) continue;
        const separator = line.indexOf("=");
        if (separator <= 0) {
            throw new Error("Invalid systemd unit state output");
        }
        const name = line.slice(0, separator);
        if (properties.has(name)) {
            throw new Error(`Duplicate systemd unit state property ${name}`);
        }
        properties.set(name, line.slice(separator + 1));
    }
    const activeState = properties.get("ActiveState");
    const loadState = properties.get("LoadState");
    if (activeState === undefined || loadState === undefined || properties.size !== 2) {
        throw new Error("Incomplete systemd unit state output");
    }
    return { activeState, loadState };
}

/**
 * Builds the bounded subprocess specification for one `systemctl` operation.
 * @param command Sanitised launcher command and systemctl identity.
 * @param arguments_ Exact systemctl operation arguments.
 * @returns Immutable argv and process limits used by `Bun.spawn`.
 */
export function buildSystemctlSubprocessSpecification(
    command: SystemdLauncherCommand,
    arguments_: readonly string[]
): SystemdSubprocessSpecification {
    return Object.freeze({
        argv: Object.freeze([
            command.systemctlExecutable,
            "--user",
            "--no-ask-password",
            "--no-pager",
            ...arguments_,
        ]),
        options: Object.freeze({
            env: command.environment,
            killSignal: "SIGKILL" as const,
            maxBuffer: systemdLauncherProcessPolicy.systemctlOutputMaxBytes,
            stderr: "pipe" as const,
            stdout: "pipe" as const,
            timeout: systemdLauncherProcessPolicy.systemctlTimeoutMs,
        }),
    });
}

/**
 * Builds the bounded subprocess specification for the outer `systemd-run` launcher.
 * @param command Sanitised launcher command.
 * @returns Immutable argv and process limits used by `Bun.spawn`.
 */
export function buildSystemdRunSubprocessSpecification(
    command: SystemdLauncherCommand
): SystemdSubprocessSpecification {
    return Object.freeze({
        argv: command.argv,
        options: Object.freeze({
            env: command.environment,
            killSignal: "SIGKILL" as const,
            maxBuffer: systemdLauncherProcessPolicy.launcherOutputMaxBytes,
            stderr: "pipe" as const,
            stdout: "pipe" as const,
            timeout: sseMemoryQualificationPolicy.cgroup.outerDeadlineMs,
        }),
    });
}

/**
 * Classifies a signal-terminated launcher without conflating every `SIGKILL` with timeout.
 * @param signalCode Signal observed after the launcher exits.
 * @param elapsedMs Monotonic launcher runtime in milliseconds.
 * @param deadlineMs Configured outer launcher deadline in milliseconds.
 * @returns The signal termination reason, or `undefined` for a normal exit.
 */
export function classifySystemdLauncherTermination(
    signalCode: NodeJS.Signals | null,
    elapsedMs: number,
    deadlineMs: number
): SystemdLauncherTermination | undefined {
    if (signalCode === null) return undefined;
    return Object.freeze({
        kind: elapsedMs >= deadlineMs ? "deadline" : "signal",
        signalCode,
    });
}

async function systemctl(
    command: SystemdLauncherCommand,
    arguments_: readonly string[]
): Promise<SystemdLauncherResult> {
    const specification = buildSystemctlSubprocessSpecification(command, arguments_);
    const process_ = Bun.spawn([...specification.argv], specification.options);
    const [exitCode, stderr, stdout] = await Promise.all([
        process_.exited,
        new Response(process_.stderr).text(),
        new Response(process_.stdout).text(),
    ]);
    return { exitCode, stderr, stdout };
}

async function inspectUnitState(
    command: SystemdLauncherCommand,
    runSystemctl: SystemctlRunner = systemctl
): Promise<SystemdUnitState> {
    const result = await runSystemctl(command, [
        "show",
        `${command.unitName}.service`,
        "--property=LoadState",
        "--property=ActiveState",
    ]);
    if (result.exitCode !== 0) {
        throw new Error(
            `Could not inspect transient unit state: ${result.stderr.trim() || `exit ${result.exitCode}`}`
        );
    }
    return parseSystemdUnitState(result.stdout);
}

function isTerminalUnitState(state: SystemdUnitState): boolean {
    return (
        state.loadState === "not-found" ||
        state.activeState === "inactive" ||
        state.activeState === "failed"
    );
}

/**
 * Stops the complete transient cgroup and verifies a terminal unit state.
 * @param command Sanitised launcher command and unit identity.
 * @param runSystemctl Bounded systemctl boundary, injectable for tests.
 */
export async function ensureTransientUnitStopped(
    command: SystemdLauncherCommand,
    runSystemctl: SystemctlRunner = systemctl
): Promise<void> {
    const unit = `${command.unitName}.service`;
    const gracefulStop = await runSystemctl(command, ["stop", unit]);
    let state = await inspectUnitState(command, runSystemctl);
    if (
        state.loadState === "not-found" ||
        (gracefulStop.exitCode === 0 && isTerminalUnitState(state))
    ) {
        return;
    }

    const forcedKill = await runSystemctl(command, [
        "kill",
        "--kill-whom=all",
        "--signal=SIGKILL",
        unit,
    ]);
    const forcedStop = await runSystemctl(command, ["stop", unit]);
    state = await inspectUnitState(command, runSystemctl);
    if (
        state.loadState === "not-found" ||
        ((forcedKill.exitCode === 0 || forcedStop.exitCode === 0) &&
            isTerminalUnitState(state))
    ) {
        return;
    }
    throw new Error(
        `Transient unit did not stop: load=${state.loadState}, active=${state.activeState}`
    );
}

async function resetFailedUnit(command: SystemdLauncherCommand): Promise<void> {
    await systemctl(command, ["reset-failed", `${command.unitName}.service`]);
}

async function postMortem(command: SystemdLauncherCommand): Promise<string> {
    const result = await systemctl(command, [
        "show",
        `${command.unitName}.service`,
        "--property=Result,ExecMainCode,ExecMainStatus,MemoryPeak",
    ]);
    return result.exitCode === 0 ? result.stdout.trim() : result.stderr.trim();
}

async function bestEffortPostMortem(command: SystemdLauncherCommand): Promise<string> {
    try {
        return await postMortem(command);
    } catch (error) {
        const diagnostic =
            error instanceof Error
                ? Bun.inspect(error, { colors: false })
                : "unknown post-mortem failure";
        return `post-mortem unavailable: ${diagnostic}`;
    }
}

/**
 * Combines a launcher failure with its bounded child and systemd diagnostics.
 * @param summary Primary termination reason.
 * @param stdout Captured bounded launcher standard output.
 * @param stderr Captured bounded launcher standard error.
 * @param diagnostic Best-effort bounded systemd post-mortem.
 * @returns One actionable failure message.
 */
export function formatSystemdLauncherFailure(
    summary: string,
    stdout: string,
    stderr: string,
    diagnostic: string
): string {
    const sections = [
        summary,
        stdout.trim().length > 0 ? `launcher stdout:\n${stdout.trim()}` : "",
        stderr.trim().length > 0 ? `launcher stderr:\n${stderr.trim()}` : "",
        diagnostic.trim().length > 0 ? `systemd post-mortem:\n${diagnostic.trim()}` : "",
    ];
    return sections.filter((section) => section.length > 0).join("\n");
}

/**
 * Runs a qualification child inside the reviewed transient cgroup.
 * @param command Sanitised systemd launcher command.
 * @returns Captured launcher output and exit status.
 * @throws {Error} When the launcher exceeds its deadline, is signal-terminated, or cleanup fails.
 */
export async function runSystemdQualification(
    command: SystemdLauncherCommand
): Promise<SystemdLauncherResult> {
    const specification = buildSystemdRunSubprocessSpecification(command);
    const startedAt = performance.now();
    const process_ = Bun.spawn([...specification.argv], specification.options);
    const stderr = new Response(process_.stderr).text();
    const stdout = new Response(process_.stdout).text();
    let operationError: unknown;
    let result: SystemdLauncherResult | undefined;
    try {
        const exitCode = await process_.exited;
        const elapsedMs = performance.now() - startedAt;
        const [stderrText, stdoutText] = await Promise.all([stderr, stdout]);
        const termination = classifySystemdLauncherTermination(
            process_.signalCode,
            elapsedMs,
            specification.options.timeout
        );
        if (termination?.kind === "deadline") {
            const diagnostic = await bestEffortPostMortem(command);
            throw new Error(
                formatSystemdLauncherFailure(
                    `SSE memory qualification launcher exceeded its ${specification.options.timeout} ms outer deadline and was terminated by ${termination.signalCode}`,
                    stdoutText,
                    stderrText,
                    diagnostic
                )
            );
        }
        if (termination !== undefined) {
            const diagnostic = await bestEffortPostMortem(command);
            throw new Error(
                formatSystemdLauncherFailure(
                    `SSE memory qualification launcher was terminated by ${termination.signalCode} before its outer deadline; the output bound or an external signal may have stopped it`,
                    stdoutText,
                    stderrText,
                    diagnostic
                )
            );
        }
        if (exitCode === 0) {
            result = {
                exitCode,
                stderr: stderrText,
                stdout: stdoutText,
            };
        } else {
            const diagnostic = await bestEffortPostMortem(command);
            result = {
                exitCode,
                stderr: [stderrText.trim(), diagnostic]
                    .filter((value) => value.length > 0)
                    .join("\n"),
                stdout: stdoutText,
            };
        }
    } catch (error) {
        operationError = error;
    }

    let cleanupError: unknown;
    try {
        await ensureTransientUnitStopped(command);
    } catch (error) {
        cleanupError = error;
    }
    await resetFailedUnit(command).catch(() => {});

    if (operationError !== undefined && cleanupError !== undefined) {
        throw new AggregateError(
            [operationError, cleanupError],
            "SSE memory qualification and transient-unit cleanup failed"
        );
    }
    if (operationError !== undefined) {
        throw operationError instanceof Error
            ? operationError
            : new Error("SSE memory qualification failed", { cause: operationError });
    }
    if (cleanupError !== undefined) {
        throw cleanupError instanceof Error
            ? cleanupError
            : new Error("Transient-unit cleanup failed", { cause: cleanupError });
    }
    if (result === undefined) {
        throw new Error("SSE memory qualification returned no launcher result");
    }
    return result;
}
