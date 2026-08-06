import { secondsToMilliseconds } from "date-fns";
import * as v from "valibot";

import { healthReadinessPath } from "../../src/contracts/system.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import { installPublishedProductionSystemdUnits } from "./installProductionSystemdUnits.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";
import type { ProductionServiceController } from "./productionReleaseActivation.ts";
import type { PublishedProductionRelease } from "./productionReleasePublication.ts";
import type { InstalledProductionRuntime } from "./productionRuntime.ts";
import { pointProductionProcessesAtRelease } from "./productionRuntimePointers.ts";
import {
    executeSystemctlProcess,
    requireSuccessfulSystemctlProcess,
    type SystemctlExecutor,
} from "./systemctlProcess.ts";

const systemdServiceFailureMessage = "Production service control failed";
const readinessAttemptTimeoutMs = secondsToMilliseconds(2);
const readinessDeadlineMs = secondsToMilliseconds(30);
const readinessRetryMs = 250;
const webUnit = "mira-dashboard-web.service";
const workerUnit = "mira-dashboard-worker.service";
const systemctlExecutableDefault = "/usr/bin/systemctl";
const loopbackReadinessUrlSchema = v.pipe(
    v.string(),
    v.url(),
    v.check((input) => {
        try {
            const url = new URL(input);
            return (
                url.protocol === "http:" &&
                (url.hostname === "127.0.0.1" || url.hostname === "[::1]") &&
                url.pathname === healthReadinessPath &&
                url.search.length === 0 &&
                url.hash.length === 0 &&
                url.username.length === 0 &&
                url.password.length === 0
            );
        } catch {
            return false;
        }
    }, systemdServiceFailureMessage)
);

export type { SystemctlProcessResult } from "./systemctlProcess.ts";

/** Explicit systemd and readiness boundaries for one project-local deployment. */
export interface SystemdProductionServiceOptions {
    readonly execute?: SystemctlExecutor;
    readonly fetch?: (request: Request) => Promise<Response>;
    readonly installUnits?: typeof installPublishedProductionSystemdUnits;
    readonly readinessUrl: string;
    readonly systemctlExecutable?: string;
}

function serviceFailure(): Error {
    return new Error(systemdServiceFailureMessage);
}

function validateExecutable(executable: string): void {
    if (
        !executable.startsWith("/") ||
        executable.includes("\0") ||
        executable.length > 4096
    ) {
        throw serviceFailure();
    }
}

async function requireSystemctlSuccess(
    execute: SystemctlExecutor,
    executable: string,
    arguments_: readonly string[]
): Promise<void> {
    try {
        await requireSuccessfulSystemctlProcess(execute, executable, arguments_);
    } catch {
        throw serviceFailure();
    }
}

async function stopUnits(
    execute: NonNullable<SystemdProductionServiceOptions["execute"]>,
    executable: string
): Promise<void> {
    let failed = false;
    try {
        await requireSystemctlSuccess(execute, executable, ["--user", "stop", webUnit]);
    } catch {
        failed = true;
    }
    try {
        await requireSystemctlSuccess(execute, executable, [
            "--user",
            "stop",
            workerUnit,
        ]);
    } catch {
        failed = true;
    }
    if (failed) throw serviceFailure();
}

async function probeReadiness(
    fetch_: NonNullable<SystemdProductionServiceOptions["fetch"]>,
    readinessUrl: string
): Promise<boolean> {
    try {
        const response = await fetch_(
            new Request(readinessUrl, {
                cache: "no-store",
                method: "HEAD",
                signal: AbortSignal.timeout(readinessAttemptTimeoutMs),
            })
        );
        return response.status === 200;
    } catch {
        return false;
    }
}

async function awaitReadiness(
    fetch_: NonNullable<SystemdProductionServiceOptions["fetch"]>,
    readinessUrl: string
): Promise<void> {
    const deadline = Date.now() + readinessDeadlineMs;
    while (Date.now() < deadline) {
        if (await probeReadiness(fetch_, readinessUrl)) return;
        await Bun.sleep(readinessRetryMs);
    }
    throw serviceFailure();
}

/**
 * Creates the idempotent user-systemd adapter used by crash-safe activation.
 * Release/runtime pointers are changed only while the activation orchestrator has stopped writers.
 * @param lease Active deployment lease captured by the controller.
 * @param paths Exact project-local production paths.
 * @param options Loopback readiness URL plus injectable process boundaries.
 * @returns Service controller for worker-first start, web-first stop, and readiness proof.
 */
export function createSystemdProductionServiceController(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    options: SystemdProductionServiceOptions
): ProductionServiceController {
    const readinessUrl = v.parse(loopbackReadinessUrlSchema, options.readinessUrl);
    const executable = options.systemctlExecutable ?? systemctlExecutableDefault;
    validateExecutable(executable);
    const execute = options.execute ?? executeSystemctlProcess;
    const fetch_ = options.fetch ?? fetch;
    const installUnits = options.installUnits ?? installPublishedProductionSystemdUnits;

    return Object.freeze({
        prepare(release: PublishedProductionRelease): Promise<void> {
            return installUnits(lease, paths, release);
        },
        async start(
            release: PublishedProductionRelease,
            runtime: InstalledProductionRuntime
        ): Promise<void> {
            await pointProductionProcessesAtRelease(lease, paths, release, runtime);
            await requireSystemctlSuccess(execute, executable, [
                "--user",
                "restart",
                workerUnit,
            ]);
            await requireSystemctlSuccess(execute, executable, [
                "--user",
                "restart",
                webUnit,
            ]);
        },
        stop: () => stopUnits(execute, executable),
        async verifyReady(): Promise<void> {
            await requireSystemctlSuccess(execute, executable, [
                "--user",
                "is-active",
                "--quiet",
                workerUnit,
                webUnit,
            ]);
            await awaitReadiness(fetch_, readinessUrl);
        },
    });
}
