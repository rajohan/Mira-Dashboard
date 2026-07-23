import { AsyncLocalStorage } from "node:async_hooks";

export const jobResourceClasses = [
    "interactive",
    "light",
    "network",
    "host-heavy",
    "exclusive",
] as const;

export type JobResourceClass = (typeof jobResourceClasses)[number];

interface JobResourceContext {
    resourceClass: JobResourceClass;
}

interface JobResourcePolicy {
    cpuWeight: number;
    ioWeight: number;
    memoryHigh: string;
    memoryMax: string;
    nice: number;
    priority: number;
    runtimeMaxSec: string;
    tasksMax: number;
}

const resourceContext = new AsyncLocalStorage<JobResourceContext>();

const resourcePolicies: Record<JobResourceClass, JobResourcePolicy> = {
    interactive: {
        cpuWeight: 60,
        ioWeight: 60,
        memoryHigh: "1G",
        memoryMax: "2G",
        nice: 5,
        priority: 100,
        runtimeMaxSec: "15m",
        tasksMax: 64,
    },
    light: {
        cpuWeight: 30,
        ioWeight: 40,
        memoryHigh: "768M",
        memoryMax: "1536M",
        nice: 10,
        priority: 60,
        runtimeMaxSec: "30m",
        tasksMax: 64,
    },
    network: {
        cpuWeight: 25,
        ioWeight: 40,
        memoryHigh: "1G",
        memoryMax: "2G",
        nice: 10,
        priority: 50,
        runtimeMaxSec: "30m",
        tasksMax: 64,
    },
    "host-heavy": {
        cpuWeight: 15,
        ioWeight: 15,
        memoryHigh: "2G",
        memoryMax: "4G",
        nice: 15,
        priority: 20,
        runtimeMaxSec: "7h",
        tasksMax: 128,
    },
    exclusive: {
        cpuWeight: 10,
        ioWeight: 10,
        memoryHigh: "3G",
        memoryMax: "5G",
        nice: 15,
        priority: 10,
        runtimeMaxSec: "7h",
        tasksMax: 192,
    },
};

export function isJobResourceClass(value: unknown): value is JobResourceClass {
    return (
        typeof value === "string" &&
        (jobResourceClasses as readonly string[]).includes(value)
    );
}

export function jobResourcePriority(resourceClass: JobResourceClass): number {
    return resourcePolicies[resourceClass].priority;
}

export function withJobResourceClass<T>(
    resourceClass: JobResourceClass,
    operation: () => T
): T {
    return resourceContext.run({ resourceClass }, operation);
}

function isSystemdRunExecutable(executable: string): boolean {
    return executable === "systemd-run" || executable.endsWith("/systemd-run");
}

/** Keeps the user-bus variables needed by a scoped launcher without widening child env. */
export function scopedJobProcessEnvironment(
    executable: string,
    environment: Record<string, string | undefined> | undefined,
    inheritedEnvironment: Record<string, string | undefined> = process.env
): Record<string, string | undefined> | undefined {
    if (environment === undefined || !isSystemdRunExecutable(executable)) {
        return environment;
    }
    const busAddress =
        environment.DBUS_SESSION_BUS_ADDRESS ||
        inheritedEnvironment.DBUS_SESSION_BUS_ADDRESS;
    const runtimeDirectory =
        environment.XDG_RUNTIME_DIR || inheritedEnvironment.XDG_RUNTIME_DIR;
    return {
        ...environment,
        ...(busAddress && { DBUS_SESSION_BUS_ADDRESS: busAddress }),
        ...(runtimeDirectory && { XDG_RUNTIME_DIR: runtimeDirectory }),
    };
}

function scopeOwnerProperties(environment: Record<string, string | undefined>): string[] {
    const owner = environment.MIRA_DASHBOARD_JOB_SCOPE_OWNER?.trim();
    if (!owner || !/^[A-Za-z0-9_.@-]+\.service$/u.test(owner)) return [];
    return ["--property", `BindsTo=${owner}`, "--property", `After=${owner}`];
}

/** Wraps child commands in a constrained transient scope while a worker action runs. */
export function scopedJobProcessCommand(
    executable: string,
    arguments_: readonly string[],
    environment: Record<string, string | undefined> = process.env
): { arguments: string[]; executable: string } {
    const context = resourceContext.getStore();
    if (
        !context ||
        isSystemdRunExecutable(executable) ||
        environment.MIRA_DASHBOARD_ENABLE_JOB_SCOPES !== "1"
    ) {
        return { arguments: [...arguments_], executable };
    }

    const policy = resourcePolicies[context.resourceClass];
    return {
        executable: "systemd-run",
        arguments: [
            "--user",
            "--scope",
            "--expand-environment=no",
            "--quiet",
            "--collect",
            `--nice=${policy.nice}`,
            "--property",
            `CPUWeight=${policy.cpuWeight}`,
            "--property",
            `IOWeight=${policy.ioWeight}`,
            "--property",
            `MemoryHigh=${policy.memoryHigh}`,
            "--property",
            `MemoryMax=${policy.memoryMax}`,
            "--property",
            `TasksMax=${policy.tasksMax}`,
            "--property",
            "KillMode=control-group",
            "--property",
            "TimeoutStopSec=20s",
            "--property",
            `RuntimeMaxSec=${policy.runtimeMaxSec}`,
            ...scopeOwnerProperties(environment),
            "--",
            executable,
            ...arguments_,
        ],
    };
}
