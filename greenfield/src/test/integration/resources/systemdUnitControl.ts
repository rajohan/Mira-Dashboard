import {
    buildSystemctlSubprocessSpecification,
    type SystemdLauncherCommand,
    type SystemdLauncherResult,
} from "./systemdLauncherCommand.ts";

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

/** Clears a failed transient unit after its state and diagnostics have been recovered. */
export async function resetFailedTransientUnit(
    command: SystemdLauncherCommand
): Promise<void> {
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

/**
 * Returns bounded unit diagnostics without replacing the primary launcher failure.
 * @param command Sanitised launcher command and unit identity.
 * @returns Bounded systemd state or an explanation that diagnostics were unavailable.
 */
export async function bestEffortSystemdPostMortem(
    command: SystemdLauncherCommand
): Promise<string> {
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
